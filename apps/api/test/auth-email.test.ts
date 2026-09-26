import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { parseEnv } from "../src/env.js";
import { UserModel } from "../src/models/user.js";
import { BrevoEmailSender, otpEmail } from "../src/services/email.js";
import { RecordingEmailSender, buildTestApp, cookieFrom, useTestDatabase } from "./helpers.js";

const db = useTestDatabase();

function setup() {
  const email = new RecordingEmailSender();
  return { email, app: buildTestApp({ emailSender: email }) };
}

describe("email sign-in codes", () => {
  it("emails a code and signs the student in (account created once)", async () => {
    const { app, email } = setup();
    const send = await request(app)
      .post("/api/auth/email/send")
      .send({ email: " Priya@Example.com " })
      .expect(200);
    expect(send.body).toEqual({ expiresInSec: 300, resendInSec: 30 });
    expect(email.sent[0]?.subject).toMatch(/^\d{6} is your mockprep sign-in code$/);

    const code = email.codes.get("priya@example.com");
    const res = await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "priya@example.com", code })
      .expect(200);
    expect(res.body.user).toMatchObject({
      role: "student",
      email: "priya@example.com",
      phone: null,
      onboarded: false,
    });
    expect(cookieFrom(res, "mp_rt")).toBeDefined();

    await db.redis().del("otp:cooldown:email:priya@example.com");
    await request(app)
      .post("/api/auth/email/send")
      .send({ email: "priya@example.com" })
      .expect(200);
    const again = await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "priya@example.com", code: email.codes.get("priya@example.com") })
      .expect(200);
    expect(again.body.user.id).toBe(res.body.user.id);
    expect(await UserModel.countDocuments({ email: "priya@example.com" })).toBe(1);
  });

  it("uses the same account as Google sign-in with that email", async () => {
    const { app, email } = setup();
    const google = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google:sub-1:ravi@example.com" })
      .expect(200);
    await request(app).post("/api/auth/email/send").send({ email: "ravi@example.com" }).expect(200);
    const viaEmail = await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "ravi@example.com", code: email.codes.get("ravi@example.com") })
      .expect(200);
    expect(viaEmail.body.user.id).toBe(google.body.user.id);
  });

  it("rejects wrong and reused codes, and refuses admin emails", async () => {
    const { app, email } = setup();
    await request(app).post("/api/auth/email/send").send({ email: "a@example.com" }).expect(200);
    const code = email.codes.get("a@example.com") ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    const bad = await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "a@example.com", code: wrong })
      .expect(400);
    expect(bad.body.details).toEqual({ attemptsLeft: 4 });
    await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "a@example.com", code })
      .expect(200);
    await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "a@example.com", code })
      .expect(400);

    await UserModel.create({ role: "content", email: "staff@example.com" });
    await request(app)
      .post("/api/auth/email/send")
      .send({ email: "staff@example.com" })
      .expect(200);
    await request(app)
      .post("/api/auth/email/verify")
      .send({ email: "staff@example.com", code: email.codes.get("staff@example.com") })
      .expect(403);
  });

  it("rate-limits per address and validates input", async () => {
    const { app } = setup();
    await request(app).post("/api/auth/email/send").send({ email: "b@example.com" }).expect(200);
    await request(app).post("/api/auth/email/send").send({ email: "b@example.com" }).expect(429);
    for (let i = 0; i < 4; i++) {
      await db.redis().del("otp:cooldown:email:b@example.com");
      await request(app).post("/api/auth/email/send").send({ email: "b@example.com" }).expect(200);
    }
    await db.redis().del("otp:cooldown:email:b@example.com");
    const limited = await request(app)
      .post("/api/auth/email/send")
      .send({ email: "b@example.com" })
      .expect(429);
    expect(limited.body.error).toMatch(/this email address/);
    await request(app).post("/api/auth/email/send").send({ email: "nope" }).expect(400);
  });

  it("returns 502 and frees the cooldown when sending fails", async () => {
    const failing = { name: "failing", send: () => Promise.reject(new Error("smtp down")) };
    const app = buildTestApp({ emailSender: failing });
    await request(app).post("/api/auth/email/send").send({ email: "c@example.com" }).expect(502);
    expect(await db.redis().exists("otp:cooldown:email:c@example.com")).toBe(0);
  });
});

describe("Brevo sender", () => {
  it("posts the message to Brevo's API", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ messageId: "x" }), { status: 201 })),
    );
    const brevo = new BrevoEmailSender("key-123", "no-reply@example.com", "mockprep", fetchMock);
    await brevo.send({ to: "s@example.com", ...otpEmail("123456", 5) });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key-123");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      sender: { email: "no-reply@example.com", name: "mockprep" },
      to: [{ email: "s@example.com" }],
    });
    expect(body.textContent).toContain("123456");
  });

  it("throws on API errors", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("unauthorized", { status: 401 })));
    const brevo = new BrevoEmailSender("bad", "no-reply@example.com", "mockprep", fetchMock);
    await expect(brevo.send({ to: "s@example.com", ...otpEmail("1", 5) })).rejects.toThrow(/401/);
  });

  it("requires a key and sender when EMAIL_PROVIDER=brevo", () => {
    const base = {
      MONGODB_URI: "mongodb://localhost/x",
      REDIS_URL: "redis://localhost",
      CORS_ORIGINS: "http://localhost:3000",
      JWT_SECRET: "x".repeat(32),
      TOTP_ENCRYPTION_KEY: "y".repeat(32),
    };
    expect(() => parseEnv({ ...base, EMAIL_PROVIDER: "brevo" })).toThrow(
      /BREVO_API_KEY[\s\S]*EMAIL_FROM/,
    );
    expect(
      parseEnv({
        ...base,
        EMAIL_PROVIDER: "brevo",
        BREVO_API_KEY: "k",
        EMAIL_FROM: "me@example.com",
      }).EMAIL_FROM_NAME,
    ).toBe("mockprep");
  });
});

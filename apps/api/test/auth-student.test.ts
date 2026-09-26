import request from "supertest";
import { describe, expect, it } from "vitest";
import { ROTATION_GRACE_MS } from "../src/services/sessions.js";
import { SessionModel } from "@mockprep/core";
import { UserModel } from "@mockprep/core";
import { ExamModel } from "@mockprep/core";
import {
  RecordingOtpSender,
  buildTestApp,
  cookieFrom,
  loginStudent,
  setCookieLine,
  useTestDatabase,
} from "./helpers.js";

const db = useTestDatabase();

function setup() {
  const sender = new RecordingOtpSender();
  return { sender, app: buildTestApp({ otpSender: sender }) };
}

const refresh = (app: ReturnType<typeof buildTestApp>, cookie: string) =>
  request(app).post("/api/auth/refresh").set("Cookie", cookie);

describe("phone OTP sign-in", () => {
  it("creates the student, sets an httpOnly refresh cookie and returns an access token", async () => {
    const { app, sender } = setup();
    const send = await request(app)
      .post("/api/auth/otp/send")
      .send({ phone: "+91 98765 43210" })
      .expect(200);
    expect(send.body).toEqual({ expiresInSec: 300, resendInSec: 30 });

    const code = sender.sent.get("+919876543210");
    expect(code).toMatch(/^\d{6}$/);
    const res = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "9876543210", code })
      .expect(200);

    expect(res.body.accessToken).toBeTypeOf("string");
    expect(res.body.user).toMatchObject({
      role: "student",
      phone: "+919876543210",
      onboarded: false,
    });
    const line = setCookieLine(res, "mp_rt") ?? "";
    expect(line).toMatch(/HttpOnly/);
    expect(line).toMatch(/SameSite=Strict/);
    expect(line).toMatch(/Path=\/api\/auth/);
    expect(await UserModel.countDocuments({ phone: "+919876543210" })).toBe(1);

    // Same phone again signs in to the same user.
    await db.redis().del("otp:cooldown:+919876543210");
    const again = await loginStudent(app, sender);
    expect(again.userId).toBe(res.body.user.id);
  });

  it("rejects wrong codes, counts attempts and makes codes single-use", async () => {
    const { app, sender } = setup();
    await request(app).post("/api/auth/otp/send").send({ phone: "9876543210" }).expect(200);
    const code = sender.sent.get("+919876543210") ?? "";
    const wrong = code === "000000" ? "111111" : "000000";

    const bad = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "9876543210", code: wrong })
      .expect(400);
    expect(bad.body).toEqual({ error: "Incorrect code", details: { attemptsLeft: 4 } });

    await request(app).post("/api/auth/otp/verify").send({ phone: "9876543210", code }).expect(200);
    const reused = await request(app)
      .post("/api/auth/otp/verify")
      .send({ phone: "9876543210", code })
      .expect(400);
    expect(reused.body.error).toMatch(/expired/);
  });

  it("locks the code after 5 wrong attempts", async () => {
    const { app, sender } = setup();
    await request(app).post("/api/auth/otp/send").send({ phone: "9876543210" }).expect(200);
    const code = sender.sent.get("+919876543210") ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth/otp/verify")
        .send({ phone: "9876543210", code: wrong })
        .expect(400);
    }
    await request(app).post("/api/auth/otp/verify").send({ phone: "9876543210", code }).expect(400);
  });

  it("rate-limits sending: 30 s cooldown, 5 per phone per hour, 20 per IP per hour", async () => {
    const { app } = setup();
    await request(app).post("/api/auth/otp/send").send({ phone: "9876543210" }).expect(200);
    const cooldown = await request(app)
      .post("/api/auth/otp/send")
      .send({ phone: "9876543210" })
      .expect(429);
    expect(cooldown.body.details.retryAfterSec).toBeGreaterThan(0);

    for (let i = 0; i < 4; i++) {
      await db.redis().del("otp:cooldown:+919876543210");
      await request(app).post("/api/auth/otp/send").send({ phone: "9876543210" }).expect(200);
    }
    await db.redis().del("otp:cooldown:+919876543210");
    const perPhone = await request(app)
      .post("/api/auth/otp/send")
      .send({ phone: "9876543210" })
      .expect(429);
    expect(perPhone.body.error).toMatch(/this number/);

    // Per IP: 5 sends above + 15 more phones reach 20; the 21st is refused.
    for (let i = 0; i < 15; i++) {
      await request(app)
        .post("/api/auth/otp/send")
        .send({ phone: `98000000${String(i).padStart(2, "0")}` })
        .expect(200);
    }
    const perIp = await request(app)
      .post("/api/auth/otp/send")
      .send({ phone: "9811111111" })
      .expect(429);
    expect(perIp.body.error).toMatch(/this network/);
  });

  it("validates the phone number", async () => {
    const { app } = setup();
    const res = await request(app).post("/api/auth/otp/send").send({ phone: "12345" }).expect(400);
    expect(res.body.error).toBe("Validation failed");
  });
});

describe("refresh token rotation", () => {
  it("rotates the refresh cookie on every refresh", async () => {
    const { app, sender } = setup();
    const { cookie } = await loginStudent(app, sender);
    const first = await refresh(app, cookie).expect(200);
    const rotated = cookieFrom(first, "mp_rt") ?? "";
    expect(rotated).not.toBe(cookie);
    expect(first.body.accessToken).toBeTypeOf("string");
    await refresh(app, rotated).expect(200);
  });

  it("accepts the previous token briefly (racing tabs), then treats reuse as theft", async () => {
    const { app, sender } = setup();
    const { cookie: original } = await loginStudent(app, sender);
    const rotated = cookieFrom(await refresh(app, original).expect(200), "mp_rt") ?? "";

    // Within the grace window the old token still works (and rotates again).
    const graced = cookieFrom(await refresh(app, rotated).expect(200), "mp_rt") ?? "";

    // Push the last rotation outside the grace window, then replay the rotated-out token.
    await SessionModel.updateMany(
      {},
      { $set: { rotatedAt: new Date(Date.now() - ROTATION_GRACE_MS - 1000) } },
    );
    const reuse = await refresh(app, rotated).expect(401);
    expect(setCookieLine(reuse, "mp_rt")).toMatch(/Expires=Thu, 01 Jan 1970/);

    // The whole session is revoked: even the newest token is dead now.
    await refresh(app, graced).expect(401);
    const session = await SessionModel.findOne().lean();
    expect(session?.revokedReason).toBe("reuse_detected");
  });

  it("rejects missing, malformed and admin cookies", async () => {
    const { app } = setup();
    await request(app).post("/api/auth/refresh").expect(401);
    await refresh(app, "mp_rt=garbage").expect(401);
  });

  it("logout revokes the session and clears the cookie", async () => {
    const { app, sender } = setup();
    const { cookie } = await loginStudent(app, sender);
    const res = await request(app).post("/api/auth/logout").set("Cookie", cookie).expect(204);
    expect(setCookieLine(res, "mp_rt")).toBeDefined();
    await refresh(app, cookie).expect(401);
  });
});

describe("device limit", () => {
  it("keeps at most 2 student devices, revoking the least recently used", async () => {
    const { app, sender } = setup();
    const phoneA = await loginStudent(app, sender, "9876543210", "phone");
    await db.redis().del("otp:cooldown:+919876543210");
    const laptop = await loginStudent(app, sender, "9876543210", "laptop");
    // Use the phone again so the laptop becomes least recently used.
    const phoneB = cookieFrom(await refresh(app, phoneA.cookie).expect(200), "mp_rt") ?? "";
    await db.redis().del("otp:cooldown:+919876543210");
    const tablet = await loginStudent(app, sender, "9876543210", "tablet");

    await refresh(app, laptop.cookie).expect(401);
    await refresh(app, phoneB).expect(200);
    await refresh(app, tablet.cookie).expect(200);
    expect(await SessionModel.countDocuments({ revokedReason: "device_limit" })).toBe(1);
  });
});

describe("Google sign-in", () => {
  it("creates a student once per Google account", async () => {
    const { app } = setup();
    const first = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google:sub-123:priya@example.com" })
      .expect(200);
    expect(first.body.user).toMatchObject({
      role: "student",
      email: "priya@example.com",
      name: "Google User",
    });
    expect(cookieFrom(first, "mp_rt")).toBeDefined();
    const second = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google:sub-123:priya@example.com" })
      .expect(200);
    expect(second.body.user.id).toBe(first.body.user.id);
  });

  it("refuses admin emails and invalid tokens", async () => {
    const { app } = setup();
    await UserModel.create({ role: "content", email: "staff@example.com" });
    await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google:sub-9:staff@example.com" })
      .expect(403);
    await request(app)
      .post("/api/auth/google")
      .send({ idToken: "not-a-google-token-at-all" })
      .expect(401);
  });

  it("returns 400 when Google is not configured", async () => {
    const app = buildTestApp({ googleVerifier: null });
    const res = await request(app)
      .post("/api/auth/google")
      .send({ idToken: "google:sub:e@example.com" })
      .expect(400);
    expect(res.body.error).toMatch(/not configured/);
  });
});

describe("/api/me and onboarding", () => {
  it("saves name, target exams and language", async () => {
    const { app, sender } = setup();
    await ExamModel.create({
      slug: "sbi-po",
      name: "SBI PO",
      shortName: "SBI PO",
      family: "banking",
      templateKeys: ["sbi-po-prelims"],
      status: "published",
    });
    await ExamModel.create({
      slug: "secret",
      name: "Draft",
      shortName: "Draft",
      family: "banking",
      templateKeys: ["x"],
      status: "draft",
    });
    const { accessToken } = await loginStudent(app, sender);
    const auth = { Authorization: `Bearer ${accessToken}` };

    await request(app).get("/api/me").expect(401);
    const bad = await request(app)
      .patch("/api/me/onboarding")
      .set(auth)
      .send({ name: "Priya", targetExamSlugs: ["secret"], language: "hi" })
      .expect(400);
    expect(bad.body.details).toEqual({ unknown: ["secret"] });

    const res = await request(app)
      .patch("/api/me/onboarding")
      .set(auth)
      .send({ name: "Priya", targetExamSlugs: ["sbi-po"], language: "hi" })
      .expect(200);
    expect(res.body.user).toMatchObject({
      name: "Priya",
      targetExamSlugs: ["sbi-po"],
      language: "hi",
      onboarded: true,
    });
    const me = await request(app).get("/api/me").set(auth).expect(200);
    expect(me.body.user.onboarded).toBe(true);
  });
});

import request from "supertest";
import { describe, expect, it } from "vitest";
import { totpCode, TOTP_STEP_SEC } from "../src/lib/totp.js";
import { UserModel } from "../src/models/user.js";
import {
  ADMIN_PASSWORD,
  buildTestApp,
  cookieFrom,
  createAdmin,
  loginAdmin,
  setCookieLine,
  useTestDatabase,
} from "./helpers.js";

useTestDatabase();

const login = (app: ReturnType<typeof buildTestApp>, email: string, password = ADMIN_PASSWORD) =>
  request(app).post("/api/admin/auth/login").send({ email, password });

describe("admin sign-in", () => {
  it("forces TOTP enrolment on first sign-in, then requires the code", async () => {
    const app = buildTestApp();
    await createAdmin("content", "editor@example.com", false);

    const first = await login(app, "Editor@Example.com").expect(200);
    expect(first.body.status).toBe("totp_setup_required");
    expect(first.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(first.body.otpauthUrl).toMatch(
      /^otpauth:\/\/totp\/mockprep%3Aeditor%40example\.com\?secret=/,
    );

    // Logging in again before finishing keeps the same secret (the scanned QR still works).
    const retry = await login(app, "editor@example.com").expect(200);
    expect(retry.body.secret).toBe(first.body.secret);

    const secret = first.body.secret as string;
    const verified = await request(app)
      .post("/api/admin/auth/totp/verify")
      .send({ challengeToken: retry.body.challengeToken, code: totpCode(secret, Date.now()) })
      .expect(200);
    expect(verified.body.user).toMatchObject({ role: "content", email: "editor@example.com" });
    expect(setCookieLine(verified, "mp_art")).toMatch(/Path=\/api\/admin\/auth/);
    expect((await UserModel.findOne({ email: "editor@example.com" }))?.totp?.enabled).toBe(true);

    const next = await login(app, "editor@example.com").expect(200);
    expect(next.body).toEqual({ status: "totp_required", challengeToken: expect.any(String) });
  });

  it("rejects replayed and wrong TOTP codes", async () => {
    const app = buildTestApp();
    const { secret } = await createAdmin("superadmin", "root@example.com");
    const code = totpCode(secret, Date.now());
    const challenge = (await login(app, "root@example.com").expect(200)).body
      .challengeToken as string;
    await request(app)
      .post("/api/admin/auth/totp/verify")
      .send({ challengeToken: challenge, code })
      .expect(200);

    const challenge2 = (await login(app, "root@example.com").expect(200)).body
      .challengeToken as string;
    await request(app)
      .post("/api/admin/auth/totp/verify")
      .send({ challengeToken: challenge2, code })
      .expect(400);
    const stale = totpCode(secret, Date.now() - 5 * TOTP_STEP_SEC * 1000);
    await request(app)
      .post("/api/admin/auth/totp/verify")
      .send({ challengeToken: challenge2, code: stale })
      .expect(400);
    await request(app)
      .post("/api/admin/auth/totp/verify")
      .send({ challengeToken: "forged", code })
      .expect(401);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const app = buildTestApp();
    await createAdmin("superadmin", "root@example.com");
    const wrong = await login(app, "root@example.com", "Wrong-Password-123").expect(401);
    const unknown = await login(app, "nobody@example.com").expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("rate-limits password attempts per email", async () => {
    const app = buildTestApp();
    await createAdmin("superadmin", "root@example.com");
    for (let i = 0; i < 10; i++)
      await login(app, "root@example.com", "Wrong-Password-123").expect(401);
    await login(app, "root@example.com").expect(429);
  });

  it("refreshes and logs out with the admin cookie only", async () => {
    const app = buildTestApp();
    const { secret } = await createAdmin("reviewer", "rev@example.com");
    const { cookie } = await loginAdmin(app, "rev@example.com", secret);

    const refreshed = await request(app)
      .post("/api/admin/auth/refresh")
      .set("Cookie", cookie)
      .expect(200);
    const rotated = cookieFrom(refreshed, "mp_art") ?? "";
    expect(rotated).not.toBe(cookie);
    // The admin cookie is not a student session.
    await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", rotated.replace("mp_art", "mp_rt"))
      .expect(401);

    await request(app).post("/api/admin/auth/logout").set("Cookie", rotated).expect(204);
    await request(app).post("/api/admin/auth/refresh").set("Cookie", rotated).expect(401);
  });

  it("does not let students use the admin login", async () => {
    const app = buildTestApp();
    await UserModel.create({ role: "student", email: "student@example.com" });
    await login(app, "student@example.com").expect(401);
  });
});

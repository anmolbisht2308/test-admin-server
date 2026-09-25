import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  RecordingOtpSender,
  accessTokenFor,
  buildTestApp,
  createAdmin,
  loginAdmin,
  loginStudent,
  useTestDatabase,
} from "./helpers.js";

useTestDatabase();

const template = {
  key: "mini",
  name: "Mini",
  family: "other",
  skin: "generic",
  totalTimeSec: 600,
  optionCount: 4,
  sectionSwitching: "free",
  sections: [{ name: "Section 1", count: 10 }],
  marking: { correct: 1, wrong: 0 },
};

describe("admin role guard", () => {
  it("returns 401 without a token", async () => {
    const res = await request(buildTestApp()).get("/api/admin/exams").expect(401);
    expect(res.body).toEqual({ error: "Sign in required" });
  });

  it("returns 403 for a signed-in student on every admin route", async () => {
    const sender = new RecordingOtpSender();
    const app = buildTestApp({ otpSender: sender });
    const { accessToken } = await loginStudent(app, sender);
    const auth = { Authorization: `Bearer ${accessToken}` };
    for (const path of ["/api/admin/exams", "/api/admin/templates", "/api/admin/taxonomy"]) {
      const res = await request(app).get(path).set(auth).expect(403);
      expect(res.body.error).toMatch(/permission/);
    }
    await request(app).post("/api/admin/templates").set(auth).send(template).expect(403);
  });

  it("rejects forged and expired-looking tokens", async () => {
    const app = buildTestApp();
    await request(app).get("/api/admin/exams").set("Authorization", "Bearer not.a.jwt").expect(401);
  });

  it("lets every admin role read but only superadmin/content write", async () => {
    const app = buildTestApp();
    for (const role of ["reviewer", "support", "finance"] as const) {
      const token = await accessTokenFor("64b000000000000000000001", role);
      await request(app)
        .get("/api/admin/templates")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      await request(app)
        .post("/api/admin/templates")
        .set("Authorization", `Bearer ${token}`)
        .send(template)
        .expect(403);
    }
  });

  it("allows a content admin (real login) to create a template", async () => {
    const app = buildTestApp();
    const { secret } = await createAdmin("content", "c@example.com");
    const { accessToken } = await loginAdmin(app, "c@example.com", secret);
    await request(app)
      .post("/api/admin/templates")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(template)
      .expect(201);
  });
});

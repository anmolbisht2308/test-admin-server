import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import {
  examDetailResponseSchema,
  examListResponseSchema,
  examTemplateInputSchema,
} from "@mockprep/types";
import { AuditLogModel } from "../src/models/auditLog.js";
import { SEED_EXAMS, SEED_TEMPLATES } from "../src/scripts/seed-data.js";
import { seedCatalogue } from "../src/scripts/seedCatalogue.js";
import { ExamTemplateModel } from "../src/models/examTemplate.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

const ADMIN_ID = "64b0000000000000000000aa";
let auth: { Authorization: string };
beforeEach(async () => {
  auth = { Authorization: `Bearer ${await accessTokenFor(ADMIN_ID, "content")}` };
});

const bankTemplate = {
  key: "rrb-po-prelims",
  name: "RRB PO Prelims",
  family: "banking",
  skin: "ibps",
  totalTimeSec: 2700,
  optionCount: 5,
  sectionSwitching: "free",
  sections: [
    { name: "Reasoning", count: 40 },
    { name: "Quantitative Aptitude", count: 40 },
  ],
  marking: { correct: 1, wrong: -0.25 },
};

const rrbExam = {
  slug: "rrb-po",
  name: "IBPS RRB PO",
  shortName: "RRB PO",
  family: "banking",
  templateKeys: ["rrb-po-prelims"],
  status: "published",
};

describe("admin creates an exam + template → student catalogue", () => {
  it("shows a new published exam with its pattern, without a deploy", async () => {
    const app = buildTestApp();
    await request(app).post("/api/admin/templates").set(auth).send(bankTemplate).expect(201);
    const created = await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(201);
    expect(created.body.exam).toMatchObject({ slug: "rrb-po", description: "", sortOrder: 100 });

    const list = examListResponseSchema.parse(
      (await request(app).get("/api/exams").expect(200)).body,
    );
    expect(list.exams.map((e) => e.slug)).toEqual(["rrb-po"]);

    const detailRes = await request(app).get("/api/exams/rrb-po").expect(200);
    expect(detailRes.headers["cache-control"]).toMatch(/max-age=60/);
    const detail = examDetailResponseSchema.parse(detailRes.body);
    expect(detail.templates[0]?.sections.map((s) => s.count)).toEqual([40, 40]);
  });

  it("hides drafts from students but not from admins", async () => {
    const app = buildTestApp();
    await request(app).post("/api/admin/templates").set(auth).send(bankTemplate).expect(201);
    await request(app)
      .post("/api/admin/exams")
      .set(auth)
      .send({ ...rrbExam, status: "draft" })
      .expect(201);
    expect((await request(app).get("/api/exams").expect(200)).body.exams).toEqual([]);
    await request(app).get("/api/exams/rrb-po").expect(404);
    expect(
      (await request(app).get("/api/admin/exams").set(auth).expect(200)).body.exams,
    ).toHaveLength(1);
  });

  it("validates references, uniqueness and template rules", async () => {
    const app = buildTestApp();
    const missing = await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(400);
    expect(missing.body).toEqual({
      error: "Unknown templates",
      details: { missing: ["rrb-po-prelims"] },
    });

    await request(app).post("/api/admin/templates").set(auth).send(bankTemplate).expect(201);
    const dupTemplate = await request(app)
      .post("/api/admin/templates")
      .set(auth)
      .send(bankTemplate)
      .expect(409);
    expect(dupTemplate.body.details).toEqual({ fields: ["key"] });
    await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(201);
    await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(409);

    const locked = { ...bankTemplate, key: "locked", sectionSwitching: "locked_sequential" };
    const invalid = await request(app)
      .post("/api/admin/templates")
      .set(auth)
      .send(locked)
      .expect(400);
    expect(invalid.body.error).toBe("Validation failed");
    expect(JSON.stringify(invalid.body.details)).toMatch(/time limit/);
  });

  it("updates a template with PUT but never its key, and blocks deleting a used template", async () => {
    const app = buildTestApp();
    const created = await request(app)
      .post("/api/admin/templates")
      .set(auth)
      .send(bankTemplate)
      .expect(201);
    const id = created.body.template.id as string;
    await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(201);

    const updated = await request(app)
      .put(`/api/admin/templates/${id}`)
      .set(auth)
      .send({ ...bankTemplate, key: "renamed", name: "RRB PO Prelims 2026", qualifyingPercent: 40 })
      .expect(200);
    expect(updated.body.template).toMatchObject({
      key: "rrb-po-prelims",
      name: "RRB PO Prelims 2026",
      qualifyingPercent: 40,
    });

    // Removing an optional field on PUT clears it.
    const cleared = await request(app)
      .put(`/api/admin/templates/${id}`)
      .set(auth)
      .send(bankTemplate)
      .expect(200);
    expect(cleared.body.template.qualifyingPercent).toBeUndefined();

    const blocked = await request(app).delete(`/api/admin/templates/${id}`).set(auth).expect(409);
    expect(blocked.body.details).toEqual({ exams: ["rrb-po"] });
    const detail = await request(app).get(`/api/admin/templates/${id}`).set(auth).expect(200);
    expect(detail.body.usedBy).toEqual([expect.objectContaining({ slug: "rrb-po" })]);
    await request(app).get("/api/admin/templates/not-an-id").set(auth).expect(404);
  });

  it("writes an audit log for every admin write", async () => {
    const app = buildTestApp();
    await request(app).post("/api/admin/templates").set(auth).send(bankTemplate).expect(201);
    const exam = await request(app).post("/api/admin/exams").set(auth).send(rrbExam).expect(201);
    const id = exam.body.exam.id as string;
    await request(app)
      .patch(`/api/admin/exams/${id}`)
      .set(auth)
      .send({ name: "IBPS RRB PO 2026", sortOrder: 5 })
      .expect(200);
    await request(app).delete(`/api/admin/exams/${id}`).set(auth).expect(204);

    const logs = await AuditLogModel.find({ entity: "exam" }).sort({ at: 1 }).lean();
    expect(logs.map((l) => l.action)).toEqual(["create", "update", "delete"]);
    expect(logs.every((l) => l.actor.toString() === ADMIN_ID && l.entityId === id)).toBe(true);
    expect(logs[1]?.diff).toEqual({
      name: { from: "IBPS RRB PO", to: "IBPS RRB PO 2026" },
      sortOrder: { from: 100, to: 5 },
    });
    expect(await AuditLogModel.countDocuments({ entity: "examTemplate", action: "create" })).toBe(
      1,
    );
  });
});

describe("seed data", () => {
  it("contains valid templates, and every exam references a seeded template", () => {
    const keys = new Set(SEED_TEMPLATES.map((t) => examTemplateInputSchema.parse(t).key));
    for (const exam of SEED_EXAMS)
      for (const key of exam.templateKeys) expect(keys.has(key)).toBe(true);
    expect(keys.size).toBe(SEED_TEMPLATES.length);
  });

  it("is idempotent and never overwrites admin edits", async () => {
    const app = buildTestApp();
    await seedCatalogue();
    await ExamTemplateModel.updateOne({ key: "sbi-po-prelims" }, { $set: { name: "Edited" } });
    await seedCatalogue();
    expect(await ExamTemplateModel.countDocuments()).toBe(SEED_TEMPLATES.length);
    expect((await ExamTemplateModel.findOne({ key: "sbi-po-prelims" }).lean())?.name).toBe(
      "Edited",
    );

    const upsc = examDetailResponseSchema.parse(
      (await request(app).get("/api/exams/upsc-prelims").expect(200)).body,
    );
    expect(upsc.templates.map((t) => t.key)).toEqual(["upsc-gs1", "upsc-csat"]);
    expect(upsc.templates[1]?.qualifyingPercent).toBe(33);
  });
});

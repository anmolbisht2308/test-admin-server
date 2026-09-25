import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditLogModel } from "../src/models/auditLog.js";
import { QuestionModel } from "../src/models/question.js";
import { TestModel } from "../src/models/test.js";
import { makeQuestion, makeQuestions, seed } from "./factories.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

let auth: { Authorization: string };
beforeEach(async () => {
  await seed();
  auth = { Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "content")}` };
});

const body = {
  examKey: "sbi-po",
  section: "Quantitative Aptitude",
  type: "mcq_single",
  stem: "A train covers $120\\,km$ in $2$ hours. Its speed?",
  options: ["40 km/h", "50 km/h", "60 km/h", "70 km/h", "80 km/h"],
  correct: [2],
  solution: "$120/2 = 60$",
  topic: "Speed, time and distance",
  difficulty: "easy",
  status: "approved",
};

/** A test containing the given question ids in its first section. */
async function testWith(ids: string[], status: "draft" | "published") {
  return TestModel.create({
    title: `T ${status}`,
    examKey: "sbi-po",
    type: "full",
    status,
    publishedAt: status === "published" ? new Date() : null,
    templateSnapshot: {
      key: "x",
      name: "x",
      family: "banking",
      skin: "ibps",
      totalTimeSec: 60,
      optionCount: 5,
      sectionSwitching: "free",
      sections: [{ name: "Quantitative Aptitude", count: 1, aliases: [] }],
      marking: { correct: 1, wrong: 0 },
    },
    sections: [{ name: "Quantitative Aptitude", questionIds: ids }],
  });
}

describe("question CRUD", () => {
  it("creates an approved question with family, hash and version 1", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/api/admin/questions").set(auth).send(body).expect(201);
    const q = res.body.question;
    expect(q).toMatchObject({
      examFamily: "banking",
      version: 1,
      isLatest: true,
      flags: [],
      answerSource: "manual",
    });
    expect(q.rootId).toBe(q.id);
    expect(q.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(await AuditLogModel.countDocuments({ entity: "question", action: "create" })).toBe(1);
  });

  it("validates input and the exam", async () => {
    const app = buildTestApp();
    const bad = await request(app)
      .post("/api/admin/questions")
      .set(auth)
      .send({ ...body, correct: [] })
      .expect(400);
    expect(JSON.stringify(bad.body.details)).toMatch(/need an answer/);
    const unknown = await request(app)
      .post("/api/admin/questions")
      .set(auth)
      .send({ ...body, examKey: "nope" })
      .expect(400);
    expect(unknown.body.error).toBe('Unknown exam "nope"');
    const reviewer = {
      Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000ab", "reviewer")}`,
    };
    await request(app).post("/api/admin/questions").set(reviewer).send(body).expect(403);
  });

  it("flags duplicates by normalised content and lists duplicate groups", async () => {
    const app = buildTestApp();
    await request(app).post("/api/admin/questions").set(auth).send(body).expect(201);
    const copy = {
      ...body,
      stem: body.stem.toUpperCase(),
      options: [...body.options].reverse(),
      correct: [2],
    };
    const dup = await request(app).post("/api/admin/questions").set(auth).send(copy).expect(201);
    expect(dup.body.question.flags).toEqual(["duplicate"]);
    const groups = await request(app).get("/api/admin/questions/duplicates").set(auth).expect(200);
    expect(groups.body.groups).toHaveLength(1);
    expect(groups.body.groups[0].questions).toHaveLength(2);
  });

  it("refuses to delete a question that is in a test", async () => {
    const app = buildTestApp();
    const q = await makeQuestion();
    await testWith([q.id], "draft");
    const res = await request(app).delete(`/api/admin/questions/${q.id}`).set(auth).expect(409);
    expect(res.body.details.tests[0].title).toBe("T draft");
    const free = await makeQuestion();
    await request(app).delete(`/api/admin/questions/${free.id}`).set(auth).expect(204);
  });
});

describe("bank listing", () => {
  it("filters by family, section, difficulty, status and text", async () => {
    const app = buildTestApp();
    await makeQuestions(3, { difficulty: "hard" });
    await makeQuestion({
      section: "Reasoning Ability",
      stem: "Find the odd one out: apple, mango, carrot",
    });
    await makeQuestion({
      examKey: "ssc-cgl",
      section: "General Awareness",
      stem: "Capital of India?",
      options: ["Delhi", "Mumbai", "Pune", "Agra"],
      correct: [0],
    });
    await makeQuestion({ status: "draft", correct: [], stem: "Draft question about the monsoon" });
    await makeQuestion({ stemHi: "भारत की राजधानी क्या है?", stem: "" });
    const list = (qs: string) =>
      request(app).get(`/api/admin/questions?${qs}`).set(auth).expect(200);

    expect((await list("")).body.total).toBe(7);
    expect((await list("examFamily=ssc")).body.total).toBe(1);
    expect((await list("section=reasoning%20ability")).body.total).toBe(1);
    expect((await list("difficulty=hard")).body.total).toBe(3);
    expect((await list("status=draft")).body.total).toBe(1);
    expect((await list("q=carrot")).body.questions[0].stem).toMatch(/carrot/);
    expect((await list("q=राजधानी")).body.total).toBe(1);
    const page = await list("pageSize=2&page=2");
    expect(page.body).toMatchObject({ page: 2, pageSize: 2, total: 7 });
    expect(page.body.questions).toHaveLength(2);
  });

  it("bulk-tags (no new versions) and bulk-deletes, skipping questions in tests", async () => {
    const app = buildTestApp();
    const [a, b, c] = await makeQuestions(3);
    await testWith([c!.id], "published");
    const tagged = await request(app)
      .post("/api/admin/questions/bulk")
      .set(auth)
      .send({
        action: "update",
        ids: [a!.id, b!.id, c!.id],
        set: { topic: "Percentages", difficulty: "hard" },
      })
      .expect(200);
    expect(tagged.body).toEqual({ modified: 3, skipped: [] });
    expect(
      await QuestionModel.countDocuments({ topic: "Percentages", difficulty: "hard", version: 1 }),
    ).toBe(3);

    const deleted = await request(app)
      .post("/api/admin/questions/bulk")
      .set(auth)
      .send({ action: "delete", ids: [a!.id, c!.id] })
      .expect(200);
    expect(deleted.body.modified).toBe(1);
    expect(deleted.body.skipped).toEqual([{ id: c!.id, reason: "used in T published" }]);
    expect(await AuditLogModel.countDocuments({ entity: "question", action: "delete" })).toBe(1);
  });
});

describe("versioning", () => {
  it("creates a new version when content changes on a question in a published test", async () => {
    const app = buildTestApp();
    const res = await request(app).post("/api/admin/questions").set(auth).send(body).expect(201);
    const v1 = res.body.question.id as string;
    const published = await testWith([v1], "published");
    const draft = await testWith([v1], "draft");

    const edit = await request(app)
      .put(`/api/admin/questions/${v1}`)
      .set(auth)
      .send({ ...body, correct: [1] })
      .expect(200);
    expect(edit.body.versioned).toBe(true);
    const v2 = edit.body.question;
    expect(v2).toMatchObject({ version: 2, rootId: v1, isLatest: true, correct: [1] });
    expect(v2.id).not.toBe(v1);

    // Published test keeps v1 (with the old answer); the draft moves to v2.
    expect(
      (await TestModel.findById(published._id).lean())?.sections[0]?.questionIds.map(String),
    ).toEqual([v1]);
    expect(
      (await TestModel.findById(draft._id).lean())?.sections[0]?.questionIds.map(String),
    ).toEqual([v2.id]);
    expect((await QuestionModel.findById(v1).lean())?.correct).toEqual([2]);

    // The bank only lists the latest version; the old one can't be edited.
    const list = await request(app).get("/api/admin/questions").set(auth).expect(200);
    expect(list.body.questions.map((q: { id: string }) => q.id)).toEqual([v2.id]);
    await request(app).put(`/api/admin/questions/${v1}`).set(auth).send(body).expect(409);

    const detail = await request(app).get(`/api/admin/questions/${v2.id}`).set(auth).expect(200);
    expect(detail.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(detail.body.versions[1].usedIn[0].title).toBe("T published");
  });

  it("edits in place when only tags change, or when the question is only in drafts", async () => {
    const app = buildTestApp();
    const q = (await request(app).post("/api/admin/questions").set(auth).send(body).expect(201))
      .body.question;
    await testWith([q.id], "published");
    const tags = await request(app)
      .put(`/api/admin/questions/${q.id}`)
      .set(auth)
      .send({ ...body, topic: "Speed", difficulty: "hard" })
      .expect(200);
    expect(tags.body).toMatchObject({
      versioned: false,
      question: { id: q.id, version: 1, topic: "Speed" },
    });

    const other = (
      await request(app)
        .post("/api/admin/questions")
        .set(auth)
        .send({ ...body, stem: "Different question?" })
        .expect(201)
    ).body.question;
    await testWith([other.id], "draft");
    const inPlace = await request(app)
      .put(`/api/admin/questions/${other.id}`)
      .set(auth)
      .send({ ...body, stem: "Different question, edited?" })
      .expect(200);
    expect(inPlace.body).toMatchObject({
      versioned: false,
      question: { id: other.id, version: 1 },
    });
  });
});

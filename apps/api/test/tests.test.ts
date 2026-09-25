import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { publicTestListResponseSchema, studentPaperSchema } from "@mockprep/types";
import { ExamTemplateModel } from "../src/models/examTemplate.js";
import { TestModel } from "../src/models/test.js";
import { splitByMix } from "../src/services/testBuilder.js";
import { makeQuestion, makeQuestions, seed } from "./factories.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

let auth: { Authorization: string };
beforeEach(async () => {
  await seed();
  auth = { Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "content")}` };
});

type App = ReturnType<typeof buildTestApp>;
const create = (app: App, title = "SBI PO Mock 1") =>
  request(app)
    .post("/api/admin/tests")
    .set(auth)
    .send({ title, examKey: "sbi-po", templateKey: "sbi-po-prelims" });

/** A bank big enough for an SBI PO mock: 60 per section, 20 per difficulty. */
async function sbiBank() {
  for (const section of ["English Language", "Quantitative Aptitude", "Reasoning Ability"]) {
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      await makeQuestions(20, { section, difficulty });
    }
  }
}

const fullRule = (mix = { easy: 30, medium: 50, hard: 20 }) => ({
  sections: [
    { index: 0, rule: { count: 30, difficultyMix: mix } },
    { index: 1, rule: { count: 35, difficultyMix: mix } },
    { index: 2, rule: { count: 35, difficultyMix: mix } },
  ],
});

describe("test builder", () => {
  it("creates sections from a frozen template snapshot", async () => {
    const app = buildTestApp();
    const res = await create(app).expect(201);
    expect(res.body.test.sections).toEqual([
      { name: "English Language", timeSec: 1200, questionIds: [] },
      { name: "Quantitative Aptitude", timeSec: 1200, questionIds: [] },
      { name: "Reasoning Ability", timeSec: 1200, questionIds: [] },
    ]);
    expect(res.body.checks).toMatchObject({
      ok: false,
      questionCount: { expected: 100, actual: 0 },
    });

    // Editing the template later never changes the test.
    await ExamTemplateModel.updateOne(
      { key: "sbi-po-prelims" },
      { $set: { "marking.wrong": -0.5 } },
    );
    const again = await request(app)
      .get(`/api/admin/tests/${res.body.test.id}`)
      .set(auth)
      .expect(200);
    expect(again.body.test.templateSnapshot.marking).toEqual({ correct: 1, wrong: -0.25 });

    const wrong = await request(app)
      .post("/api/admin/tests")
      .set(auth)
      .send({ title: "Wrong paper", examKey: "sbi-po", templateKey: "jee-main" })
      .expect(400);
    expect(wrong.body.error).toMatch(/does not use this template/);
  });

  it("fills every section by rule with the difficulty mix, then publishes", async () => {
    const app = buildTestApp();
    await sbiBank();
    await makeQuestions(5, { section: "Quantitative Aptitude", status: "draft", correct: [] });
    await makeQuestions(5, {
      examKey: "ssc-cgl",
      section: "Quantitative Aptitude",
      options: ["1", "2", "3", "4"],
      correct: [0],
    });
    const id = (await create(app).expect(201)).body.test.id as string;

    const filled = await request(app)
      .post(`/api/admin/tests/${id}/fill`)
      .set(auth)
      .send(fullRule())
      .expect(200);
    expect(
      filled.body.report.map((r: { added: number; shortfall: number }) => [r.added, r.shortfall]),
    ).toEqual([
      [30, 0],
      [35, 0],
      [35, 0],
    ]);
    expect(filled.body.checks).toMatchObject({
      ok: true,
      duplicates: [],
      drafts: [],
      missingAnswers: [],
    });

    const quant = filled.body.test.sections[1].questionIds.map(
      (qid: string) => filled.body.questions[qid],
    );
    const counts = { easy: 0, medium: 0, hard: 0 } as Record<string, number>;
    for (const q of quant) counts[q.difficulty] = (counts[q.difficulty] ?? 0) + 1;
    expect(counts).toEqual(splitByMix(35, { easy: 30, medium: 50, hard: 20 }));
    expect(
      quant.every(
        (q: { status: string; examFamily: string; section: string }) =>
          q.status === "approved" &&
          q.examFamily === "banking" &&
          q.section === "Quantitative Aptitude",
      ),
    ).toBe(true);
    const all = filled.body.test.sections.flatMap((s: { questionIds: string[] }) => s.questionIds);
    expect(new Set(all).size).toBe(100);

    await request(app).post(`/api/admin/tests/${id}/publish`).set(auth).expect(200);
    const cards = publicTestListResponseSchema.parse(
      (await request(app).get("/api/exams/sbi-po/tests").expect(200)).body,
    );
    expect(cards.tests).toEqual([
      expect.objectContaining({
        title: "SBI PO Mock 1",
        isFree: true,
        questionCount: 100,
        totalTimeSec: 3600,
        sectionCount: 3,
      }),
    ]);
    // Published tests are read-only until unpublished.
    await request(app).post(`/api/admin/tests/${id}/fill`).set(auth).send(fullRule()).expect(409);
    await request(app).post(`/api/admin/tests/${id}/unpublish`).set(auth).expect(200);
    expect((await request(app).get("/api/exams/sbi-po/tests").expect(200)).body.tests).toEqual([]);
  });

  it("reports shortfalls, tops up across difficulties and skips recently used questions", async () => {
    const app = buildTestApp();
    const easy = await makeQuestions(4, { section: "Reasoning Ability", difficulty: "easy" });
    await makeQuestions(6, { section: "Reasoning Ability", difficulty: "hard" });
    const id = (await create(app).expect(201)).body.test.id as string;
    const rule = {
      sections: [
        { index: 2, rule: { count: 8, difficultyMix: { easy: 100, medium: 0, hard: 0 } } },
      ],
    };
    const res = await request(app)
      .post(`/api/admin/tests/${id}/fill`)
      .set(auth)
      .send(rule)
      .expect(200);
    expect(res.body.report[0]).toMatchObject({ requested: 8, added: 8, shortfall: 0 });

    // Publish another test with the 4 easy ones, then ask for questions not used in 30 days.
    await TestModel.create({
      ...(await TestModel.findById(id).lean()),
      _id: undefined,
      status: "published",
      publishedAt: new Date(),
      sections: [{ name: "Reasoning Ability", questionIds: easy.map((q) => q._id) }],
    });
    const second = (await create(app, "Mock 2").expect(201)).body.test.id as string;
    const fresh = await request(app)
      .post(`/api/admin/tests/${second}/fill`)
      .set(auth)
      .send({ sections: [{ index: 2, rule: { count: 10, notUsedInLastDays: 30 } }] })
      .expect(200);
    expect(fresh.body.report[0]).toMatchObject({ added: 6, shortfall: 4 });
    const picked = new Set(fresh.body.test.sections[2].questionIds);
    expect(easy.some((q) => picked.has(q.id))).toBe(false);
  });

  it("flags missing answers, drafts, duplicates and wrong counts, and blocks publishing", async () => {
    const app = buildTestApp();
    const id = (await create(app).expect(201)).body.test.id as string;
    const good = await makeQuestion({ section: "English Language" });
    const copy = await makeQuestion({
      section: "English Language",
      stem: good.stem,
      options: good.options,
    });
    const draft = await makeQuestion({ section: "English Language", status: "draft", correct: [] });
    const fourOptions = await makeQuestion({
      section: "English Language",
      options: ["a", "b", "c", "d"],
      correct: [0],
    });
    const put = {
      title: "SBI PO Mock 1",
      type: "full",
      isFree: true,
      publishAt: null,
      sections: [
        { name: "English Language", questionIds: [good.id, copy.id, draft.id, fourOptions.id] },
        { name: "Quantitative Aptitude", questionIds: [] },
        { name: "Reasoning Ability", questionIds: [] },
      ],
    };
    const res = await request(app).put(`/api/admin/tests/${id}`).set(auth).send(put).expect(200);
    expect(res.body.checks).toMatchObject({
      ok: false,
      missingAnswers: [draft.id],
      drafts: [draft.id],
      duplicates: [[good.id, copy.id]],
      optionCountMismatch: [fourOptions.id],
      sections: [
        { name: "English Language", expected: 30, actual: 4 },
        { name: "Quantitative Aptitude", expected: 35, actual: 0 },
        { name: "Reasoning Ability", expected: 35, actual: 0 },
      ],
    });
    const blocked = await request(app).post(`/api/admin/tests/${id}/publish`).set(auth).expect(409);
    expect(blocked.body.details.drafts).toEqual([draft.id]);

    await request(app)
      .put(`/api/admin/tests/${id}`)
      .set(auth)
      .send({ ...put, sections: [{ name: "Wrong", questionIds: [] }] })
      .expect(400);
    await request(app)
      .put(`/api/admin/tests/${id}`)
      .set(auth)
      .send({
        ...put,
        sections: put.sections.map((s, i) =>
          i === 1 ? { ...s, questionIds: ["64b000000000000000000fff"] } : s,
        ),
      })
      .expect(400);
  });

  it("previews the paper as students see it: no answers or solutions", async () => {
    const app = buildTestApp();
    await sbiBank();
    const id = (await create(app).expect(201)).body.test.id as string;
    await request(app).post(`/api/admin/tests/${id}/fill`).set(auth).send(fullRule()).expect(200);
    const res = await request(app).get(`/api/admin/tests/${id}/preview`).set(auth).expect(200);
    const paper = studentPaperSchema.parse(res.body); // .strict(): extra keys fail
    expect(paper.sections.map((s) => s.questions.length)).toEqual([30, 35, 35]);
    // Only the template's marking scheme may mention "correct"; questions never carry answers.
    const json = JSON.stringify(res.body.sections);
    for (const leaked of [
      '"correct"',
      '"numAnswer"',
      '"solution"',
      '"answerSource"',
      '"confidence"',
      '"flags"',
      '"hash"',
    ]) {
      expect(json).not.toContain(leaked);
    }
  });

  it("hides tests scheduled for later", async () => {
    const app = buildTestApp();
    await sbiBank();
    const id = (await create(app).expect(201)).body.test.id as string;
    const filled = await request(app)
      .post(`/api/admin/tests/${id}/fill`)
      .set(auth)
      .send(fullRule())
      .expect(200);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await request(app)
      .put(`/api/admin/tests/${id}`)
      .set(auth)
      .send({
        title: "Later",
        type: "full",
        isFree: false,
        publishAt: future,
        sections: filled.body.test.sections,
      })
      .expect(200);
    await request(app).post(`/api/admin/tests/${id}/publish`).set(auth).expect(200);
    expect((await request(app).get("/api/exams/sbi-po/tests").expect(200)).body.tests).toEqual([]);
    const list = await request(app).get("/api/admin/tests").set(auth).expect(200);
    expect(list.body.tests[0]).toMatchObject({
      title: "Later",
      status: "published",
      isFree: false,
      questionCount: 100,
      expectedCount: 100,
    });
  });
});

describe("series", () => {
  it("only accepts tests from the same exam", async () => {
    const app = buildTestApp();
    const test = (await create(app).expect(201)).body.test.id as string;
    const created = await request(app)
      .post("/api/admin/series")
      .set(auth)
      .send({
        title: "SBI PO 2026 series",
        examKey: "sbi-po",
        tests: [{ testId: test, position: 1, isFree: true }],
      })
      .expect(201);
    expect(created.body.series.tests).toEqual([
      { testId: test, position: 1, isFree: true, releaseAt: null },
    ]);
    await request(app)
      .post("/api/admin/series")
      .set(auth)
      .send({ title: "Wrong", examKey: "ssc-cgl", tests: [{ testId: test, position: 1 }] })
      .expect(400);
  });
});

describe("splitByMix", () => {
  it("splits counts by largest remainder", () => {
    expect(splitByMix(35, { easy: 30, medium: 50, hard: 20 })).toEqual({
      easy: 11,
      medium: 17,
      hard: 7,
    });
    expect(splitByMix(30, { easy: 1, medium: 1, hard: 1 })).toEqual({
      easy: 10,
      medium: 10,
      hard: 10,
    });
    expect(splitByMix(1, { easy: 0, medium: 0, hard: 5 })).toEqual({ easy: 0, medium: 0, hard: 1 });
  });
});

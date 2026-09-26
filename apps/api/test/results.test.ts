import {
  AttemptModel,
  ExamTemplateModel,
  QuestionModel,
  QuestionStatsModel,
  TestModel,
  computeQuestionStats,
  rescoreTest,
  scoreSubmittedAttempt,
  toTemplateSnapshot,
} from "@mockprep/core";
import {
  attemptAnalysisSchema,
  attemptResultResponseSchema,
  bookmarkListResponseSchema,
  solutionsResponseSchema,
  type AnswerEntry,
} from "@mockprep/types";
import { Types } from "mongoose";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { makeQuestion, seed } from "./factories.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

const db = useTestDatabase();

const student = (n: number) =>
  new Types.ObjectId().toString().slice(0, 22) + String(n).padStart(2, "0");
const bearer = async (userId: string, role: "student" | "content" = "student") => ({
  Authorization: `Bearer ${await accessTokenFor(userId, role)}`,
});

let admin: { Authorization: string };
beforeEach(async () => {
  await seed();
  admin = await bearer(new Types.ObjectId().toString(), "content");
});

/**
 * Published test: section "Quantitative Aptitude" with 3 Algebra + 3 Geometry questions, section
 * "Reasoning Ability" with 3 Puzzles questions. Every key is option E (4). +1 / −0.25.
 */
async function publishedTest() {
  const template = await ExamTemplateModel.findOne({ key: "sbi-po-prelims" }).lean();
  if (!template) throw new Error("seed missing");
  const make = async (section: string, topic: string) =>
    (await makeQuestion({ section, topic })).id;
  const quant = [];
  for (const topic of ["Algebra", "Algebra", "Algebra", "Geometry", "Geometry", "Geometry"]) {
    quant.push(await make("Quantitative Aptitude", topic));
  }
  const reasoning = [];
  for (let i = 0; i < 3; i++) reasoning.push(await make("Reasoning Ability", "Puzzles"));
  const test = await TestModel.create({
    title: "Results mock",
    examKey: "sbi-po",
    type: "full",
    status: "published",
    publishedAt: new Date(),
    templateSnapshot: {
      ...toTemplateSnapshot(template),
      totalTimeSec: 600,
      sectionSwitching: "free",
      sections: [
        { name: "Quantitative Aptitude", count: 6, aliases: [] },
        { name: "Reasoning Ability", count: 3, aliases: [] },
      ],
    },
    sections: [
      { name: "Quantitative Aptitude", questionIds: quant },
      { name: "Reasoning Ability", questionIds: reasoning },
    ],
  });
  return { testId: test.id, quant, reasoning, all: [...quant, ...reasoning] };
}

const answer = (questionId: string, option: number): AnswerEntry => ({
  questionId,
  response: [option],
  state: "answered",
  timeMs: 20_000,
  at: Date.now(),
});

type App = ReturnType<typeof buildTestApp>;

/** Start → answer → submit (scored synchronously by the injected enqueuer). */
async function take(
  app: App,
  auth: { Authorization: string },
  testId: string,
  answers: AnswerEntry[],
) {
  const start = await request(app).post("/api/attempts").set(auth).send({ testId }).expect(201);
  const id = start.body.attempt.id as string;
  await request(app).post(`/api/attempts/${id}/submit`).set(auth).send({ answers }).expect(200);
  return id;
}

const appWithScoring = () =>
  buildTestApp({
    enqueueScore: async (id) => {
      await scoreSubmittedAttempt(id, db.redis());
    },
    enqueueRescore: async (testId) => {
      await rescoreTest(db.redis(), testId);
    },
  });

describe("rank and percentile", () => {
  it("ten students get distinct ranks and percentiles; re-attempts are not ranked", async () => {
    const app = appWithScoring();
    const { testId, all } = await publishedTest();
    const users = await Promise.all(Array.from({ length: 10 }, (_, n) => bearer(student(n))));
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      // Student n answers the first n questions right (student 9 all 9).
      ids.push(
        await take(
          app,
          users[n]!,
          testId,
          all.slice(0, n).map((q) => answer(q, 4)),
        ),
      );
    }
    const results = [];
    for (let n = 0; n < 10; n++) {
      const res = await request(app)
        .get(`/api/attempts/${ids[n]}/result`)
        .set(users[n]!)
        .expect(200);
      results.push(attemptResultResponseSchema.parse(res.body));
    }
    expect(results.map((r) => r.rank?.rank)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(results.map((r) => r.rank?.percentile)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(results.every((r) => r.rank?.total === 10)).toBe(true);

    // A re-attempt is practice: scored, not ranked, and doesn't change others' ranks.
    const again = await take(
      app,
      users[0]!,
      testId,
      all.map((q) => answer(q, 4)),
    );
    const second = attemptResultResponseSchema.parse(
      (await request(app).get(`/api/attempts/${again}/result`).set(users[0]!).expect(200)).body,
    );
    expect(second.result?.score).toBe(9);
    expect(second.rank).toBeNull();
    const top = await request(app).get(`/api/attempts/${ids[9]}/result`).set(users[9]!).expect(200);
    expect(top.body.rank).toMatchObject({ rank: 1, total: 10 });

    // The rank set is rebuilt from Mongo if Redis loses it.
    await db.redis().del(`rank:${testId}`);
    const rebuilt = await request(app)
      .get(`/api/attempts/${ids[4]}/result`)
      .set(users[4]!)
      .expect(200);
    expect(rebuilt.body.rank).toMatchObject({ rank: 6, total: 10, percentile: 40 });
  });
});

describe("analysis and solutions", () => {
  it("finds weak topics from deliberate wrong answers and compares with topper and average", async () => {
    const app = appWithScoring();
    const { testId, quant, reasoning, all } = await publishedTest();
    const topper = await bearer(student(1));
    await take(
      app,
      topper,
      testId,
      all.map((q) => answer(q, 4)),
    );
    const me = await bearer(student(2));
    // Algebra right, Geometry deliberately wrong, Puzzles right.
    const mine = await take(app, me, testId, [
      ...quant.slice(0, 3).map((q) => answer(q, 4)),
      ...quant.slice(3).map((q) => answer(q, 0)),
      ...reasoning.map((q) => answer(q, 4)),
    ]);
    await request(app)
      .put(`/api/admin/tests/${testId}/cutoffs`)
      .set(admin)
      .send({ overall: 7, sections: { "Quantitative Aptitude": 3 } })
      .expect(200);

    const res = await request(app).get(`/api/attempts/${mine}/analysis`).set(me).expect(200);
    const a = attemptAnalysisSchema.parse(res.body);
    expect(a).toMatchObject({ score: 5.25, maxScore: 9, rank: { rank: 2, total: 2 } });
    expect(a.weak).toEqual(["Geometry"]);
    expect(a.strong).toEqual(expect.arrayContaining(["Algebra", "Puzzles"]));
    expect(a.topics.find((t) => t.topic === "Geometry")).toMatchObject({
      total: 3,
      wrong: 3,
      accuracy: 0,
    });
    expect(a.sections[0]).toMatchObject({
      name: "Quantitative Aptitude",
      negativeMarks: 0.75,
      cutoff: 3,
    });
    expect(a.topper).toMatchObject({ score: 9 });
    expect(a.average).toMatchObject({ score: 7.13 });
    expect(a.cutoff).toEqual({ overall: 7, cleared: false });
    expect(a.advice).toMatch(/short of the expected cut-off/);
    expect(a.questions).toHaveLength(9);

    const sol = solutionsResponseSchema.parse(
      (await request(app).get(`/api/attempts/${mine}/solutions`).set(me).expect(200)).body,
    );
    expect(sol.items).toHaveLength(9);
    expect(sol.items[3]).toMatchObject({
      number: 4,
      section: "Quantitative Aptitude",
      correct: [4],
      yourResponse: [0],
      outcome: "wrong",
      marks: -0.25,
      correctPercent: 50,
      bookmarked: false,
    });
    // Other students can't read my solutions.
    await request(app).get(`/api/attempts/${mine}/solutions`).set(topper).expect(404);
  });

  it("gives no solutions before the attempt is scored", async () => {
    const app = buildTestApp({ enqueueScore: () => Promise.resolve() });
    const { testId } = await publishedTest();
    const me = await bearer(student(3));
    const start = await request(app).post("/api/attempts").set(me).send({ testId }).expect(201);
    await request(app).get(`/api/attempts/${start.body.attempt.id}/solutions`).set(me).expect(409);
    await request(app)
      .post(`/api/attempts/${start.body.attempt.id}/submit`)
      .set(me)
      .send({})
      .expect(200);
    await request(app).get(`/api/attempts/${start.body.attempt.id}/solutions`).set(me).expect(409);
    await request(app).get(`/api/attempts/${start.body.attempt.id}/analysis`).set(me).expect(409);
  });
});

describe("bookmarks and practice", () => {
  it("bookmarks only questions from finished tests; lists them with solutions", async () => {
    const app = appWithScoring();
    const { testId, all } = await publishedTest();
    const other = await publishedTest();
    const me = await bearer(student(4));
    const attemptId = await take(app, me, testId, [answer(all[0]!, 4)]);
    await request(app)
      .post("/api/bookmarks")
      .set(me)
      .send({ questionId: all[1], attemptId })
      .expect(201);
    await request(app)
      .post("/api/bookmarks")
      .set(me)
      .send({ questionId: all[1], attemptId })
      .expect(201);
    await request(app)
      .post("/api/bookmarks")
      .set(me)
      .send({ questionId: other.all[0] })
      .expect(404);
    const list = bookmarkListResponseSchema.parse(
      (await request(app).get("/api/bookmarks").set(me).expect(200)).body,
    );
    expect(list.bookmarks).toHaveLength(1);
    expect(list.bookmarks[0]).toMatchObject({
      questionId: all[1],
      attemptId,
      question: { correct: [4] },
    });
    const sol = await request(app).get(`/api/attempts/${attemptId}/solutions`).set(me).expect(200);
    expect(sol.body.items[1].bookmarked).toBe(true);
    await request(app).delete(`/api/bookmarks/${all[1]}`).set(me).expect(204);
    expect((await request(app).get("/api/bookmarks").set(me)).body.bookmarks).toHaveLength(0);
  });

  it("re-attempt wrong questions creates a private, unranked practice test", async () => {
    const app = appWithScoring();
    const { testId, all } = await publishedTest();
    const me = await bearer(student(5));
    const attemptId = await take(app, me, testId, [
      answer(all[0]!, 0),
      answer(all[1]!, 0),
      answer(all[2]!, 4),
    ]);
    const res = await request(app)
      .post(`/api/attempts/${attemptId}/practice`)
      .set(me)
      .send({})
      .expect(201);
    expect(res.body.questionCount).toBe(2);
    const withSkipped = await request(app)
      .post(`/api/attempts/${attemptId}/practice`)
      .set(me)
      .send({ include: "wrong_skipped" })
      .expect(201);
    expect(withSkipped.body.questionCount).toBe(8);

    // The practice attempt resumes like any attempt, with only the 2 wrong questions.
    const resumed = await request(app)
      .get(`/api/attempts/${res.body.attemptId}`)
      .set(me)
      .expect(200);
    expect(
      resumed.body.paper.sections.flatMap((s: { questions: unknown[] }) => s.questions),
    ).toHaveLength(2);
    // Private: not in the admin list, not startable by others, not public.
    const list = await request(app).get("/api/admin/tests").set(admin).expect(200);
    expect(list.body.tests.map((t: { id: string }) => t.id)).not.toContain(res.body.testId);
    await request(app)
      .post("/api/attempts")
      .set(await bearer(student(6)))
      .send({ testId: res.body.testId })
      .expect(404);
    await request(app).get(`/api/tests/${res.body.testId}`).expect(404);

    await request(app)
      .post(`/api/attempts/${res.body.attemptId}/submit`)
      .set(me)
      .send({ answers: [answer(all[0]!, 4), answer(all[1]!, 4)] })
      .expect(200);
    const result = await request(app)
      .get(`/api/attempts/${res.body.attemptId}/result`)
      .set(me)
      .expect(200);
    expect(result.body).toMatchObject({
      practice: true,
      rank: null,
      result: { score: 2, maxScore: 2 },
    });
    const mine = await request(app).get("/api/attempts").set(me).expect(200);
    expect(mine.body.attempts[0]).toMatchObject({
      practice: true,
      title: "Practice: Results mock",
    });
  });
});

describe("error reports", () => {
  it("3 reports pull a question from new attempts; the admin queue restores it", async () => {
    const app = appWithScoring();
    const { testId, all } = await publishedTest();
    const reporters = await Promise.all([7, 8, 9].map((n) => bearer(student(n))));
    for (const r of reporters) await take(app, r, testId, [answer(all[0]!, 4)]);
    const url = `/api/questions/${all[0]}/report`;
    const first = await request(app)
      .post(url)
      .set(reporters[0]!)
      .send({ reason: "wrong_answer", note: "Key should be A" });
    expect(first.status).toBe(201);
    expect(first.body.pulled).toBe(false);
    await request(app).post(url).set(reporters[0]!).send({ reason: "typo" }).expect(409);
    await request(app).post(url).set(reporters[1]!).send({ reason: "wrong_answer" }).expect(201);
    const third = await request(app)
      .post(url)
      .set(reporters[2]!)
      .send({ reason: "typo" })
      .expect(201);
    expect(third.body.pulled).toBe(true);
    const q = await QuestionModel.findById(all[0]).lean();
    expect(q).toMatchObject({ status: "draft", flags: expect.arrayContaining(["reported"]) });
    // Someone who never saw the question can't report it.
    await request(app)
      .post(url)
      .set(await bearer(student(10)))
      .send({ reason: "typo" })
      .expect(404);

    // New attempts leave it out and don't score it.
    const late = await bearer(student(11));
    const start = await request(app).post("/api/attempts").set(late).send({ testId }).expect(201);
    const paperIds = start.body.paper.sections.flatMap((s: { questions: { id: string }[] }) =>
      s.questions.map((x) => x.id),
    );
    expect(paperIds).not.toContain(all[0]);
    await request(app)
      .post(`/api/attempts/${start.body.attempt.id}/submit`)
      .set(late)
      .send({})
      .expect(200);
    const res = await request(app)
      .get(`/api/attempts/${start.body.attempt.id}/result`)
      .set(late)
      .expect(200);
    expect(res.body.result.maxScore).toBe(8);

    const queue = await request(app).get("/api/admin/reports").set(admin).expect(200);
    expect(queue.body.groups).toHaveLength(1);
    expect(queue.body.groups[0]).toMatchObject({
      questionId: all[0],
      count: 3,
      reasons: { wrong_answer: 2, typo: 1 },
      unpublished: true,
      notes: [{ note: "Key should be A", reason: "wrong_answer" }],
    });
    await request(app)
      .post(`/api/admin/reports/${all[0]}/resolve`)
      .set(admin)
      .send({ action: "dismiss" })
      .expect(200);
    const back = await QuestionModel.findById(all[0]).lean();
    expect(back?.status).toBe("approved");
    expect(back?.flags).not.toContain("reported");
    expect((await request(app).get("/api/admin/reports").set(admin)).body.groups).toHaveLength(0);
    const reviewer = await bearer(new Types.ObjectId().toString(), "student");
    await request(app).get("/api/admin/reports").set(reviewer).expect(403);
  });
});

describe("answer key change and re-score", () => {
  it("updates every attempt and the ranks", async () => {
    const app = appWithScoring();
    const { testId, all } = await publishedTest();
    const a = await bearer(student(12));
    const b = await bearer(student(13));
    const aId = await take(app, a, testId, [answer(all[0]!, 4), answer(all[1]!, 4)]); // 2
    const bId = await take(app, b, testId, [
      answer(all[0]!, 0),
      answer(all[1]!, 0),
      answer(all[2]!, 4),
    ]); // 0.5
    const rankOf = async (auth: { Authorization: string }, id: string) =>
      (await request(app).get(`/api/attempts/${id}/result`).set(auth).expect(200)).body as {
        rank: { rank: number };
        result: { score: number };
      };
    expect((await rankOf(a, aId)).rank.rank).toBe(1);

    // The key of Q1 and Q2 was wrong: it is A (0).
    const res = await request(app)
      .put(`/api/admin/tests/${testId}/answer-key`)
      .set(admin)
      .send({
        changes: [
          { questionId: all[0], correct: [0] },
          { questionId: all[1], correct: [0] },
        ],
      })
      .expect(200);
    expect(res.body).toEqual({ queued: true, attempts: 2 });
    const after = { a: await rankOf(a, aId), b: await rankOf(b, bId) };
    expect(after.a.result.score).toBe(-0.5);
    expect(after.b.result.score).toBe(3);
    expect(after.b.rank.rank).toBe(1);
    expect(after.a.rank.rank).toBe(2);
    expect((await QuestionModel.findById(all[0]).lean())?.answerSource).toBe("manual");

    await request(app)
      .put(`/api/admin/tests/${testId}/answer-key`)
      .set(admin)
      .send({ changes: [{ questionId: all[0], correct: [9] }] })
      .expect(400);
    await request(app)
      .put(`/api/admin/tests/${testId}/answer-key`)
      .set(admin)
      .send({ changes: [{ questionId: new Types.ObjectId().toString(), correct: [0] }] })
      .expect(400);
    await request(app).post(`/api/admin/tests/${testId}/rescore`).set(admin).expect(200);
  });
});

describe("question stats", () => {
  it("computes accuracy, option split, discrimination and flags a suspect key", async () => {
    const { testId, all } = await publishedTest();
    const q = all[0]!;
    // 30 scored first attempts: most choose B (1) while the key is E (4).
    const docs = Array.from({ length: 30 }, (_, n) => {
      const right = n < 4; // top scorers got it right
      return {
        userId: new Types.ObjectId(),
        testId,
        status: "scored",
        firstAttempt: true,
        startedAt: new Date(),
        deadline: new Date(),
        answers: [
          { questionId: q, response: [right ? 4 : 1], state: "answered", timeMs: 1000, at: 1 },
        ],
        outcomes: [
          {
            questionId: q,
            outcome: right ? "correct" : "wrong",
            marks: right ? 1 : -0.25,
            timeMs: 1000 + n,
          },
        ],
        result: {
          score: 30 - n,
          maxScore: 9,
          correct: 0,
          wrong: 0,
          partial: 0,
          skipped: 0,
          accuracy: 0,
          timeTakenSec: 1,
          qualifying: null,
          sections: [],
        },
      };
    });
    await AttemptModel.insertMany(docs);
    const summary = await computeQuestionStats();
    expect(summary).toMatchObject({ questions: 1, flagged: 1 });
    const stats = await QuestionStatsModel.findOne({ questionId: q }).lean();
    expect(stats).toMatchObject({
      attempts: 30,
      correct: 4,
      accuracy: 13.33,
      optionSplit: [0, 26, 0, 0, 4],
    });
    expect(stats?.discrimination).toBe(0.5);
    expect((await QuestionModel.findById(q).lean())?.flags).toContain("suspect_key");

    const app = buildTestApp();
    const res = await request(app).get(`/api/admin/questions/${q}/stats`).set(admin).expect(200);
    expect(res.body.stats).toMatchObject({ attempts: 30, accuracy: 13.33 });
  });
});

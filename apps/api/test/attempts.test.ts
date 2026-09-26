import {
  AttemptModel,
  ExamTemplateModel,
  TestModel,
  flushDirtyAttempts,
  scoreSubmittedAttempt,
  toTemplateSnapshot,
} from "@mockprep/core";
import {
  attemptResultResponseSchema,
  attemptStartResponseSchema,
  type AnswerEntry,
} from "@mockprep/types";
import { startWorkers, type WorkerRuntime } from "@mockprep/worker/runtime";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeQuestion, seed } from "./factories.js";
import { accessTokenFor, buildTestApp, silentLogger, useTestDatabase } from "./helpers.js";

const db = useTestDatabase();

const STUDENT = "64b0000000000000000000c1";
let auth: { Authorization: string };
let other: { Authorization: string };

beforeEach(async () => {
  await seed();
  auth = { Authorization: `Bearer ${await accessTokenFor(STUDENT, "student")}` };
  other = {
    Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000c2", "student")}`,
  };
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A published 2-section SBI-style test: 2 questions per section, answer E (index 4) everywhere,
 * +1 / -0.25. `locked` gives each section 60 s (locked_sequential).
 */
async function publishedTest({ locked = false, isFree = true } = {}) {
  const template = await ExamTemplateModel.findOne({ key: "sbi-po-prelims" }).lean();
  if (!template) throw new Error("seed missing");
  const snapshot = toTemplateSnapshot(template);
  const qs = [];
  for (let i = 0; i < 4; i++) qs.push(await makeQuestion());
  const sections = [
    { name: "English Language", timeSec: 60, questionIds: [qs[0]!._id, qs[1]!._id] },
    { name: "Quantitative Aptitude", timeSec: 60, questionIds: [qs[2]!._id, qs[3]!._id] },
  ];
  const test = await TestModel.create({
    title: "Mini mock",
    examKey: "sbi-po",
    type: "full",
    isFree,
    status: "published",
    publishedAt: new Date(),
    templateSnapshot: {
      ...snapshot,
      totalTimeSec: 120,
      sectionSwitching: locked ? "locked_sequential" : "free",
      sections: sections.map((s) => ({ name: s.name, count: 2, timeSec: 60, aliases: [] })),
    },
    sections: locked ? sections : sections.map(({ timeSec: _t, ...s }) => s),
  });
  return { test, ids: qs.map((q) => q.id) };
}

const entry = (
  questionId: string,
  response: AnswerEntry["response"],
  at = Date.now(),
): AnswerEntry => ({
  questionId,
  response,
  state: "answered",
  timeMs: 5000,
  at,
});

type App = ReturnType<typeof buildTestApp>;
async function start(app: App, testId: string, status = 201) {
  const res = await request(app).post("/api/attempts").set(auth).send({ testId }).expect(status);
  return attemptStartResponseSchema.parse(res.body);
}

describe("attempts", () => {
  it("starts with a paper that has no answers, and resumes the same attempt", async () => {
    const app = buildTestApp();
    const { test, ids } = await publishedTest();
    const first = await start(app, test.id);
    expect(first.attempt).toMatchObject({
      status: "in_progress",
      sectionIndex: 0,
      sectionDeadline: null,
      answers: [],
    });
    const total =
      new Date(first.attempt.deadline).getTime() - new Date(first.attempt.startedAt).getTime();
    expect(total).toBe(120_000);
    expect(first.paper.sections.flatMap((s) => s.questions.map((q) => q.id))).toEqual(ids);
    const raw = JSON.stringify(first.paper.sections);
    expect(raw).not.toMatch(/"correct"|"numAnswer"|"solution"|"answerSource"/);

    const again = await start(app, test.id, 200);
    expect(again.attempt.id).toBe(first.attempt.id);
    const resumed = await request(app)
      .get(`/api/attempts/${first.attempt.id}`)
      .set(auth)
      .expect(200);
    expect(resumed.body.attempt.id).toBe(first.attempt.id);
    // Only the owner sees it.
    await request(app).get(`/api/attempts/${first.attempt.id}`).set(other).expect(404);
    // Students only: admins can't take tests with an admin token.
    const admin = { Authorization: `Bearer ${await accessTokenFor(STUDENT, "content")}` };
    await request(app).post("/api/attempts").set(admin).send({ testId: test.id }).expect(403);
  });

  it("shows public test details (no questions) for the instruction screen", async () => {
    const app = buildTestApp();
    const { test } = await publishedTest({ locked: true });
    const res = await request(app).get(`/api/tests/${test.id}`).expect(200);
    expect(res.body).toMatchObject({
      title: "Mini mock",
      questionCount: 4,
      template: {
        skin: "ibps",
        sectionSwitching: "locked_sequential",
        marking: { correct: 1, wrong: -0.25 },
      },
      sections: [
        { name: "English Language", questionCount: 2, timeSec: 60 },
        { name: "Quantitative Aptitude", questionCount: 2, timeSec: 60 },
      ],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/questionIds|"stem"/);
    await TestModel.updateOne({ _id: test._id }, { status: "draft" });
    await request(app).get(`/api/tests/${test.id}`).expect(404);
  });

  it("refuses unpublished tests", async () => {
    const app = buildTestApp();
    const { test } = await publishedTest();
    await TestModel.updateOne({ _id: test._id }, { status: "draft" });
    await request(app).post("/api/attempts").set(auth).send({ testId: test.id }).expect(404);
  });

  it("saves batched answers; the latest client change wins", async () => {
    const app = buildTestApp();
    const { test, ids } = await publishedTest();
    const { attempt } = await start(app, test.id);
    const url = `/api/attempts/${attempt.id}/answers`;
    const now = Date.now();
    const res = await request(app)
      .patch(url)
      .set(auth)
      .send({
        answers: [entry(ids[0]!, [4], now), entry(ids[1]!, [1], now), entry(ids[0]!, [2], now - 5)],
      })
      .expect(200);
    expect(res.body).toMatchObject({ saved: 2, status: "in_progress" });
    // An older copy (e.g. from another tab / the device's queue) does not overwrite a newer one.
    await request(app)
      .patch(url)
      .set(auth)
      .send({ answers: [entry(ids[0]!, [0], now - 1000)] })
      .expect(200);
    const state = await request(app).get(`/api/attempts/${attempt.id}`).set(auth).expect(200);
    const byId = Object.fromEntries(
      (state.body.attempt.answers as AnswerEntry[]).map((a) => [a.questionId, a.response]),
    );
    expect(byId).toEqual({ [ids[0]!]: [4], [ids[1]!]: [1] });

    await request(app)
      .patch(url)
      .set(auth)
      .send({ answers: [entry("64b0000000000000000000ff", [1])] })
      .expect(400);
    await request(app).patch(url).set(other).send({ answers: [] }).expect(404);

    // The worker's flush copies them to Mongo.
    await flushDirtyAttempts(db.redis());
    const doc = await AttemptModel.findById(attempt.id).lean();
    expect(doc?.answers.map((a) => a.response)).toEqual(expect.arrayContaining([[4], [1]]));
  });

  it("locks sections on their timers and accepts answers made before a section ended", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-26T10:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    const app = buildTestApp();
    const { test, ids } = await publishedTest({ locked: true });
    const { attempt } = await start(app, test.id);
    expect(attempt).toMatchObject({
      sectionIndex: 0,
      sectionDeadline: new Date(t0 + 60_000).toISOString(),
    });
    const url = `/api/attempts/${attempt.id}/answers`;

    // Section 2 can't be answered yet.
    const early = await request(app)
      .patch(url)
      .set(auth)
      .send({ answers: [entry(ids[2]!, [4])] })
      .expect(200);
    expect(early.body.saved).toBe(0);

    // Section 1's timer runs out: section 2 opens.
    vi.setSystemTime(t0 + 61_000);
    const res = await request(app)
      .patch(url)
      .set(auth)
      .send({
        answers: [
          entry(ids[0]!, [4], t0 + 30_000), // made offline before section 1 ended: kept
          entry(ids[1]!, [4], t0 + 75_000), // after section 1 ended: dropped
          entry(ids[2]!, [4], t0 + 61_000),
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({
      saved: 2,
      sectionIndex: 1,
      sectionDeadline: new Date(t0 + 120_000).toISOString(),
    });
    await request(app).post(`/api/attempts/${attempt.id}/next-section`).set(auth).expect(409);
  });

  it("finishing a section early starts the next one's full timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-26T10:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    const app = buildTestApp();
    const { test } = await publishedTest({ locked: true });
    const { attempt } = await start(app, test.id);
    vi.setSystemTime(t0 + 20_000);
    const res = await request(app)
      .post(`/api/attempts/${attempt.id}/next-section`)
      .set(auth)
      .expect(200);
    expect(res.body).toMatchObject({
      sectionIndex: 1,
      sectionDeadline: new Date(t0 + 80_000).toISOString(),
    });
  });

  it("submits with the final answers and scores with negative marking", async () => {
    const scored: string[] = [];
    const app = buildTestApp({
      enqueueScore: async (id) => {
        scored.push(id);
        await scoreSubmittedAttempt(id);
      },
    });
    const { test, ids } = await publishedTest();
    const { attempt } = await start(app, test.id);
    await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[0]!, [4]), entry(ids[1]!, [0])] })
      .expect(200);
    // Q3 answered in the last seconds, sent with submit; Q4 only marked for review (not evaluated).
    const submit = await request(app)
      .post(`/api/attempts/${attempt.id}/submit`)
      .set(auth)
      .send({ answers: [entry(ids[2]!, [4]), { ...entry(ids[3]!, [4]), state: "marked" }] })
      .expect(200);
    expect(submit.body.status).toBe("submitted");
    expect(scored).toEqual([attempt.id]);

    const result = attemptResultResponseSchema.parse(
      (await request(app).get(`/api/attempts/${attempt.id}/result`).set(auth).expect(200)).body,
    );
    expect(result).toMatchObject({ status: "scored", submitReason: "manual", title: "Mini mock" });
    expect(result.result).toMatchObject({
      score: 1.75,
      maxScore: 4,
      correct: 2,
      wrong: 1,
      skipped: 1,
    });
    expect(result.result?.sections.map((s) => s.score)).toEqual([0.75, 1]);

    // Saving or submitting again is refused / a no-op.
    await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[0]!, [1])] })
      .expect(409);
    await request(app).post(`/api/attempts/${attempt.id}/submit`).set(auth).send({}).expect(200);
    expect(scored).toHaveLength(1);
    // A new attempt can be started afterwards.
    const next = await start(app, test.id);
    expect(next.attempt.id).not.toBe(attempt.id);
    const mine = await request(app).get(`/api/attempts?testId=${test.id}`).set(auth).expect(200);
    expect(mine.body.attempts).toHaveLength(2);
  });

  it("refuses saves after the deadline and auto-submits on the next visit", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-09-26T10:00:00.000Z").getTime();
    vi.setSystemTime(t0);
    const scored: string[] = [];
    const app = buildTestApp({ enqueueScore: (id) => (scored.push(id), Promise.resolve()) });
    const { test, ids } = await publishedTest();
    const { attempt } = await start(app, test.id);
    await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[0]!, [4])] });

    vi.setSystemTime(t0 + 120_000 + 5_000); // inside the 10 s grace
    await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[1]!, [4])] })
      .expect(200);
    vi.setSystemTime(t0 + 120_000 + 11_000);
    const late = await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[2]!, [4])] });
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("Time is up");

    const state = await request(app).get(`/api/attempts/${attempt.id}`).set(auth).expect(200);
    expect(state.body.attempt.status).toBe("submitted");
    expect(scored).toEqual([attempt.id]);
    const doc = await AttemptModel.findById(attempt.id).lean();
    expect(doc).toMatchObject({ status: "submitted", submitReason: "timeout" });
    expect(doc?.answers).toHaveLength(2);
    expect(doc?.submittedAt?.getTime()).toBe(t0 + 120_000);
  });
});

describe("worker jobs", () => {
  let runtime: WorkerRuntime | undefined;
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it("scores submitted attempts from the queue and flushes answers to Mongo", async () => {
    runtime = await startWorkers({
      redisUrl: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      logger: silentLogger,
      concurrency: 1,
      source: "test",
      attempts: { housekeepingEveryMs: 200 },
    });
    const app = buildTestApp();
    const { test, ids } = await publishedTest();
    const { attempt } = await start(app, test.id);
    await request(app)
      .patch(`/api/attempts/${attempt.id}/answers`)
      .set(auth)
      .send({ answers: [entry(ids[0]!, [4])] })
      .expect(200);
    for (let i = 0; i < 50; i++) {
      const doc = await AttemptModel.findById(attempt.id).lean();
      if (doc?.answers.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await AttemptModel.findById(attempt.id).lean())?.answers).toHaveLength(1);

    await request(app).post(`/api/attempts/${attempt.id}/submit`).set(auth).send({}).expect(200);
    let body: { status?: string; result?: { score: number } | null } = {};
    for (let i = 0; i < 50 && body.status !== "scored"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      body = (await request(app).get(`/api/attempts/${attempt.id}/result`).set(auth))
        .body as typeof body;
    }
    expect(body).toMatchObject({ status: "scored", result: { score: 1 } });
  });
});

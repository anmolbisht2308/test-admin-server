import {
  ANSWER_GRACE_MS,
  AttemptModel,
  BookmarkModel,
  QuestionModel,
  buildAnalysis,
  correctPercentByQuestion,
  getRank,
  testBenchmarks,
  TestModel,
  advanceSection,
  canSaveAnswer,
  finishSection,
  initialTiming,
  loadMeta,
  mergeAnswers,
  metaFor,
  readAnswers,
  submitAttempt,
  writeMeta,
  type AttemptMeta,
} from "@mockprep/core";
import {
  practiceInputSchema,
  type AttemptAnalysis,
  type PracticeResponse,
  type SolutionsResponse,
  answerBatchInputSchema,
  attemptStartInputSchema,
  attemptSubmitInputSchema,
  objectIdSchema,
  type AnswerSaveResponse,
  type AttemptClock,
  type AttemptResultResponse,
  type MyAttemptListResponse,
} from "@mockprep/types";
import { Router, type Response } from "express";
import type { Redis } from "ioredis";
import { Types } from "mongoose";
import type { AppContext } from "../context.js";
import { HttpError, conflictError, notFoundError } from "../lib/httpError.js";
import { toStudentPaper } from "../lib/studentPaper.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getAuth, requireAuth, requireRole } from "../middleware/auth.js";
import type { EnqueueScore } from "../services/scoreQueue.js";

const PAPER_TTL_SEC = 24 * 3600;

const clock = (meta: AttemptMeta, now = Date.now()): AttemptClock => ({
  status: meta.status,
  serverNow: new Date(now).toISOString(),
  deadline: new Date(meta.deadline).toISOString(),
  sectionIndex: meta.sectionIndex,
  sectionDeadline:
    meta.sectionDeadline === null ? null : new Date(meta.sectionDeadline).toISOString(),
});

/**
 * The student paper for a test as a JSON string, built once per test version and cached in Redis
 * (it never contains answers: built only by toStudentPaper).
 */
async function paperJson(redis: Redis, testId: string): Promise<string> {
  const test = await TestModel.findById(testId);
  if (!test) throw notFoundError("Test");
  const key = `paper:${testId}:${test.updatedAt.getTime()}`;
  const cached = await redis.get(key);
  if (cached) return cached;
  const ids = test.sections.flatMap((s) => s.questionIds);
  // Questions pulled for review (3+ error reports) are left out of new papers.
  const questions = new Map(
    (await QuestionModel.find({ _id: { $in: ids }, flags: { $ne: "reported" } }).lean()).map(
      (q) => [q._id.toString(), q],
    ),
  );
  const json = JSON.stringify(toStudentPaper(test, questions));
  await redis.set(key, json, "EX", PAPER_TTL_SEC);
  return json;
}

/** Free tests are open to every student. */
function canAccess(_userId: string, test: { isFree: boolean }): boolean {
  if (test.isFree) return true;
  // TODO(phase 7): check the student's purchases (entitlement stub: allowed for now).
  return true;
}

/** /api/attempts — a student taking a test. */
export function attemptsRouter(ctx: AppContext, enqueueScore: EnqueueScore): Router {
  const router = Router();
  const { redis } = ctx;
  router.use(requireAuth(ctx.tokens), requireRole("student"));

  /** The attempt's meta, 404 unless it belongs to the caller. Locked sections advance here. */
  async function ownMeta(id: unknown, userId: string) {
    const parsed = objectIdSchema.safeParse(id);
    if (!parsed.success) throw notFoundError("Attempt");
    const meta = await loadMeta(redis, parsed.data);
    if (!meta || meta.userId !== userId) throw notFoundError("Attempt");
    if (meta.status === "in_progress" && advanceSection(meta, Date.now())) {
      await writeMeta(redis, parsed.data, meta);
    }
    return { id: parsed.data, meta };
  }

  /** Time is up: submit on the student's behalf. */
  async function expireIfOverdue(id: string, meta: AttemptMeta) {
    if (meta.status !== "in_progress" || Date.now() <= meta.deadline + ANSWER_GRACE_MS) return meta;
    if (await submitAttempt(redis, id, "timeout")) await enqueueScore(id);
    return { ...meta, status: "submitted" as const };
  }

  async function sendAttempt(res: Response, id: string, meta: AttemptMeta, status = 200) {
    const answers = meta.status === "in_progress" ? await readAnswers(redis, id) : [];
    const attempt = {
      ...clock(meta),
      id,
      testId: meta.testId,
      startedAt: new Date(meta.startedAt).toISOString(),
      answers,
    };
    // The cached paper string is spliced in as is (no re-serialising on every resume).
    res
      .status(status)
      .set("Cache-Control", "no-store")
      .type("json")
      .send(
        `{"attempt":${JSON.stringify(attempt)},"paper":${await paperJson(redis, meta.testId)}}`,
      );
  }

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const testId = objectIdSchema.optional().parse(req.query.testId);
      const docs = await AttemptModel.find({
        userId: getAuth(req).userId,
        ...(testId ? { testId } : {}),
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .select({ testId: 1, status: 1, startedAt: 1, submittedAt: 1, result: 1, practice: 1 })
        .lean();
      const titles = new Map(
        (
          await TestModel.find({ _id: { $in: [...new Set(docs.map((a) => a.testId.toString()))] } })
            .select({ title: 1 })
            .lean()
        ).map((t) => [t._id.toString(), t.title]),
      );
      const body: MyAttemptListResponse = {
        attempts: docs.map((a) => ({
          id: a._id.toString(),
          testId: a.testId.toString(),
          title: titles.get(a.testId.toString()) ?? "Test",
          practice: a.practice,
          status: a.status,
          startedAt: a.startedAt.toISOString(),
          submittedAt: a.submittedAt ? a.submittedAt.toISOString() : null,
          score: a.result?.score ?? null,
          maxScore: a.result?.maxScore ?? null,
        })),
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  type TestDoc = NonNullable<Awaited<ReturnType<typeof loadTest>>>;
  const loadTest = (testId: string) => TestModel.findById(testId).lean();

  /** Starts (or resumes) the student's attempt of a test; sends the attempt + paper. */
  async function startAttempt(res: Response, userId: string, test: TestDoc) {
    const testId = test._id.toString();
    // Resume the attempt in progress, if any (after auto-submitting it if its time is up).
    const current = await AttemptModel.findOne({ userId, testId, status: "in_progress" })
      .select({ _id: 1 })
      .lean();
    if (current) {
      const id = current._id.toString();
      const meta = await expireIfOverdue(id, (await loadMeta(redis, id)) as AttemptMeta);
      if (meta.status === "in_progress") return sendAttempt(res, id, meta);
    }

    const practice = test.status === "practice";
    const [earlier, reported] = await Promise.all([
      AttemptModel.exists({ userId, testId }),
      QuestionModel.find({
        _id: { $in: test.sections.flatMap((s) => s.questionIds) },
        flags: "reported",
      })
        .select({ _id: 1 })
        .lean(),
    ]);
    const now = Date.now();
    const timing = initialTiming(test, now);
    let doc;
    try {
      doc = await AttemptModel.create({
        userId,
        testId,
        practice,
        // Only a student's first attempt of a real test is ranked; later ones are practice.
        firstAttempt: !practice && !earlier,
        excluded: reported.map((q) => q._id),
        startedAt: new Date(now),
        deadline: new Date(timing.deadline),
        sectionIndex: 0,
        sectionDeadline: timing.sectionDeadline === null ? null : new Date(timing.sectionDeadline),
      });
    } catch (err) {
      // A double click started it twice: return the one that won.
      if ((err as { code?: number }).code !== 11000) throw err;
      const winner = await AttemptModel.findOne({ userId, testId, status: "in_progress" }).lean();
      if (!winner) throw err;
      const id = winner._id.toString();
      return sendAttempt(res, id, (await loadMeta(redis, id)) as AttemptMeta);
    }
    const meta = metaFor(doc, test);
    await writeMeta(redis, doc.id, meta);
    return sendAttempt(res, doc.id, meta, 201);
  }

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const { testId } = attemptStartInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      const test = await loadTest(testId);
      const visible =
        (test?.status === "published" && (!test.publishAt || test.publishAt <= new Date())) ||
        (test?.status === "practice" && test.ownerId?.toString() === userId);
      if (!test || !visible) throw notFoundError("Test");
      if (!canAccess(userId, test)) throw new HttpError(403, "Buy this test to take it");
      await startAttempt(res, userId, test);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const { id, meta } = await ownMeta(req.params.id, getAuth(req).userId);
      await sendAttempt(res, id, await expireIfOverdue(id, meta));
    }),
  );

  router.patch(
    "/:id/answers",
    asyncHandler(async (req, res) => {
      const { answers } = answerBatchInputSchema.parse(req.body);
      const { id, meta } = await ownMeta(req.params.id, getAuth(req).userId);
      if (meta.status !== "in_progress")
        throw conflictError("This test has already been submitted");
      if (Date.now() > meta.deadline + ANSWER_GRACE_MS) throw conflictError("Time is up");
      const unknown = answers.filter((a) => meta.sectionOf[a.questionId] === undefined);
      if (unknown.length) {
        throw new HttpError(400, "Some questions are not in this test", {
          questionIds: unknown.map((a) => a.questionId),
        });
      }
      // Answers for sections that are locked (finished, or not started yet) are dropped.
      const saved = await mergeAnswers(
        redis,
        id,
        answers.filter((a) => canSaveAnswer(meta, a)),
      );
      const body: AnswerSaveResponse = { ...clock(meta), saved };
      res.json(body);
    }),
  );

  router.post(
    "/:id/next-section",
    asyncHandler(async (req, res) => {
      const { id, meta } = await ownMeta(req.params.id, getAuth(req).userId);
      if (meta.status !== "in_progress")
        throw conflictError("This test has already been submitted");
      if (!finishSection(meta, Date.now())) throw conflictError("There is no next section");
      await writeMeta(redis, id, meta);
      res.json(clock(meta));
    }),
  );

  router.post(
    "/:id/submit",
    asyncHandler(async (req, res) => {
      const { answers } = attemptSubmitInputSchema.parse(req.body ?? {});
      const userId = getAuth(req).userId;
      const { id, meta } = await ownMeta(req.params.id, userId);
      if (meta.status === "in_progress") {
        // The screen submits by itself when the clock hits zero: that (or later) is a timeout.
        const timedOut = Date.now() >= meta.deadline - 2000;
        const ok = await submitAttempt(
          redis,
          id,
          timedOut ? "timeout" : "manual",
          answers.filter((a) => canSaveAnswer(meta, a)),
        );
        if (ok) await enqueueScore(id);
      }
      res.json(clock({ ...meta, status: meta.status === "scored" ? "scored" : "submitted" }));
    }),
  );

  router.get(
    "/:id/result",
    asyncHandler(async (req, res) => {
      const parsed = objectIdSchema.safeParse(req.params.id);
      if (!parsed.success) throw notFoundError("Attempt");
      const attempt = await AttemptModel.findOne({
        _id: new Types.ObjectId(parsed.data),
        userId: getAuth(req).userId,
      }).lean();
      if (!attempt) throw notFoundError("Attempt");
      const test = await TestModel.findById(attempt.testId).select({ title: 1 }).lean();
      const body: AttemptResultResponse = {
        id: attempt._id.toString(),
        testId: attempt.testId.toString(),
        title: test?.title ?? "Test",
        status: attempt.status,
        submitReason: attempt.submitReason,
        startedAt: attempt.startedAt.toISOString(),
        submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
        // TODO(phase 6): solutions, per-question review, rank and percentile.
        result: attempt.status === "scored" ? attempt.result : null,
        rank:
          attempt.status === "scored" && attempt.firstAttempt && !attempt.practice
            ? await getRank(redis, attempt.testId.toString(), attempt._id.toString())
            : null,
        practice: attempt.practice,
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  /** A scored attempt of the caller (analysis, solutions, practice). */
  async function scoredAttempt(id: unknown, userId: string) {
    const parsed = objectIdSchema.safeParse(id);
    if (!parsed.success) throw notFoundError("Attempt");
    const attempt = await AttemptModel.findOne({ _id: parsed.data, userId }).lean();
    if (!attempt) throw notFoundError("Attempt");
    if (attempt.status !== "scored") throw conflictError("Your result is still being calculated");
    const test = await TestModel.findById(attempt.testId).lean();
    if (!test) throw notFoundError("Test");
    return { attempt, test };
  }

  /** Cached for a minute per test: topper, average and per-question correct %. */
  async function cachedJson<T>(key: string, build: () => Promise<T>): Promise<T> {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
    const value = await build();
    await redis.set(key, JSON.stringify(value), "EX", 60);
    return value;
  }

  router.get(
    "/:id/analysis",
    asyncHandler(async (req, res) => {
      const { attempt, test } = await scoredAttempt(req.params.id, getAuth(req).userId);
      if (!attempt.result) throw conflictError("Your result is still being calculated");
      const excluded = new Set(attempt.excluded.map(String));
      const sections = test.sections.map((s) => ({
        name: s.name,
        questionIds: s.questionIds.map(String).filter((id) => !excluded.has(id)),
      }));
      const questions = new Map(
        (
          await QuestionModel.find({ _id: { $in: sections.flatMap((s) => s.questionIds) } })
            .select({ topic: 1, subject: 1, type: 1 })
            .lean()
        ).map((q) => [q._id.toString(), q]),
      );
      const ranked = attempt.firstAttempt && !attempt.practice;
      const benchmarks = attempt.practice
        ? { topper: null, average: null }
        : await cachedJson(`bench:${test._id.toString()}`, () =>
            testBenchmarks(test._id.toString()),
          );
      const body: AttemptAnalysis = buildAnalysis({
        attemptId: attempt._id.toString(),
        title: test.title,
        practice: attempt.practice,
        result: attempt.result,
        outcomes: attempt.outcomes.map((o) => ({ ...o, questionId: o.questionId.toString() })),
        sections,
        questions,
        cutoffs: test.cutoffs ?? { overall: null, sections: {} },
        rank: ranked ? await getRank(redis, test._id.toString(), attempt._id.toString()) : null,
        topper: benchmarks.topper,
        average: benchmarks.average,
      });
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.get(
    "/:id/solutions",
    asyncHandler(async (req, res) => {
      const userId = getAuth(req).userId;
      const { attempt, test } = await scoredAttempt(req.params.id, userId);
      const excluded = new Set(attempt.excluded.map(String));
      const ids = test.sections
        .flatMap((s) => s.questionIds)
        .filter((id) => !excluded.has(id.toString()));
      const [questions, bookmarks, percents] = await Promise.all([
        QuestionModel.find({ _id: { $in: ids } }).lean(),
        BookmarkModel.find({ userId, questionId: { $in: ids } })
          .select({ questionId: 1 })
          .lean(),
        attempt.practice
          ? Promise.resolve({} as Record<string, number>)
          : cachedJson(`correct:${test._id.toString()}`, async () =>
              Object.fromEntries(await correctPercentByQuestion(test._id.toString())),
            ),
      ]);
      const byId = new Map(questions.map((q) => [q._id.toString(), q]));
      const marked = new Set(bookmarks.map((b) => b.questionId.toString()));
      const answers = new Map(attempt.answers.map((a) => [a.questionId.toString(), a]));
      const outcomes = new Map(attempt.outcomes.map((o) => [o.questionId.toString(), o]));
      const body: SolutionsResponse = {
        attemptId: attempt._id.toString(),
        title: test.title,
        items: test.sections.flatMap((s) =>
          s.questionIds.flatMap((qid, i) => {
            const id = qid.toString();
            const q = byId.get(id);
            if (!q || excluded.has(id)) return [];
            const a = answers.get(id);
            const o = outcomes.get(id);
            return [
              {
                questionId: id,
                number: i + 1,
                section: s.name,
                type: q.type,
                passage: q.passage,
                passageHi: q.passageHi,
                stem: q.stem,
                stemHi: q.stemHi,
                options: [...q.options],
                optionsHi: [...q.optionsHi],
                figureUrl: q.figureUrl ?? null,
                correct: [...q.correct],
                numAnswer: q.numAnswer ?? null,
                solution: q.solution,
                solutionHi: q.solutionHi,
                topic: q.topic,
                yourResponse: a?.response ?? null,
                state: a?.state ?? "not_visited",
                outcome: o?.outcome ?? "skipped",
                marks: o?.marks ?? 0,
                timeMs: o?.timeMs ?? a?.timeMs ?? 0,
                correctPercent: percents[id] ?? null,
                bookmarked: marked.has(id),
              },
            ];
          }),
        ),
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.post(
    "/:id/practice",
    asyncHandler(async (req, res) => {
      const { include } = practiceInputSchema.parse(req.body ?? {});
      const userId = getAuth(req).userId;
      const { attempt, test } = await scoredAttempt(req.params.id, userId);
      const wanted = new Set(
        attempt.outcomes
          .filter(
            (o) =>
              o.outcome === "wrong" ||
              o.outcome === "partial" ||
              (include === "wrong_skipped" && o.outcome === "skipped"),
          )
          .map((o) => o.questionId.toString()),
      );
      if (wanted.size === 0)
        throw conflictError("Nothing to practise: no wrong answers in this attempt");
      const snapshot = test.templateSnapshot;
      const total = test.sections.reduce((a, s) => a + s.questionIds.length, 0) || 1;
      const sections = test.sections
        .map((s) => ({
          name: s.name,
          questionIds: s.questionIds.filter((q) => wanted.has(q.toString())),
        }))
        .filter((s) => s.questionIds.length > 0);
      const practice = await TestModel.create({
        title: `Practice: ${test.title}`.slice(0, 160),
        examKey: test.examKey,
        type: "quiz",
        status: "practice",
        isFree: true,
        ownerId: userId,
        sourceAttemptId: attempt._id,
        // Same marking; free section switching and time in proportion to the questions.
        templateSnapshot: {
          ...snapshot,
          sectionSwitching: "free",
          totalTimeSec: Math.max(60, Math.round((snapshot.totalTimeSec * wanted.size) / total)),
          sections: sections.map((s) => {
            const t = snapshot.sections.find((x) => x.name === s.name);
            return { name: s.name, count: s.questionIds.length, aliases: t?.aliases ?? [] };
          }),
        },
        sections,
      });
      const created = await AttemptModel.create({
        userId,
        testId: practice._id,
        practice: true,
        firstAttempt: false,
        startedAt: new Date(),
        deadline: new Date(Date.now() + practice.templateSnapshot.totalTimeSec * 1000),
      });
      await writeMeta(redis, created.id as string, metaFor(created, practice));
      const body: PracticeResponse = {
        testId: practice.id as string,
        attemptId: created.id as string,
        questionCount: wanted.size,
      };
      res.status(201).json(body);
    }),
  );

  return router;
}

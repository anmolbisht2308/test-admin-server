import {
  ANSWER_GRACE_MS,
  AttemptModel,
  QuestionModel,
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
  const questions = new Map(
    (await QuestionModel.find({ _id: { $in: ids } }).lean()).map((q) => [q._id.toString(), q]),
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
        .select({ testId: 1, status: 1, startedAt: 1, submittedAt: 1, result: 1 })
        .lean();
      const body: MyAttemptListResponse = {
        attempts: docs.map((a) => ({
          id: a._id.toString(),
          testId: a.testId.toString(),
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

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const { testId } = attemptStartInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      const test = await TestModel.findById(testId).lean();
      const visible =
        test?.status === "published" && (!test.publishAt || test.publishAt <= new Date());
      if (!test || !visible) throw notFoundError("Test");
      if (!canAccess(userId, test)) throw new HttpError(403, "Buy this test to take it");

      // Resume the attempt in progress, if any (after auto-submitting it if its time is up).
      const current = await AttemptModel.findOne({ userId, testId, status: "in_progress" })
        .select({ _id: 1 })
        .lean();
      if (current) {
        const id = current._id.toString();
        const meta = await expireIfOverdue(id, (await loadMeta(redis, id)) as AttemptMeta);
        if (meta.status === "in_progress") return sendAttempt(res, id, meta);
      }

      const now = Date.now();
      const timing = initialTiming(test, now);
      let doc;
      try {
        doc = await AttemptModel.create({
          userId,
          testId,
          startedAt: new Date(now),
          deadline: new Date(timing.deadline),
          sectionIndex: 0,
          sectionDeadline:
            timing.sectionDeadline === null ? null : new Date(timing.sectionDeadline),
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
        const late = Date.now() > meta.deadline + ANSWER_GRACE_MS;
        const ok = await submitAttempt(
          redis,
          id,
          late ? "timeout" : "manual",
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
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  return router;
}

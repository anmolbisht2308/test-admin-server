import type { AnswerEntry, AttemptStatus, SubmitReason } from "@mockprep/types";
import type { Redis } from "ioredis";
import { Types } from "mongoose";
import { AttemptModel, type AttemptAttrs } from "./models/attempt.js";
import { QuestionModel } from "./models/question.js";
import { TestModel, type TestAttrs } from "./models/test.js";
import { addToRanks, rebuildRanks } from "./ranks.js";
import { scoreAttempt, type ScoringAnswer } from "./scoring.js";

/*
 * Live attempt state lives in a Redis hash `attempt:{id}` (field "meta" + one field "a:{questionId}"
 * per answer) so answer saves never touch Mongo. The worker flushes dirty attempts to Mongo every
 * 30 s, and submit flushes synchronously. If the hash is missing (evicted, Redis restarted) it is
 * rebuilt from Mongo.
 */

/** Saves are accepted this long after the deadline (network latency, clock drift). */
export const ANSWER_GRACE_MS = 10_000;
export const DIRTY_SET = "attempts:dirty";
const hashKey = (id: string) => `attempt:${id}`;
const answerField = (questionId: string) => `a:${questionId}`;

export interface AttemptMeta {
  userId: string;
  testId: string;
  status: AttemptStatus;
  startedAt: number;
  deadline: number;
  sectionIndex: number;
  sectionDeadline: number | null;
  /** When each finished section ended. */
  sectionEnds: number[];
  /** locked_sequential only: seconds per section; empty when sections can be switched freely. */
  sectionTimes: number[];
  /** questionId → section index. */
  sectionOf: Record<string, number>;
}

type AttemptDoc = AttemptAttrs & { _id: Types.ObjectId };
type TestShape = Pick<TestAttrs, "sections" | "templateSnapshot">;

export function metaFor(attempt: AttemptDoc, test: TestShape): AttemptMeta {
  const locked = test.templateSnapshot.sectionSwitching === "locked_sequential";
  const sectionOf: Record<string, number> = {};
  test.sections.forEach((s, i) => s.questionIds.forEach((q) => (sectionOf[q.toString()] = i)));
  return {
    userId: attempt.userId.toString(),
    testId: attempt.testId.toString(),
    status: attempt.status,
    startedAt: attempt.startedAt.getTime(),
    deadline: attempt.deadline.getTime(),
    sectionIndex: attempt.sectionIndex,
    sectionDeadline: attempt.sectionDeadline?.getTime() ?? null,
    sectionEnds: attempt.sectionEnds.map((d) => d.getTime()),
    sectionTimes: locked ? test.sections.map((s) => s.timeSec ?? 0) : [],
    sectionOf,
  };
}

/** Deadlines for a new attempt started at `now`. */
export function initialTiming(test: TestShape, now: number) {
  const deadline = now + test.templateSnapshot.totalTimeSec * 1000;
  const locked = test.templateSnapshot.sectionSwitching === "locked_sequential";
  const first = test.sections[0]?.timeSec;
  return {
    deadline,
    sectionIndex: 0,
    sectionDeadline: locked && first ? Math.min(deadline, now + first * 1000) : null,
  };
}

/** Locked sections move on when their timer runs out. Returns true when the section changed. */
export function advanceSection(meta: AttemptMeta, now: number): boolean {
  let changed = false;
  while (
    meta.sectionDeadline !== null &&
    now >= meta.sectionDeadline &&
    meta.sectionIndex < meta.sectionTimes.length - 1
  ) {
    meta.sectionEnds.push(meta.sectionDeadline);
    meta.sectionIndex += 1;
    meta.sectionDeadline = Math.min(
      meta.deadline,
      meta.sectionDeadline + (meta.sectionTimes[meta.sectionIndex] ?? 0) * 1000,
    );
    changed = true;
  }
  return changed;
}

/** Ends the current locked section early ("Submit section"). */
export function finishSection(meta: AttemptMeta, now: number): boolean {
  if (meta.sectionDeadline === null || meta.sectionIndex >= meta.sectionTimes.length - 1)
    return false;
  meta.sectionEnds.push(now);
  meta.sectionIndex += 1;
  meta.sectionDeadline = Math.min(
    meta.deadline,
    now + (meta.sectionTimes[meta.sectionIndex] ?? 0) * 1000,
  );
  return true;
}

export async function writeMeta(redis: Redis, id: string, meta: AttemptMeta) {
  await redis
    .multi()
    .hset(hashKey(id), "meta", JSON.stringify(meta))
    // Keep the hash a day past the deadline; after that Mongo is the source.
    .pexpireat(hashKey(id), meta.deadline + 24 * 3600 * 1000)
    .exec();
}

/** Attempt meta from Redis, rebuilt from Mongo when missing. null when the attempt doesn't exist. */
export async function loadMeta(redis: Redis, id: string): Promise<AttemptMeta | null> {
  const cached = await redis.hget(hashKey(id), "meta");
  if (cached) return JSON.parse(cached) as AttemptMeta;
  if (!Types.ObjectId.isValid(id)) return null;
  const attempt = await AttemptModel.findById(id).lean<AttemptDoc>();
  if (!attempt) return null;
  const test = await TestModel.findById(attempt.testId)
    .select({ sections: 1, templateSnapshot: 1 })
    .lean<TestShape>();
  if (!test) return null;
  const meta = metaFor(attempt, test);
  if (attempt.status === "in_progress") {
    const fields = attempt.answers.flatMap((a) => [
      answerField(a.questionId.toString()),
      JSON.stringify({ ...a, questionId: a.questionId.toString() }),
    ]);
    if (fields.length) await redis.hset(hashKey(id), ...fields);
    await writeMeta(redis, id, meta);
  }
  return meta;
}

/**
 * Whether an answer may still be saved: its question is in the current section, or (locked
 * sections) it was made before its section ended — e.g. answered offline, synced later.
 */
export function canSaveAnswer(meta: AttemptMeta, entry: AnswerEntry): boolean {
  const section = meta.sectionOf[entry.questionId];
  if (section === undefined) return false;
  if (meta.sectionTimes.length === 0 || section === meta.sectionIndex) return true;
  const ended = meta.sectionEnds[section];
  return section < meta.sectionIndex && ended !== undefined && entry.at <= ended + ANSWER_GRACE_MS;
}

/** Saves answers that are newer (by client `at`) than what is stored. Returns how many were saved. */
export async function mergeAnswers(
  redis: Redis,
  id: string,
  entries: AnswerEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  // The last entry per question in the batch wins within the batch.
  const latest = new Map<string, AnswerEntry>();
  for (const e of entries) {
    const prev = latest.get(e.questionId);
    if (!prev || e.at >= prev.at) latest.set(e.questionId, e);
  }
  const list = [...latest.values()];
  const existing = await redis.hmget(hashKey(id), ...list.map((e) => answerField(e.questionId)));
  const fields: string[] = [];
  list.forEach((e, i) => {
    const stored = existing[i] ? (JSON.parse(existing[i]) as AnswerEntry) : null;
    if (!stored || e.at >= stored.at) fields.push(answerField(e.questionId), JSON.stringify(e));
  });
  if (fields.length) {
    await redis
      .multi()
      .hset(hashKey(id), ...fields)
      .sadd(DIRTY_SET, id)
      .exec();
  }
  return fields.length / 2;
}

export async function readAnswers(redis: Redis, id: string): Promise<AnswerEntry[]> {
  const all = await redis.hgetall(hashKey(id));
  return Object.entries(all)
    .filter(([field]) => field.startsWith("a:"))
    .map(([, value]) => JSON.parse(value) as AnswerEntry);
}

const toDocAnswers = (answers: AnswerEntry[]) =>
  answers.map((a) => ({ ...a, questionId: new Types.ObjectId(a.questionId) }));

/** Copies an in-progress attempt's Redis state to Mongo. */
export async function flushAttempt(redis: Redis, id: string): Promise<void> {
  const raw = await redis.hget(hashKey(id), "meta");
  if (!raw) return;
  const meta = JSON.parse(raw) as AttemptMeta;
  const answers = await readAnswers(redis, id);
  await AttemptModel.updateOne(
    { _id: id, status: "in_progress" },
    {
      $set: {
        answers: toDocAnswers(answers),
        sectionIndex: meta.sectionIndex,
        sectionDeadline: meta.sectionDeadline === null ? null : new Date(meta.sectionDeadline),
        sectionEnds: meta.sectionEnds.map((t) => new Date(t)),
      },
    },
  );
}

/** Flushes every attempt saved since the last run. Returns how many were flushed. */
export async function flushDirtyAttempts(redis: Redis, batch = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const ids = await redis.spop(DIRTY_SET, batch);
    if (ids.length === 0) return total;
    await Promise.all(ids.map((id) => flushAttempt(redis, id)));
    total += ids.length;
  }
}

/**
 * Submits an attempt (manual or on timeout): stores the final answers in Mongo and marks it
 * submitted. Returns false when it was already submitted. The caller queues scoring.
 */
export async function submitAttempt(
  redis: Redis,
  id: string,
  reason: SubmitReason,
  finalAnswers: AnswerEntry[] = [],
  now = Date.now(),
): Promise<boolean> {
  const meta = await loadMeta(redis, id);
  if (!meta || meta.status !== "in_progress") return false;
  if (now <= meta.deadline + ANSWER_GRACE_MS) await mergeAnswers(redis, id, finalAnswers);
  const answers = await readAnswers(redis, id);
  const updated = await AttemptModel.updateOne(
    { _id: id, status: "in_progress" },
    {
      $set: {
        status: "submitted",
        answers: toDocAnswers(answers),
        submittedAt: new Date(Math.min(now, meta.deadline)),
        submitReason: reason,
        sectionIndex: meta.sectionIndex,
      },
    },
  );
  await redis.multi().del(hashKey(id)).srem(DIRTY_SET, id).exec();
  return updated.modifiedCount === 1;
}

/** Scores one attempt (submitted, or already scored when `force`). Returns the new score. */
async function scoreOne(attempt: AttemptDoc, test: TestShape): Promise<number> {
  const excluded = new Set(attempt.excluded.map(String));
  const ids = test.sections
    .flatMap((s) => s.questionIds)
    .filter((id) => !excluded.has(id.toString()));
  const questions = new Map(
    (
      await QuestionModel.find({ _id: { $in: ids } })
        .select({ type: 1, correct: 1, numAnswer: 1 })
        .lean()
    ).map((q) => [q._id.toString(), q]),
  );
  const sections = test.sections.map((s) => ({
    name: s.name,
    questions: s.questionIds.flatMap((qid) => {
      const q = excluded.has(qid.toString()) ? undefined : questions.get(qid.toString());
      return q
        ? [{ id: qid.toString(), type: q.type, correct: q.correct, numAnswer: q.numAnswer ?? null }]
        : [];
    }),
  }));
  const answers = new Map<string, ScoringAnswer>(
    attempt.answers.map((a) => [a.questionId.toString(), a]),
  );
  const end = Math.min((attempt.submittedAt ?? new Date()).getTime(), attempt.deadline.getTime());
  const scored = scoreAttempt(
    sections,
    answers,
    test.templateSnapshot,
    (end - attempt.startedAt.getTime()) / 1000,
  );
  await AttemptModel.updateOne(
    { _id: attempt._id },
    {
      $set: {
        status: "scored",
        result: scored.result,
        outcomes: scored.questions.map((q) => ({
          ...q,
          questionId: new Types.ObjectId(q.questionId),
        })),
        scoredAt: new Date(),
      },
    },
  );
  return scored.result.score;
}

const loadTest = (testId: Types.ObjectId) =>
  TestModel.findById(testId).select({ sections: 1, templateSnapshot: 1 }).lean<TestShape>();

/**
 * Scores a submitted attempt and stores the result; first attempts join the test's ranks.
 * Idempotent (an attempt that is already scored is left alone).
 */
export async function scoreSubmittedAttempt(id: string, redis?: Redis): Promise<boolean> {
  // Claim it (scoredAt set while still "submitted") so two workers never score it twice; a claim
  // older than 5 minutes (crashed worker) can be taken over.
  const now = Date.now();
  const attempt = await AttemptModel.findOneAndUpdate(
    {
      _id: id,
      status: "submitted",
      $or: [{ scoredAt: null }, { scoredAt: { $lt: new Date(now - 5 * 60_000) } }],
    },
    { $set: { scoredAt: new Date(now) } },
  ).lean<AttemptDoc>();
  if (!attempt) return false;
  const test = await loadTest(attempt.testId);
  if (!test) throw new Error(`test ${attempt.testId.toString()} not found`);
  const score = await scoreOne(attempt, test);
  if (redis && attempt.firstAttempt && !attempt.practice) {
    const testId = attempt.testId.toString();
    await addToRanks(redis, testId, id, score);
    // Topper / average / "% got it right" include this attempt from now on.
    await redis.del(`bench:${testId}`, `correct:${testId}`);
  }
  return true;
}

/** Re-scores every submitted/scored attempt of a test (after an answer-key change) and rebuilds ranks. */
export async function rescoreTest(redis: Redis, testId: string): Promise<number> {
  const test = await loadTest(new Types.ObjectId(testId));
  if (!test) throw new Error(`test ${testId} not found`);
  const cursor = AttemptModel.find({ testId, status: { $in: ["submitted", "scored"] } })
    .lean<AttemptDoc[]>()
    .cursor();
  let count = 0;
  for await (const attempt of cursor) {
    await scoreOne(attempt, test);
    count += 1;
  }
  await rebuildRanks(redis, testId);
  return count;
}

/** In-progress attempts whose time (plus grace) is over. */
export async function overdueAttemptIds(now = Date.now(), limit = 500): Promise<string[]> {
  const docs = await AttemptModel.find({
    status: "in_progress",
    deadline: { $lt: new Date(now - ANSWER_GRACE_MS) },
  })
    .select({ _id: 1 })
    .limit(limit)
    .lean();
  return docs.map((d) => d._id.toString());
}

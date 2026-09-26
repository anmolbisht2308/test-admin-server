import {
  computeQuestionStats,
  flushDirtyAttempts,
  overdueAttemptIds,
  rescoreTest,
  scoreSubmittedAttempt,
  submitAttempt,
} from "@mockprep/core";
import { rescoreJobDataSchema, scoreJobDataSchema } from "@mockprep/types";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

/** "score" queue: scores one submitted attempt (first attempts join the test's ranks). */
export function createScoreProcessor(store: Redis, logger: Logger) {
  return async (job: Job) => {
    const { attemptId } = scoreJobDataSchema.parse(job.data);
    const scored = await scoreSubmittedAttempt(attemptId, store);
    logger.debug({ attemptId, scored }, "attempt scored");
  };
}

/**
 * "attempts" queue, every 30 s: copies saved answers from Redis to Mongo, then auto-submits
 * attempts whose time ran out (students who closed the tab) and queues their scoring.
 */
export function createAttemptHousekeeping(
  store: Redis,
  enqueueScore: (attemptId: string) => Promise<unknown>,
  logger: Logger,
) {
  return async () => {
    const flushed = await flushDirtyAttempts(store);
    const overdue = await overdueAttemptIds();
    let submitted = 0;
    for (const id of overdue) {
      if (await submitAttempt(store, id, "timeout")) {
        submitted += 1;
        await enqueueScore(id);
      }
    }
    if (flushed || submitted) logger.info({ flushed, submitted }, "attempts housekeeping");
    return { flushed, submitted };
  };
}

/** "rescore" queue: re-scores a whole test after an answer-key change and rebuilds its ranks. */
export function createRescoreProcessor(store: Redis, logger: Logger) {
  return async (job: Job) => {
    const { testId } = rescoreJobDataSchema.parse(job.data);
    const count = await rescoreTest(store, testId);
    // Drop cached benchmarks so results show the new numbers at once.
    await store.del(`bench:${testId}`, `correct:${testId}`);
    logger.info({ testId, attempts: count }, "test re-scored");
    return { attempts: count };
  };
}

/** "stats" queue, nightly: per-question statistics and "suspect_key" flags. */
export function createStatsProcessor(logger: Logger) {
  return async () => {
    const result = await computeQuestionStats();
    logger.info(result, "question stats computed");
    return result;
  };
}

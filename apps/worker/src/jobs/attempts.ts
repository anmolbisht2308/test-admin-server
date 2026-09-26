import {
  flushDirtyAttempts,
  overdueAttemptIds,
  scoreSubmittedAttempt,
  submitAttempt,
} from "@mockprep/core";
import { scoreJobDataSchema } from "@mockprep/types";
import type { Job } from "bullmq";
import type { Redis } from "ioredis";
import type { Logger } from "pino";

/** "score" queue: scores one submitted attempt. */
export function createScoreProcessor(logger: Logger) {
  return async (job: Job) => {
    const { attemptId } = scoreJobDataSchema.parse(job.data);
    const scored = await scoreSubmittedAttempt(attemptId);
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

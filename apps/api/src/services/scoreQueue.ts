import { QUEUE, type ScoreJobData } from "@mockprep/types";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

/** Queues scoring of a submitted attempt (processed by the worker). */
export type EnqueueScore = (attemptId: string) => Promise<void>;

export function createScoreEnqueuer(redis: Redis): EnqueueScore {
  let queue: Queue<ScoreJobData> | undefined;
  return async (attemptId) => {
    queue ??= new Queue<ScoreJobData>(QUEUE.score, { connection: redis });
    await queue.add(
      "score",
      { attemptId },
      {
        jobId: `score-${attemptId}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  };
}

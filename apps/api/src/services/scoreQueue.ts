import { QUEUE, type RescoreJobData, type ScoreJobData } from "@mockprep/types";
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

/** Queues a re-score of every attempt of a test (after an answer-key change). */
export type EnqueueRescore = (testId: string) => Promise<void>;

export function createRescoreEnqueuer(redis: Redis): EnqueueRescore {
  let queue: Queue<RescoreJobData> | undefined;
  return async (testId) => {
    queue ??= new Queue<RescoreJobData>(QUEUE.rescore, { connection: redis });
    // A fresh job each time: a second key change while one runs must re-score again.
    await queue.add(
      "rescore",
      { testId },
      { attempts: 3, removeOnComplete: 100, removeOnFail: 100 },
    );
  };
}

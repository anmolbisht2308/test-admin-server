import { QUEUE, type PingJobData } from "@mockprep/types";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { createPingProcessor } from "./jobs/ping.js";

export interface WorkerRuntimeOptions {
  redisUrl: string;
  logger: Logger;
  concurrency: number;
  /** Label for the startup ping job ("worker" or "api-embedded"). */
  source: string;
}

export interface WorkerRuntime {
  /** Waits for in-flight jobs, then closes queues and the Redis connection. */
  close(): Promise<void>;
}

/**
 * Starts every queue processor. Used by the standalone worker (src/index.ts) and, on free
 * hosting, inside the api process (RUN_WORKER_IN_API=true) so one service does both jobs.
 */
export async function startWorkers({
  redisUrl,
  logger,
  concurrency,
  source,
}: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  // BullMQ workers need maxRetriesPerRequest: null so blocking commands never time out.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => logger.warn({ err }, "worker redis error"));

  const pingQueue = new Queue<PingJobData>(QUEUE.ping, { connection });
  const pingWorker = new Worker(QUEUE.ping, createPingProcessor(logger), {
    connection,
    concurrency,
  });

  const workers = [pingWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) =>
      logger.error({ queue: worker.name, jobId: job?.id, err }, "job failed"),
    );
    worker.on("error", (err) => logger.error({ queue: worker.name, err }, "worker error"));
  }

  await pingWorker.waitUntilReady();
  logger.info({ queues: workers.map((w) => w.name), source }, "worker started");
  await pingQueue.add(
    "startup",
    { requestedAt: new Date().toISOString(), source },
    { removeOnComplete: 100, removeOnFail: 100 },
  );

  return {
    async close() {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await pingQueue.close();
      await connection.quit();
      logger.info("worker stopped");
    },
  };
}

import { UNFINISHED_UPLOAD_STATUSES, UploadModel, type Storage } from "@mockprep/core";
import { QUEUE, ingestJobId, type IngestJobData, type PingJobData } from "@mockprep/types";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { createGeminiClient, type AiClient, type RetryOptions } from "./ingest/aiExtractor.js";
import { createIngestProcessor } from "./jobs/ingest.js";
import { createPingProcessor } from "./jobs/ping.js";

export { createGeminiClient, type AiClient };

export interface IngestOptions {
  /** Where uploaded papers are read from (the api's storage driver). */
  storage: Pick<Storage, "get">;
  /** Gemini client, or null to use the free text parser. */
  ai: AiClient | null;
  chunkPages: number;
  retry?: RetryOptions;
}

export interface WorkerRuntimeOptions {
  redisUrl: string;
  logger: Logger;
  concurrency: number;
  /** Label for the startup ping job ("worker" or "api-embedded"). */
  source: string;
  /** PDF ingest (needs a Mongo connection opened by the caller). Omit to run only ping. */
  ingest?: IngestOptions;
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
  ingest,
}: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  // BullMQ workers need maxRetriesPerRequest: null so blocking commands never time out.
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", (err) => logger.warn({ err }, "worker redis error"));

  const pingQueue = new Queue<PingJobData>(QUEUE.ping, { connection });
  const pingWorker = new Worker(QUEUE.ping, createPingProcessor(logger), {
    connection,
    concurrency,
  });

  const workers: Worker[] = [pingWorker];
  const queues: Queue[] = [pingQueue];
  let ingestQueue: Queue<IngestJobData> | undefined;
  if (ingest) {
    ingestQueue = new Queue<IngestJobData>(QUEUE.ingest, { connection });
    queues.push(ingestQueue);
    // One paper at a time: AI free tiers are rate limited and PDFs are memory hungry.
    workers.push(
      new Worker(QUEUE.ingest, createIngestProcessor({ ...ingest, logger }), {
        connection,
        concurrency: 1,
        lockDuration: 120_000,
      }),
    );
  }
  for (const worker of workers) {
    worker.on("failed", (job, err) =>
      logger.error({ queue: worker.name, jobId: job?.id, err }, "job failed"),
    );
    worker.on("error", (err) => logger.error({ queue: worker.name, err }, "worker error"));
  }

  await Promise.all(workers.map((w) => w.waitUntilReady()));
  logger.info({ queues: workers.map((w) => w.name), source }, "worker started");
  await pingQueue.add(
    "startup",
    { requestedAt: new Date().toISOString(), source },
    { removeOnComplete: 100, removeOnFail: 100 },
  );

  if (ingestQueue) {
    // Uploads left unfinished by a crash or deploy: queue them again (same job id = no duplicates).
    const unfinished = await UploadModel.find({ status: { $in: UNFINISHED_UPLOAD_STATUSES } })
      .select({ runs: 1 })
      .lean();
    for (const u of unfinished) {
      await ingestQueue.add(
        "ingest",
        { uploadId: u._id.toString() },
        { jobId: ingestJobId(u._id.toString(), u.runs), removeOnComplete: 100, removeOnFail: 100 },
      );
    }
    if (unfinished.length)
      logger.info({ count: unfinished.length }, "re-queued unfinished uploads");
  }

  return {
    async close() {
      await Promise.allSettled(workers.map((worker) => worker.close()));
      await Promise.allSettled(queues.map((queue) => queue.close()));
      await connection.quit();
      logger.info("worker stopped");
    },
  };
}

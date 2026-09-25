import { QUEUE, type PingJobData } from "@mockprep/types";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { loadEnv } from "./env.js";
import { createPingProcessor } from "./jobs/ping.js";
import { createLogger } from "./logger.js";

const env = loadEnv();
const logger = createLogger(env);

// BullMQ workers need maxRetriesPerRequest: null so blocking commands never time out.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
connection.on("error", (err) => logger.warn({ err }, "redis error"));

const pingQueue = new Queue<PingJobData>(QUEUE.ping, { connection });
const pingWorker = new Worker(QUEUE.ping, createPingProcessor(logger), {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

const workers = [pingWorker];
for (const worker of workers) {
  worker.on("failed", (job, err) =>
    logger.error({ queue: worker.name, jobId: job?.id, err }, "job failed"),
  );
  worker.on("error", (err) => logger.error({ queue: worker.name, err }, "worker error"));
}

await pingWorker.waitUntilReady();
logger.info({ queues: workers.map((w) => w.name) }, "worker started");
await pingQueue.add(
  "startup",
  { requestedAt: new Date().toISOString(), source: "worker-startup" },
  { removeOnComplete: 100, removeOnFail: 100 },
);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing active jobs");
  const forceExit = setTimeout(() => process.exit(1), 25_000);
  forceExit.unref();
  // close() waits for in-flight jobs to finish before resolving.
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await pingQueue.close();
  await connection.quit();
  logger.info("worker stopped");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

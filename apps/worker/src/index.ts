import { connectMongo, createStorage } from "@mockprep/core";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { createGeminiClient, startWorkers, type IngestOptions } from "./runtime.js";

const env = loadEnv();
const logger = createLogger(env);

let ingest: IngestOptions | undefined;
if (env.MONGODB_URI) {
  await connectMongo(env.MONGODB_URI, logger);
  ingest = {
    // The worker only reads files, so the local driver's signing secret is unused here.
    storage: createStorage({ ...env, JWT_SECRET: "worker-reads-only" }),
    ai: env.GEMINI_API_KEY ? createGeminiClient(env.GEMINI_API_KEY, env.GEMINI_MODEL) : null,
    chunkPages: env.CHUNK_PAGES,
  };
  logger.info({ extractor: ingest.ai ? env.GEMINI_MODEL : "text" }, "pdf ingest enabled");
} else {
  logger.warn("MONGODB_URI not set: pdf ingest is off (ping only)");
}

const runtime = await startWorkers({
  redisUrl: env.REDIS_URL,
  logger,
  concurrency: env.WORKER_CONCURRENCY,
  source: "worker-startup",
  ...(ingest ? { ingest } : {}),
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down: finishing active jobs");
  const forceExit = setTimeout(() => process.exit(1), 25_000);
  forceExit.unref();
  await runtime.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

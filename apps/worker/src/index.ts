import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { startWorkers } from "./runtime.js";

const env = loadEnv();
const logger = createLogger(env);
const runtime = await startWorkers({
  redisUrl: env.REDIS_URL,
  logger,
  concurrency: env.WORKER_CONCURRENCY,
  source: "worker-startup",
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

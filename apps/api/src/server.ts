import type { WorkerRuntime } from "@mockprep/worker/runtime";
import mongoose from "mongoose";
import { createApp } from "./app.js";
import { connectMongo, isMongoUp } from "@mockprep/core";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { createRedis, pingRedis } from "./redis.js";
import { seedAdmin, seedCatalogue } from "./scripts/seedCatalogue.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedis(env.REDIS_URL, logger);
if (env.NODE_ENV === "production" && env.STORAGE_DRIVER === "local") {
  logger.warn(
    "STORAGE_DRIVER=local in production: uploaded figures are lost when the disk is wiped. Use s3.",
  );
}

const app = createApp({
  env,
  logger,
  redis,
  health: { db: isMongoUp, redis: () => pingRedis(redis), version: env.version },
});

// Listen immediately so /health can report "db: down" while Mongo is still retrying.
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, version: env.version }, "api listening");
});

connectMongo(env.MONGODB_URI, logger)
  .then(async () => {
    // Free hosting has no pre-deploy step: seed here instead (idempotent, never overwrites edits).
    if (!env.SEED_ON_START) return;
    await seedCatalogue();
    if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
      await seedAdmin(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD, logger);
    }
    logger.info("startup seed done");
  })
  .catch((err: unknown) => {
    logger.fatal({ err }, "mongo connection or startup seed failed");
    process.exit(1);
  });

// Free hosting: run the queue workers in this process (one service instead of api + worker).
let workers: WorkerRuntime | undefined;
if (env.RUN_WORKER_IN_API) {
  import("@mockprep/worker/runtime")
    .then(({ startWorkers }) =>
      startWorkers({
        redisUrl: env.REDIS_URL,
        logger,
        concurrency: env.WORKER_CONCURRENCY,
        source: "api-embedded",
      }),
    )
    .then((runtime) => {
      workers = runtime;
    })
    .catch((err: unknown) => logger.error({ err }, "embedded worker failed to start"));
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), 25_000);
  forceExit.unref();
  server.close();
  // Let in-flight jobs finish before closing the connections they use.
  await workers?.close();
  await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

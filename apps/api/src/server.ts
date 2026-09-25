import mongoose from "mongoose";
import { createApp } from "./app.js";
import { connectMongo, isMongoUp } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { createRedis, pingRedis } from "./redis.js";

const env = loadEnv();
const logger = createLogger(env);
const redis = createRedis(env.REDIS_URL, logger);

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

connectMongo(env.MONGODB_URI, logger).catch((err: unknown) => {
  logger.fatal({ err }, "mongo connection failed permanently");
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close();
  await Promise.allSettled([mongoose.disconnect(), redis.quit()]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled rejection"));

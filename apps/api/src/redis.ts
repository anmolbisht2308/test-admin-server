import { Redis } from "ioredis";
import type { Logger } from "pino";

export function createRedis(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    // Fail fast instead of queueing commands while disconnected, so /health stays honest.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  redis.on("ready", () => logger.info("redis connected"));
  redis.on("error", (err) => logger.warn({ err }, "redis error"));
  return redis;
}

export async function pingRedis(redis: Redis, timeoutMs = 1_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("redis ping timeout")), timeoutMs);
      }),
    ]);
    return result === "PONG";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

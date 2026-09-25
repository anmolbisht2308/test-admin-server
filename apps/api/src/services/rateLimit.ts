import type { Redis } from "ioredis";
import type { ClientRateLimitInfo, Store } from "express-rate-limit";
import { HttpError } from "../lib/httpError.js";

export interface LimitResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/** Fixed-window counter in Redis. Window starts at the first hit. */
export async function hitLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
): Promise<LimitResult> {
  const results = await redis.multi().set(key, 0, "EX", windowSec, "NX").incr(key).ttl(key).exec();
  const count = Number(results?.[1]?.[1] ?? 0);
  const ttl = Number(results?.[2]?.[1] ?? windowSec);
  return { allowed: count <= limit, count, retryAfterSec: ttl > 0 ? ttl : windowSec };
}

/** Throws 429 with Retry-After details when over the limit. */
export async function enforceLimit(
  redis: Redis,
  key: string,
  limit: number,
  windowSec: number,
  message: string,
) {
  const result = await hitLimit(redis, key, limit, windowSec);
  if (!result.allowed) {
    throw new HttpError(429, message, { retryAfterSec: result.retryAfterSec });
  }
}

/** express-rate-limit store on Redis so limits hold across api instances. */
export class RedisRateLimitStore implements Store {
  private windowSec = 60;
  readonly prefix = "rl:";

  constructor(private readonly redis: Redis) {}

  init(options: { windowMs: number }) {
    this.windowSec = Math.max(1, Math.ceil(options.windowMs / 1000));
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const result = await hitLimit(
      this.redis,
      this.prefix + key,
      Number.MAX_SAFE_INTEGER,
      this.windowSec,
    );
    return {
      totalHits: result.count,
      resetTime: new Date(Date.now() + result.retryAfterSec * 1000),
    };
  }

  async decrement(key: string) {
    await this.redis.decr(this.prefix + key);
  }

  async resetKey(key: string) {
    await this.redis.del(this.prefix + key);
  }
}

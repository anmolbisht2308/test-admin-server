import mongoose from "mongoose";
import type { Logger } from "pino";

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect Mongoose with exponential backoff. After the first successful connect,
 * the driver handles reconnects itself.
 */
export async function connectMongo(
  uri: string,
  logger: Logger,
  { maxAttempts = Infinity, initialDelayMs = 1_000, maxDelayMs = 30_000 }: RetryOptions = {},
): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
      logger.info({ attempt }, "mongo connected");
      return mongoose;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const delay = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
      logger.warn({ attempt, delayMs: delay, err: error }, "mongo connect failed, retrying");
      await sleep(delay);
    }
  }
}

export function isMongoUp(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

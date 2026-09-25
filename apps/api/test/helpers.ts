import { pino } from "pino";
import { createApp, type AppDeps } from "../src/app.js";

export const silentLogger = pino({ level: "silent" });

export const testEnv: AppDeps["env"] = {
  NODE_ENV: "test",
  CORS_ORIGINS: ["http://localhost:3000"],
  TRUST_PROXY: 0,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_MAX: 1_000,
};

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: testEnv,
    logger: silentLogger,
    health: { db: () => true, redis: () => true, version: "test" },
    ...overrides,
  });
}

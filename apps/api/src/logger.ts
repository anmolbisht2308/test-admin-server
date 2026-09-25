import { pino, type Logger } from "pino";
import type { Env } from "./env.js";

export function createLogger(env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

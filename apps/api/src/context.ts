import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Env } from "./env.js";
import type { TokenService } from "./lib/tokens.js";
import type { GoogleVerifier } from "./services/google.js";
import type { OtpService } from "./services/otp.js";
import type { SessionService } from "./services/sessions.js";

/** Everything route factories need. Built once in createApp. */
export interface AppContext {
  env: Env;
  logger: Logger;
  redis: Redis;
  tokens: TokenService;
  sessions: SessionService;
  otp: OtpService;
  google: GoogleVerifier | null;
}

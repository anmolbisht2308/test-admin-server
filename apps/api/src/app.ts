import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { AppContext } from "./context.js";
import type { Env } from "./env.js";
import { createTokenService } from "./lib/tokens.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { adminRouter } from "./routes/admin/index.js";
import { studentAuthRouter } from "./routes/auth.js";
import { catalogueRouter } from "./routes/catalogue.js";
import { healthRouter, type HealthChecks } from "./routes/health.js";
import { meRouter } from "./routes/me.js";
import { createEmailSender, type EmailSender } from "./services/email.js";
import { createGoogleVerifier, type GoogleVerifier } from "./services/google.js";
import { createOtpService } from "./services/otp.js";
import { createOtpSender, type OtpSender } from "./services/otpSender.js";
import { RedisRateLimitStore } from "./services/rateLimit.js";
import { createSessionService } from "./services/sessions.js";
import { LocalStorage, createStorage, type Storage } from "@mockprep/core";
import { localStorageRouter } from "./routes/storage.js";
import type { EnqueueIngest } from "./routes/admin/uploads.js";
import { createIngestEnqueuer } from "./services/ingestQueue.js";
import { attemptsRouter } from "./routes/attempts.js";
import { createScoreEnqueuer, type EnqueueScore } from "./services/scoreQueue.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  redis: Redis;
  health: HealthChecks;
  /** Defaults from env (console or MSG91). Tests inject a recorder. */
  otpSender?: OtpSender;
  /** Defaults from env (console or Brevo). Tests inject a recorder. */
  emailSender?: EmailSender;
  /** Defaults from GOOGLE_CLIENT_IDS (null = Google sign-in off). */
  googleVerifier?: GoogleVerifier | null;
  /** Defaults from STORAGE_DRIVER (local disk or S3). */
  storage?: Storage;
  /** Queues PDF ingest runs. Defaults to the BullMQ "ingest" queue on `redis`. */
  enqueueIngest?: EnqueueIngest;
  /** Queues attempt scoring. Defaults to the BullMQ "score" queue on `redis`. */
  enqueueScore?: EnqueueScore;
  /** Extra routers mounted under /api after the feature routers. */
  routers?: Router[];
}

export function createApp(deps: AppDeps): Express {
  const { env, logger, redis, health, routers = [] } = deps;
  const ctx: AppContext = {
    env,
    logger,
    redis,
    tokens: createTokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SEC),
    sessions: createSessionService({
      studentTtlDays: env.STUDENT_REFRESH_TTL_DAYS,
      adminTtlDays: env.ADMIN_REFRESH_TTL_DAYS,
      studentMaxDevices: env.STUDENT_MAX_DEVICES,
    }),
    otp: createOtpService(
      redis,
      {
        sms: deps.otpSender ?? createOtpSender(env, logger),
        email: deps.emailSender ?? createEmailSender(env, logger),
      },
      env.JWT_SECRET,
    ),
    google:
      deps.googleVerifier === undefined
        ? createGoogleVerifier(env.GOOGLE_CLIENT_IDS)
        : deps.googleVerifier,
  };

  const storage = deps.storage ?? createStorage(env);

  const app = express();
  app.disable("x-powered-by");
  // Render adds one proxy hop; the Vercel rewrite adds another (TRUST_PROXY=2 in production).
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === "/health" || req.url === "/api/health" },
    }),
  );
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));

  // Health checks are exempt from rate limiting so uptime probes never get 429.
  const healthRoutes = healthRouter(health);
  app.use(healthRoutes);
  app.use("/api", healthRoutes);

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      store: new RedisRateLimitStore(redis),
      // If Redis is down, serve requests rather than fail them all.
      passOnStoreError: true,
      message: { error: "Too many requests, please slow down." },
    }),
  );
  // Local file storage (dev): raw-body upload route + static files. Before the JSON parser.
  if (storage instanceof LocalStorage) app.use("/api", localStorageRouter(storage));
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  app.use("/api/auth", studentAuthRouter(ctx));
  app.use("/api/me", meRouter(ctx));
  app.use("/api/attempts", attemptsRouter(ctx, deps.enqueueScore ?? createScoreEnqueuer(redis)));
  app.use("/api/exams", catalogueRouter());
  const enqueueIngest = deps.enqueueIngest ?? createIngestEnqueuer(redis);
  app.use("/api/admin", adminRouter(ctx, storage, enqueueIngest));
  for (const router of routers) app.use("/api", router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

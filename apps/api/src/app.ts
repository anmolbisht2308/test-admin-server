import cors from "cors";
import express, { type Express, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Logger } from "pino";
import type { Env } from "./env.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { healthRouter, type HealthChecks } from "./routes/health.js";

export interface AppDeps {
  env: Pick<
    Env,
    "CORS_ORIGINS" | "TRUST_PROXY" | "RATE_LIMIT_WINDOW_MS" | "RATE_LIMIT_MAX" | "NODE_ENV"
  >;
  logger: Logger;
  health: HealthChecks;
  /** Feature routers, mounted after body parsing and before the 404 handler. */
  routers?: Router[];
}

export function createApp({ env, logger, health, routers = [] }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/health" } }));
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );

  // Health checks are exempt from rate limiting so uptime probes never get 429.
  app.use(healthRouter(health));

  // TODO(phase 2): move to a Redis store so limits hold across api instances.
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests, please slow down." },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  for (const router of routers) app.use(router);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

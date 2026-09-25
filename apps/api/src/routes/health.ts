import type { HealthResponse } from "@mockprep/types";
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";

export interface HealthChecks {
  db: () => boolean | Promise<boolean>;
  redis: () => boolean | Promise<boolean>;
  version: string;
}

export function healthRouter(checks: HealthChecks): Router {
  const router = Router();
  router.get(
    "/health",
    asyncHandler(async (_req, res) => {
      const [db, redis] = await Promise.all([checks.db(), checks.redis()]);
      const body: HealthResponse = {
        status: db && redis ? "ok" : "degraded",
        db: db ? "up" : "down",
        redis: redis ? "up" : "down",
        version: checks.version,
      };
      res.set("Cache-Control", "no-store");
      res.status(body.status === "ok" ? 200 : 503).json(body);
    }),
  );
  return router;
}

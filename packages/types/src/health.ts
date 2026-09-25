import { z } from "zod";

export const serviceStateSchema = z.enum(["up", "down"]);
export type ServiceState = z.infer<typeof serviceStateSchema>;

/** GET /health */
export const healthResponseSchema = z.object({
  /** "ok" when every dependency is up, otherwise "degraded" (served with HTTP 503). */
  status: z.enum(["ok", "degraded"]),
  db: serviceStateSchema,
  redis: serviceStateSchema,
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

import { z } from "zod";

/** Every API error response has this shape, with the matching HTTP status. */
export const apiErrorSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

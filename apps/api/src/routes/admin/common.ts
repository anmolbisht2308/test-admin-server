import { objectIdSchema } from "@mockprep/types";
import { notFoundError } from "../../lib/httpError.js";

/** Roles allowed to change catalogue content. Every admin role can read. */
export const CONTENT_WRITERS = ["superadmin", "content"] as const;

export function parseId(value: unknown, what: string): string {
  const parsed = objectIdSchema.safeParse(value);
  if (!parsed.success) throw notFoundError(what);
  return parsed.data;
}

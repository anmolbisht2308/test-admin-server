import { z } from "zod";

/** MongoDB ObjectId as a 24-char hex string. */
export const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "must be a valid id");

/** URL-safe lowercase key, e.g. "sbi-po-prelims". */
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "use lowercase letters, digits and single hyphens");

export const languageSchema = z.enum(["en", "hi"]);
export type Language = z.infer<typeof languageSchema>;

export const examFamilySchema = z.enum([
  "banking",
  "ssc",
  "upsc",
  "defence",
  "engineering",
  "other",
]);
export type ExamFamily = z.infer<typeof examFamilySchema>;

export const EXAM_FAMILY_LABELS: Record<ExamFamily, string> = {
  banking: "Banking",
  ssc: "SSC",
  upsc: "UPSC",
  defence: "Defence",
  engineering: "Engineering (JEE)",
  other: "Other",
};

/** ISO date string as sent over JSON. */
export const isoDateSchema = z.iso.datetime();

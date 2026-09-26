import { z } from "zod";
import { isoDateSchema, objectIdSchema, slugSchema } from "./common.js";

/** Pipeline steps, in order. */
export const uploadStatusSchema = z.enum([
  "queued",
  "extracting",
  "answer_key",
  "validating",
  "ready",
  "failed",
]);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;
export const UPLOAD_STEPS = ["queued", "extracting", "answer_key", "validating", "ready"] as const;

/** Per-question problems the pipeline found. Approved questions have none. */
export const validationFlagSchema = z.enum([
  "empty_stem",
  "option_count",
  "no_answer",
  "ai_answer",
  "needs_figure",
  "low_confidence",
  "latex",
  "duplicate",
  "duplicate_in_paper",
  // After publishing (Phase 6): students' error reports, nightly stats.
  "reported",
  "suspect_key",
]);
export type ValidationFlag = z.infer<typeof validationFlagSchema>;

export const FLAG_LABELS: Record<ValidationFlag, string> = {
  empty_stem: "No question text",
  option_count: "Wrong number of options",
  no_answer: "No answer",
  ai_answer: "AI answer: verify",
  needs_figure: "Needs figure",
  low_confidence: "Low confidence",
  latex: "Check maths ($ unbalanced)",
  duplicate: "Already in bank",
  duplicate_in_paper: "Repeated in paper",
  reported: "Reported by students",
  suspect_key: "Answer key looks wrong (stats)",
};

export const uploadFileKindSchema = z.enum(["paper", "key", "solutions"]);
export type UploadFileKind = z.infer<typeof uploadFileKindSchema>;

export const UPLOAD_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export const uploadPresignInputSchema = z.object({
  kind: uploadFileKindSchema,
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES, "files must be 25 MB or smaller"),
});
export type UploadPresignInput = z.infer<typeof uploadPresignInputSchema>;

/** A file already PUT to storage via a presigned URL. */
export const storedFileInputSchema = z.object({
  key: z
    .string()
    .regex(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(pdf|png|jpg|webp)$/, "invalid upload key"),
  name: z.string().trim().min(1).max(200),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
});
export type StoredFileInput = z.infer<typeof storedFileInputSchema>;

export const uploadCreateInputSchema = z
  .object({
    title: z.string().trim().min(2).max(160),
    examKey: slugSchema,
    templateKey: slugSchema,
    files: z.object({
      paper: storedFileInputSchema,
      key: storedFileInputSchema.nullable().default(null),
      solutions: storedFileInputSchema.nullable().default(null),
    }),
  })
  .refine((u) => u.files.paper.contentType === "application/pdf", {
    path: ["files", "paper"],
    message: "the question paper must be a PDF",
  });
export type UploadCreateInput = z.input<typeof uploadCreateInputSchema>;

const storedFileSchema = z.object({ name: z.string(), contentType: z.string(), url: z.string() });

export const uploadLogEntrySchema = z.object({
  at: isoDateSchema,
  level: z.enum(["info", "warn", "error"]),
  message: z.string(),
});
export type UploadLogEntry = z.infer<typeof uploadLogEntrySchema>;

export const uploadStatsSchema = z.object({
  extractor: z.enum(["ai", "text"]),
  pages: z.number().int(),
  found: z.number().int(),
  expected: z.number().int(),
  autoApproved: z.number().int(),
  toReview: z.number().int(),
  flagCounts: z.partialRecord(validationFlagSchema, z.number().int()),
  durationMs: z.number().int(),
});
export type UploadStats = z.infer<typeof uploadStatsSchema>;

export const uploadSchema = z.object({
  id: objectIdSchema,
  title: z.string(),
  examKey: slugSchema,
  templateKey: slugSchema,
  files: z.object({
    paper: storedFileSchema,
    key: storedFileSchema.nullable(),
    solutions: storedFileSchema.nullable(),
  }),
  status: uploadStatusSchema,
  /** 0–100 */
  progress: z.number(),
  message: z.string(),
  log: z.array(uploadLogEntrySchema),
  stats: uploadStatsSchema.nullable(),
  testId: objectIdSchema.nullable(),
  error: z.string().nullable(),
  startedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Upload = z.infer<typeof uploadSchema>;

export const uploadListResponseSchema = z.object({
  uploads: z.array(uploadSchema.omit({ log: true })),
});
export type UploadListResponse = z.infer<typeof uploadListResponseSchema>;

/** GET /api/admin/uploads/config — tells the upload page which extractor will run. */
export const uploadConfigResponseSchema = z.object({
  ai: z.boolean(),
  model: z.string().nullable(),
  chunkPages: z.number().int(),
});
export type UploadConfigResponse = z.infer<typeof uploadConfigResponseSchema>;

// ---------- review ----------

export const approveAnsweredResponseSchema = z.object({
  approved: z.number().int(),
  remaining: z.number().int(),
});
export type ApproveAnsweredResponse = z.infer<typeof approveAnsweredResponseSchema>;

export const testPublishInputSchema = z.object({
  /** Publish even though some questions are still unreviewed (drafts). Never skips missing answers. */
  force: z.boolean().default(false),
});
export type TestPublishInput = z.input<typeof testPublishInputSchema>;

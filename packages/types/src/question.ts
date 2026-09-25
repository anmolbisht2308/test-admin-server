import { z } from "zod";
import { examFamilySchema, isoDateSchema, objectIdSchema, slugSchema } from "./common.js";
import { questionTypeSchema } from "./exam-template.js";

export const answerSourceSchema = z.enum(["key", "document", "ai", "manual", "none"]);
export type AnswerSource = z.infer<typeof answerSourceSchema>;

export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;

export const questionStatusSchema = z.enum(["draft", "approved"]);
export type QuestionStatus = z.infer<typeof questionStatusSchema>;

export const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
export const MAX_OPTIONS = OPTION_LETTERS.length;

/** Figures are either api-served files (local storage) or absolute https URLs (S3/CDN). */
export const figureUrlSchema = z
  .string()
  .max(1000)
  .refine(
    (url) => url.startsWith("/api/files/") || /^https:\/\/[^\s]+$/.test(url),
    "must be an uploaded file or an https URL",
  );

const numAnswerSchema = z.object({ min: z.number(), max: z.number() });

// Every field has a default so drafts (e.g. from PDF import) can be incomplete. Editors send the
// full question (PUT), so there is no partial schema.
const questionFields = z.object({
  /** Exam slug the question was written for (e.g. "sbi-po"). */
  examKey: slugSchema,
  section: z.string().trim().min(1).max(80),
  /** Number as printed on the source paper. */
  number: z.number().int().positive().nullable().default(null),
  /** Position within its source (paper order). */
  order: z.number().int().min(0).default(0),
  type: questionTypeSchema,
  /** Shared RC/DI text, copied into every question it belongs to. */
  passage: z.string().max(20_000).default(""),
  passageHi: z.string().max(20_000).default(""),
  stem: z.string().max(10_000).default(""),
  options: z.array(z.string().max(2000)).max(MAX_OPTIONS).default([]),
  stemHi: z.string().max(10_000).default(""),
  optionsHi: z.array(z.string().max(2000)).max(MAX_OPTIONS).default([]),
  /** 0-based option indices. */
  correct: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(MAX_OPTIONS - 1),
    )
    .max(MAX_OPTIONS)
    .default([]),
  /** Accepted range for integer/numeric answers (min === max for an exact answer). */
  numAnswer: numAnswerSchema.nullable().default(null),
  answerSource: answerSourceSchema.default("manual"),
  solution: z.string().max(20_000).default(""),
  solutionHi: z.string().max(20_000).default(""),
  subject: z.string().trim().max(120).default(""),
  topic: z.string().trim().max(120).default(""),
  taxonomyIds: z.array(objectIdSchema).max(20).default([]),
  difficulty: difficultySchema.default("medium"),
  hasFigure: z.boolean().default(false),
  figureUrl: figureUrlSchema.nullable().default(null),
  sourcePage: z.number().int().positive().nullable().default(null),
  confidence: z.number().min(0).max(1).default(1),
  status: questionStatusSchema.default("draft"),
  uploadId: objectIdSchema.nullable().default(null),
});

type QuestionFields = z.infer<typeof questionFields>;

export const isNumericType = (type: QuestionFields["type"]) =>
  type === "integer" || type === "numeric";

export function hasAnswer(q: Pick<QuestionFields, "type" | "correct" | "numAnswer">): boolean {
  return isNumericType(q.type) ? q.numAnswer !== null : q.correct.length > 0;
}

function checkQuestion(q: QuestionFields, ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });

  if (isNumericType(q.type)) {
    if (q.options.length > 0) issue(["options"], "numeric questions have no options");
    if (q.correct.length > 0) issue(["correct"], "use numAnswer for numeric questions");
    if (q.numAnswer) {
      if (q.numAnswer.min > q.numAnswer.max) issue(["numAnswer", "max"], "max must be ≥ min");
      if (
        q.type === "integer" &&
        !(Number.isInteger(q.numAnswer.min) && Number.isInteger(q.numAnswer.max))
      ) {
        issue(["numAnswer", "min"], "integer answers must be whole numbers");
      }
    }
  } else {
    if (q.numAnswer) issue(["numAnswer"], "only integer/numeric questions have a numeric answer");
    if (new Set(q.correct).size !== q.correct.length) issue(["correct"], "duplicate answer");
    q.correct.forEach((index, i) => {
      if (index >= q.options.length)
        issue(["correct", i], `option ${String.fromCharCode(65 + index)} does not exist`);
    });
    if (q.type === "mcq_single" && q.correct.length > 1)
      issue(["correct"], "single-answer questions have one correct option");
  }
  if (q.optionsHi.length > 0 && q.optionsHi.length !== q.options.length) {
    issue(["optionsHi"], "Hindi options must match the English options one-to-one");
  }

  // Approved questions must be complete enough to put in a test.
  if (q.status === "approved") {
    if (!q.stem.trim() && !q.stemHi.trim())
      issue(["stem"], "approved questions need a question text");
    if (!isNumericType(q.type)) {
      if (q.options.length < 2) issue(["options"], "add at least 2 options");
      q.options.forEach((option, i) => {
        if (!option.trim()) issue(["options", i], "option text is empty");
      });
    }
    if (!hasAnswer(q))
      issue(
        isNumericType(q.type) ? ["numAnswer"] : ["correct"],
        "approved questions need an answer",
      );
    if (q.hasFigure && !q.figureUrl)
      issue(["figureUrl"], "upload the figure or untick “has figure”");
  }
}

/** Body for POST /api/admin/questions and PUT /api/admin/questions/:id. */
export const questionInputSchema = questionFields.superRefine(checkQuestion);
export type QuestionInput = z.input<typeof questionInputSchema>;
export type QuestionData = z.output<typeof questionInputSchema>;

export const questionSchema = questionFields.extend({
  id: objectIdSchema,
  /** Id of version 1; shared by every version of the question. */
  rootId: objectIdSchema,
  version: z.number().int().positive(),
  /** Only the latest version is shown in the bank and can be added to tests. */
  isLatest: z.boolean(),
  examFamily: examFamilySchema,
  /** sha1 of the normalised stem + options, for duplicate detection. */
  hash: z.string(),
  /** Validation flags (set by imports; see Phase 4). */
  flags: z.array(z.string()),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Question = z.infer<typeof questionSchema>;

/** PUT response: `versioned` is true when a new version was created (old one is in published tests). */
export const questionSaveResponseSchema = z.object({
  question: questionSchema,
  versioned: z.boolean(),
});
export type QuestionSaveResponse = z.infer<typeof questionSaveResponseSchema>;

/**
 * Text normalised for duplicate detection: Unicode NFKC, lowercase, whitespace collapsed,
 * options sorted (so shuffled options still match). Hash it with sha1.
 */
export function normaliseForHash(stem: string, options: readonly string[]): string {
  const norm = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return [norm(stem), ...options.map(norm).sort()].join("\n");
}

// ---------- bank listing ----------

export const questionListQuerySchema = z.object({
  examFamily: examFamilySchema.optional(),
  examKey: slugSchema.optional(),
  section: z.string().trim().max(80).optional(),
  topic: z.string().trim().max(120).optional(),
  taxonomyId: objectIdSchema.optional(),
  difficulty: difficultySchema.optional(),
  status: questionStatusSchema.optional(),
  answerSource: answerSourceSchema.optional(),
  type: questionTypeSchema.optional(),
  /** Full-text search over stem, options, passage and topic. */
  q: z.string().trim().max(200).optional(),
  /** Exclude these ids (e.g. questions already in the test being built). */
  exclude: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : [])),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type QuestionListQuery = z.input<typeof questionListQuerySchema>;

export const questionListResponseSchema = z.object({
  questions: z.array(questionSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type QuestionListResponse = z.infer<typeof questionListResponseSchema>;

const idsSchema = z.array(objectIdSchema).min(1).max(500);

export const questionBulkInputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("update"),
    ids: idsSchema,
    set: z
      .object({
        subject: z.string().trim().max(120),
        topic: z.string().trim().max(120),
        difficulty: difficultySchema,
      })
      .partial(),
    addTaxonomyIds: z.array(objectIdSchema).max(20).default([]),
  }),
  z.object({ action: z.literal("delete"), ids: idsSchema }),
]);
export type QuestionBulkInput = z.input<typeof questionBulkInputSchema>;

export const questionBulkResponseSchema = z.object({
  modified: z.number().int(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});
export type QuestionBulkResponse = z.infer<typeof questionBulkResponseSchema>;

export const duplicateGroupsResponseSchema = z.object({
  groups: z.array(z.object({ hash: z.string(), questions: z.array(questionSchema) })),
});
export type DuplicateGroupsResponse = z.infer<typeof duplicateGroupsResponseSchema>;

// ---------- Excel/CSV import ----------

export const importReportSchema = z.object({
  dryRun: z.boolean(),
  total: z.number().int(),
  imported: z.number().int(),
  /** Rows that already exist in the bank (imported, flagged "duplicate"). */
  duplicates: z.number().int(),
  rejected: z.array(z.object({ row: z.number().int(), errors: z.array(z.string()) })),
});
export type ImportReport = z.infer<typeof importReportSchema>;

// ---------- figures ----------

export const FIGURE_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const MAX_FIGURE_BYTES = 2 * 1024 * 1024;

export const figurePresignInputSchema = z.object({
  contentType: z.enum(FIGURE_CONTENT_TYPES),
  size: z.number().int().positive().max(MAX_FIGURE_BYTES, "images must be 2 MB or smaller"),
});
export type FigurePresignInput = z.infer<typeof figurePresignInputSchema>;

export const figurePresignResponseSchema = z.object({
  /** PUT the raw file bytes here with `headers`. */
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Store this in question.figureUrl after the upload succeeds. */
  fileUrl: z.string(),
});
export type FigurePresignResponse = z.infer<typeof figurePresignResponseSchema>;

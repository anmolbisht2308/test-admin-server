import { z } from "zod";
import { isoDateSchema, objectIdSchema, slugSchema } from "./common.js";
import { examTemplateCoreSchema, questionTypeSchema } from "./exam-template.js";
import { questionSchema } from "./question.js";

export const testTypeSchema = z.enum(["full", "sectional", "topic", "pyq", "quiz"]);
export type TestType = z.infer<typeof testTypeSchema>;

export const TEST_TYPE_LABELS: Record<TestType, string> = {
  full: "Full mock",
  sectional: "Sectional",
  topic: "Topic test",
  pyq: "Previous year paper",
  quiz: "Quiz",
};

export const testStatusSchema = z.enum(["draft", "published"]);
export type TestStatus = z.infer<typeof testStatusSchema>;

/** Copy of the template taken when the test is created; later template edits never change it. */
export const templateSnapshotSchema = examTemplateCoreSchema;
export type TemplateSnapshot = z.infer<typeof templateSnapshotSchema>;

export const testSectionSchema = z.object({
  name: z.string(),
  timeSec: z.number().int().positive().optional(),
  /** Question version ids, in order. */
  questionIds: z.array(objectIdSchema),
});
export type TestSection = z.infer<typeof testSectionSchema>;

export const testSchema = z.object({
  id: objectIdSchema,
  title: z.string(),
  examKey: slugSchema,
  type: testTypeSchema,
  templateSnapshot: templateSnapshotSchema,
  sections: z.array(testSectionSchema),
  /** Test-level problems found by the PDF pipeline, as readable messages. */
  testFlags: z.array(z.string()),
  /** Set when the test was created from a PDF upload. */
  uploadId: objectIdSchema.nullable(),
  status: testStatusSchema,
  isFree: z.boolean(),
  /** When students may see the test (null = as soon as it is published). */
  publishAt: isoDateSchema.nullable(),
  publishedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Test = z.infer<typeof testSchema>;

export const testCreateInputSchema = z.object({
  title: z.string().trim().min(2).max(160),
  examKey: slugSchema,
  templateKey: slugSchema,
  type: testTypeSchema.default("full"),
  isFree: z.boolean().default(true),
});
export type TestCreateInput = z.input<typeof testCreateInputSchema>;

/** PUT /api/admin/tests/:id — the editable parts of a draft test. Section names must match. */
export const testUpdateInputSchema = z.object({
  title: z.string().trim().min(2).max(160),
  type: testTypeSchema,
  isFree: z.boolean(),
  publishAt: isoDateSchema.nullable(),
  sections: z.array(z.object({ name: z.string(), questionIds: z.array(objectIdSchema).max(500) })),
});
export type TestUpdateInput = z.infer<typeof testUpdateInputSchema>;

export const difficultyMixSchema = z
  .object({ easy: z.number().min(0), medium: z.number().min(0), hard: z.number().min(0) })
  .refine((m) => m.easy + m.medium + m.hard > 0, "the mix needs at least one non-zero share");
export type DifficultyMix = z.infer<typeof difficultyMixSchema>;

/** Rule for filling a section from the bank. */
export const selectionRuleSchema = z.object({
  count: z.number().int().min(1).max(500),
  /** Topic names (question.topic); empty = any topic. */
  topics: z.array(z.string().trim().min(1)).max(50).default([]),
  /** Taxonomy nodes; a question matches if tagged with any of them or their descendants. */
  taxonomyIds: z.array(objectIdSchema).max(50).default([]),
  /** Relative shares, e.g. { easy: 30, medium: 50, hard: 20 }. Omit for any difficulty. */
  difficultyMix: difficultyMixSchema.optional(),
  /** Skip questions used in tests published in the last N days (0 = no limit). */
  notUsedInLastDays: z.number().int().min(0).max(3650).default(0),
  /** replace: clear the section first; append: add to what is there. */
  mode: z.enum(["replace", "append"]).default("replace"),
});
export type SelectionRule = z.input<typeof selectionRuleSchema>;

export const testFillInputSchema = z.object({
  sections: z
    .array(z.object({ index: z.number().int().min(0), rule: selectionRuleSchema }))
    .min(1)
    .max(20),
});
export type TestFillInput = z.input<typeof testFillInputSchema>;

export const fillReportSchema = z.object({
  index: z.number().int(),
  name: z.string(),
  requested: z.number().int(),
  added: z.number().int(),
  shortfall: z.number().int(),
});
export type FillReport = z.infer<typeof fillReportSchema>;

/** Live builder checks. `ok` means the test can be published. */
export const testChecksSchema = z.object({
  ok: z.boolean(),
  questionCount: z.object({ expected: z.number().int(), actual: z.number().int() }),
  sections: z.array(
    z.object({ name: z.string(), expected: z.number().int(), actual: z.number().int() }),
  ),
  missingAnswers: z.array(objectIdSchema),
  drafts: z.array(objectIdSchema),
  /** Groups of question ids that are the same question (same hash or versions of one question). */
  duplicates: z.array(z.array(objectIdSchema)),
  optionCountMismatch: z.array(objectIdSchema),
  /** Ids that no longer exist. */
  missing: z.array(objectIdSchema),
});
export type TestChecks = z.infer<typeof testChecksSchema>;

export const adminTestResponseSchema = z.object({
  test: testSchema,
  checks: testChecksSchema,
  /** Every question referenced by the test, keyed by id. */
  questions: z.record(z.string(), questionSchema),
});
export type AdminTestResponse = z.infer<typeof adminTestResponseSchema>;

export const testFillResponseSchema = adminTestResponseSchema.extend({
  report: z.array(fillReportSchema),
});
export type TestFillResponse = z.infer<typeof testFillResponseSchema>;

export const testSummarySchema = z.object({
  id: objectIdSchema,
  title: z.string(),
  examKey: slugSchema,
  templateName: z.string(),
  type: testTypeSchema,
  status: testStatusSchema,
  isFree: z.boolean(),
  questionCount: z.number().int(),
  expectedCount: z.number().int(),
  /** Draft (unreviewed) questions in the test. */
  toReview: z.number().int(),
  /** Set when the test was created from a PDF upload. */
  uploadId: objectIdSchema.nullable(),
  publishAt: isoDateSchema.nullable(),
  publishedAt: isoDateSchema.nullable(),
  updatedAt: isoDateSchema,
});
export type TestSummary = z.infer<typeof testSummarySchema>;

export const testListResponseSchema = z.object({ tests: z.array(testSummarySchema) });
export type TestListResponse = z.infer<typeof testListResponseSchema>;

// ---------- student-facing ----------

/** Card on the public exam page. */
export const publicTestCardSchema = z.object({
  id: objectIdSchema,
  title: z.string(),
  type: testTypeSchema,
  isFree: z.boolean(),
  questionCount: z.number().int(),
  totalTimeSec: z.number().int(),
  sectionCount: z.number().int(),
  publishedAt: isoDateSchema,
});
export type PublicTestCard = z.infer<typeof publicTestCardSchema>;

export const publicTestListResponseSchema = z.object({ tests: z.array(publicTestCardSchema) });
export type PublicTestListResponse = z.infer<typeof publicTestListResponseSchema>;

/**
 * A question as students see it: NO correct answers, numeric answers, solutions, answer source,
 * confidence or flags. Built only by the api's student serializer.
 */
export const studentQuestionSchema = z
  .object({
    id: objectIdSchema,
    type: questionTypeSchema,
    number: z.number().int().nullable(),
    passage: z.string(),
    passageHi: z.string(),
    stem: z.string(),
    stemHi: z.string(),
    options: z.array(z.string()),
    optionsHi: z.array(z.string()),
    hasFigure: z.boolean(),
    figureUrl: z.string().nullable(),
  })
  .strict();
export type StudentQuestion = z.infer<typeof studentQuestionSchema>;

export const studentPaperSchema = z
  .object({
    testId: objectIdSchema,
    title: z.string(),
    template: templateSnapshotSchema.pick({
      skin: true,
      totalTimeSec: true,
      optionCount: true,
      sectionSwitching: true,
      marking: true,
      markingByType: true,
      qualifyingPercent: true,
    }),
    sections: z.array(
      z.object({
        name: z.string(),
        timeSec: z.number().int().optional(),
        questions: z.array(studentQuestionSchema),
      }),
    ),
  })
  .strict();
export type StudentPaper = z.infer<typeof studentPaperSchema>;

// ---------- series ----------

export const seriesInputSchema = z.object({
  title: z.string().trim().min(2).max(160),
  examKey: slugSchema,
  tests: z
    .array(
      z.object({
        testId: objectIdSchema,
        position: z.number().int().min(0),
        isFree: z.boolean().default(false),
        releaseAt: isoDateSchema.nullable().default(null),
      }),
    )
    .max(500)
    .default([]),
});
export type SeriesInput = z.input<typeof seriesInputSchema>;

export const seriesSchema = seriesInputSchema.extend({
  id: objectIdSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Series = z.infer<typeof seriesSchema>;

export const seriesListResponseSchema = z.object({ series: z.array(seriesSchema) });

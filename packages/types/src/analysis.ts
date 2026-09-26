import { z } from "zod";
import { attemptResponseSchema, questionStateSchema } from "./attempt.js";
import { isoDateSchema, objectIdSchema } from "./common.js";
import { questionTypeSchema } from "./exam-template.js";

// ---------- rank ----------

/** Rank among the first attempts of a test (re-attempts and practice are not ranked). */
export const attemptRankSchema = z.object({
  rank: z.number().int().positive(),
  total: z.number().int().positive(),
  /** % of first attempts that scored below this one. */
  percentile: z.number(),
});
export type AttemptRank = z.infer<typeof attemptRankSchema>;

export const outcomeSchema = z.enum(["correct", "wrong", "partial", "skipped"]);
export type Outcome = z.infer<typeof outcomeSchema>;

// ---------- analysis ----------

export const sectionAnalysisSchema = z.object({
  name: z.string(),
  score: z.number(),
  maxScore: z.number(),
  correct: z.number().int(),
  wrong: z.number().int(),
  partial: z.number().int(),
  skipped: z.number().int(),
  accuracy: z.number(),
  timeMs: z.number().int(),
  /** Marks lost to wrong answers (negative marking), as a positive number. */
  negativeMarks: z.number(),
  cutoff: z.number().nullable(),
});
export type SectionAnalysis = z.infer<typeof sectionAnalysisSchema>;

export const topicAnalysisSchema = z.object({
  topic: z.string(),
  section: z.string(),
  total: z.number().int(),
  correct: z.number().int(),
  wrong: z.number().int(),
  skipped: z.number().int(),
  /** correct / total, 0–100. */
  accuracy: z.number(),
});
export type TopicAnalysis = z.infer<typeof topicAnalysisSchema>;

const benchmarkSchema = z.object({
  score: z.number(),
  accuracy: z.number(),
  timeSec: z.number().int(),
  sections: z.array(z.object({ name: z.string(), score: z.number() })),
});
export type Benchmark = z.infer<typeof benchmarkSchema>;

export const analysisQuestionSchema = z.object({
  questionId: objectIdSchema,
  number: z.number().int(),
  section: z.string(),
  outcome: outcomeSchema,
  marks: z.number(),
  timeMs: z.number().int(),
});

/** GET /api/attempts/:id/analysis */
export const attemptAnalysisSchema = z.object({
  attemptId: objectIdSchema,
  title: z.string(),
  score: z.number(),
  maxScore: z.number(),
  rank: attemptRankSchema.nullable(),
  /** One sentence of advice from the numbers. */
  advice: z.string(),
  sections: z.array(sectionAnalysisSchema),
  topics: z.array(topicAnalysisSchema),
  /** Topics with at least 3 questions, best / worst first. */
  strong: z.array(z.string()),
  weak: z.array(z.string()),
  you: benchmarkSchema,
  topper: benchmarkSchema.nullable(),
  average: benchmarkSchema.nullable(),
  cutoff: z.object({ overall: z.number().nullable(), cleared: z.boolean().nullable() }),
  questions: z.array(analysisQuestionSchema),
  practice: z.boolean(),
});
export type AttemptAnalysis = z.infer<typeof attemptAnalysisSchema>;

// ---------- solutions ----------

export const solutionItemSchema = z.object({
  questionId: objectIdSchema,
  number: z.number().int(),
  section: z.string(),
  type: questionTypeSchema,
  passage: z.string(),
  passageHi: z.string(),
  stem: z.string(),
  stemHi: z.string(),
  options: z.array(z.string()),
  optionsHi: z.array(z.string()),
  figureUrl: z.string().nullable(),
  correct: z.array(z.number().int()),
  numAnswer: z.object({ min: z.number(), max: z.number() }).nullable(),
  solution: z.string(),
  solutionHi: z.string(),
  topic: z.string(),
  yourResponse: attemptResponseSchema,
  state: questionStateSchema,
  outcome: outcomeSchema,
  marks: z.number(),
  timeMs: z.number().int(),
  /** % of first attempts that got it right (null until enough attempts). */
  correctPercent: z.number().nullable(),
  bookmarked: z.boolean(),
});
export type SolutionItem = z.infer<typeof solutionItemSchema>;

/** GET /api/attempts/:id/solutions — only after the attempt is submitted. */
export const solutionsResponseSchema = z.object({
  attemptId: objectIdSchema,
  title: z.string(),
  items: z.array(solutionItemSchema),
});
export type SolutionsResponse = z.infer<typeof solutionsResponseSchema>;

// ---------- practice, bookmarks, reports ----------

/** POST /api/attempts/:id/practice — a mini-test of the questions you got wrong (and skipped). */
export const practiceInputSchema = z.object({
  include: z.enum(["wrong", "wrong_skipped"]).default("wrong"),
});
export type PracticeInput = z.input<typeof practiceInputSchema>;
export const practiceResponseSchema = z.object({
  testId: objectIdSchema,
  attemptId: objectIdSchema,
  questionCount: z.number().int(),
});
export type PracticeResponse = z.infer<typeof practiceResponseSchema>;

export const bookmarkSchema = z.object({
  questionId: objectIdSchema,
  createdAt: isoDateSchema,
  /** Where it was bookmarked from (to link back). */
  attemptId: objectIdSchema.nullable(),
  question: solutionItemSchema.pick({
    type: true,
    passage: true,
    passageHi: true,
    stem: true,
    stemHi: true,
    options: true,
    optionsHi: true,
    figureUrl: true,
    correct: true,
    numAnswer: true,
    solution: true,
    solutionHi: true,
    topic: true,
    section: true,
  }),
});
export type Bookmark = z.infer<typeof bookmarkSchema>;
export const bookmarkInputSchema = z.object({
  questionId: objectIdSchema,
  attemptId: objectIdSchema.nullable().default(null),
});
export type BookmarkInput = z.input<typeof bookmarkInputSchema>;
export const bookmarkListResponseSchema = z.object({ bookmarks: z.array(bookmarkSchema) });
export type BookmarkListResponse = z.infer<typeof bookmarkListResponseSchema>;

export const reportReasonSchema = z.enum([
  "wrong_answer",
  "wrong_question",
  "typo",
  "missing_figure",
  "translation",
  "other",
]);
export type ReportReason = z.infer<typeof reportReasonSchema>;
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  wrong_answer: "The answer key is wrong",
  wrong_question: "The question is wrong or incomplete",
  typo: "Typo / formatting",
  missing_figure: "Figure missing or unclear",
  translation: "Hindi translation is wrong",
  other: "Something else",
};
/** Open reports on one question that pull it out of new attempts for review. */
export const REPORTS_TO_UNPUBLISH = 3;

export const reportInputSchema = z.object({
  reason: reportReasonSchema,
  note: z.string().trim().max(1000).default(""),
  attemptId: objectIdSchema.nullable().default(null),
});
export type ReportInput = z.input<typeof reportInputSchema>;

/** Admin reports queue: open reports grouped by question. */
export const reportGroupSchema = z.object({
  questionId: objectIdSchema,
  stem: z.string(),
  examKey: z.string(),
  section: z.string(),
  count: z.number().int(),
  reasons: z.partialRecord(reportReasonSchema, z.number().int()),
  notes: z.array(z.object({ note: z.string(), reason: reportReasonSchema, at: isoDateSchema })),
  /** Pulled from new attempts after REPORTS_TO_UNPUBLISH reports. */
  unpublished: z.boolean(),
  firstAt: isoDateSchema,
  lastAt: isoDateSchema,
});
export type ReportGroup = z.infer<typeof reportGroupSchema>;
export const reportListResponseSchema = z.object({ groups: z.array(reportGroupSchema) });
export type ReportListResponse = z.infer<typeof reportListResponseSchema>;
/** fix: the question was corrected (in the editor); dismiss: the report was wrong. Both reopen it. */
export const reportResolveInputSchema = z.object({ action: z.enum(["fix", "dismiss"]) });

// ---------- question stats (nightly) ----------

export const questionStatsSchema = z.object({
  questionId: objectIdSchema,
  attempts: z.number().int(),
  correct: z.number().int(),
  accuracy: z.number(),
  avgTimeMs: z.number().int(),
  /** How many chose each option (MCQ), in option order. */
  optionSplit: z.array(z.number().int()),
  skipped: z.number().int(),
  /** Upper-27% accuracy minus lower-27% accuracy, −1…1 (null with too few attempts). */
  discrimination: z.number().nullable(),
  computedAt: isoDateSchema,
});
export type QuestionStats = z.infer<typeof questionStatsSchema>;
export const questionStatsResponseSchema = z.object({ stats: questionStatsSchema.nullable() });
export type QuestionStatsResponse = z.infer<typeof questionStatsResponseSchema>;
/** A question is flagged "suspect_key" when accuracy is below this (with enough attempts)… */
export const SUSPECT_ACCURACY = 5;
/** …or a wrong option is chosen more often than the key. Needs at least this many attempts. */
export const STATS_MIN_ATTEMPTS = 20;

// ---------- answer key change + re-score ----------

/** PUT /api/admin/tests/:id/answer-key — corrects keys in place (even for published tests). */
export const answerKeyInputSchema = z.object({
  changes: z
    .array(
      z.object({
        questionId: objectIdSchema,
        correct: z.array(z.number().int().min(0).max(5)).max(6).optional(),
        numAnswer: z.object({ min: z.number(), max: z.number() }).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type AnswerKeyInput = z.infer<typeof answerKeyInputSchema>;
export const rescoreResponseSchema = z.object({ queued: z.boolean(), attempts: z.number().int() });
export type RescoreResponse = z.infer<typeof rescoreResponseSchema>;

/** PUT /api/admin/tests/:id/cutoffs — expected cut-offs (published tests too). */
export const testCutoffsSchema = z.object({
  overall: z.number().nullable(),
  /** Section name → cut-off marks. */
  sections: z.record(z.string(), z.number()),
});
export type TestCutoffs = z.infer<typeof testCutoffsSchema>;

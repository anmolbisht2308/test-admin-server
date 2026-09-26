import { z } from "zod";
import { isoDateSchema, objectIdSchema } from "./common.js";
import { MAX_OPTIONS } from "./question.js";
import { studentPaperSchema } from "./test.js";

/** Palette states, as in real CBT exams. Only "answered" and "answered_marked" are evaluated. */
export const questionStateSchema = z.enum([
  "not_visited",
  "not_answered",
  "answered",
  "marked",
  "answered_marked",
]);
export type QuestionState = z.infer<typeof questionStateSchema>;

export const EVALUATED_STATES: readonly QuestionState[] = ["answered", "answered_marked"];

/**
 * A saved response: chosen option indices (MCQ) or the typed value (integer/numeric, kept as the
 * keypad string, e.g. "-2.5"), or null when cleared.
 */
export const attemptResponseSchema = z
  .union([
    z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(MAX_OPTIONS - 1),
      )
      .max(MAX_OPTIONS),
    z
      .string()
      .max(20)
      .regex(/^-?\d*\.?\d*$/, "numbers only"),
  ])
  .nullable();
export type AttemptResponse = z.infer<typeof attemptResponseSchema>;

/** One question's saved state. `at` is the client clock (epoch ms) of the change: latest wins. */
export const answerEntrySchema = z.object({
  questionId: objectIdSchema,
  response: attemptResponseSchema,
  state: questionStateSchema,
  /** Total time spent on the question so far. */
  timeMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600 * 1000),
  at: z.number().int().positive(),
});
export type AnswerEntry = z.infer<typeof answerEntrySchema>;

/** PATCH /api/attempts/:id/answers — batched, only what changed since the last sync. */
export const answerBatchInputSchema = z.object({
  answers: z.array(answerEntrySchema).max(500),
});
export type AnswerBatchInput = z.infer<typeof answerBatchInputSchema>;

export const attemptStatusSchema = z.enum(["in_progress", "submitted", "scored"]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const submitReasonSchema = z.enum(["manual", "timeout"]);
export type SubmitReason = z.infer<typeof submitReasonSchema>;

/** Timing the client needs; `serverNow` lets it correct its own clock. */
export const attemptClockSchema = z.object({
  status: attemptStatusSchema,
  serverNow: isoDateSchema,
  deadline: isoDateSchema,
  /** locked_sequential templates: the only section that can be answered, and when it ends. */
  sectionIndex: z.number().int().min(0),
  sectionDeadline: isoDateSchema.nullable(),
});
export type AttemptClock = z.infer<typeof attemptClockSchema>;

export const attemptStateSchema = attemptClockSchema.extend({
  id: objectIdSchema,
  testId: objectIdSchema,
  startedAt: isoDateSchema,
  answers: z.array(answerEntrySchema),
});
export type AttemptState = z.infer<typeof attemptStateSchema>;

/** POST /api/attempts {testId} and GET /api/attempts/:id — never contains answers or solutions. */
export const attemptStartInputSchema = z.object({ testId: objectIdSchema });
export const attemptStartResponseSchema = z.object({
  attempt: attemptStateSchema,
  paper: studentPaperSchema,
});
export type AttemptStartResponse = z.infer<typeof attemptStartResponseSchema>;

export const answerSaveResponseSchema = attemptClockSchema.extend({ saved: z.number().int() });
export type AnswerSaveResponse = z.infer<typeof answerSaveResponseSchema>;

/** POST /api/attempts/:id/submit — the final unsynced answers ride along. */
export const attemptSubmitInputSchema = z.object({
  answers: z.array(answerEntrySchema).max(500).default([]),
});
export type AttemptSubmitInput = z.input<typeof attemptSubmitInputSchema>;

// ---------- result (basic; full analysis in Phase 6) ----------

export const sectionResultSchema = z.object({
  name: z.string(),
  score: z.number(),
  maxScore: z.number(),
  correct: z.number().int(),
  wrong: z.number().int(),
  partial: z.number().int(),
  skipped: z.number().int(),
  timeMs: z.number().int(),
});
export type SectionResult = z.infer<typeof sectionResultSchema>;

export const attemptResultSchema = z.object({
  score: z.number(),
  maxScore: z.number(),
  correct: z.number().int(),
  wrong: z.number().int(),
  partial: z.number().int(),
  skipped: z.number().int(),
  /** correct / attempted, 0–100. */
  accuracy: z.number(),
  timeTakenSec: z.number().int(),
  /** Qualifying papers (e.g. CSAT): pass mark as % of max marks. */
  qualifying: z.object({ percent: z.number(), passed: z.boolean() }).nullable(),
  sections: z.array(sectionResultSchema),
});
export type AttemptResult = z.infer<typeof attemptResultSchema>;

/** GET /api/attempts/:id/result — `result` is null until scoring finishes. */
export const attemptResultResponseSchema = z.object({
  id: objectIdSchema,
  testId: objectIdSchema,
  title: z.string(),
  status: attemptStatusSchema,
  submitReason: submitReasonSchema.nullable(),
  startedAt: isoDateSchema,
  submittedAt: isoDateSchema.nullable(),
  result: attemptResultSchema.nullable(),
});
export type AttemptResultResponse = z.infer<typeof attemptResultResponseSchema>;

/** GET /api/attempts?testId= — the student's own attempts. */
export const myAttemptSchema = z.object({
  id: objectIdSchema,
  testId: objectIdSchema,
  status: attemptStatusSchema,
  startedAt: isoDateSchema,
  submittedAt: isoDateSchema.nullable(),
  score: z.number().nullable(),
  maxScore: z.number().nullable(),
});
export const myAttemptListResponseSchema = z.object({ attempts: z.array(myAttemptSchema) });
export type MyAttemptListResponse = z.infer<typeof myAttemptListResponseSchema>;

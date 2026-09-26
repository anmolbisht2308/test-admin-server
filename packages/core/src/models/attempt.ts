import type { AnswerEntry, AttemptResult, AttemptStatus, SubmitReason } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";
import type { QuestionOutcome } from "../scoring.js";

export interface AttemptAnswer extends Omit<AnswerEntry, "questionId"> {
  questionId: Types.ObjectId;
}

export interface AttemptAttrs {
  userId: Types.ObjectId;
  testId: Types.ObjectId;
  status: AttemptStatus;
  startedAt: Date;
  /** startedAt + template total time. Saves are refused after deadline + grace. */
  deadline: Date;
  /** locked_sequential: current section and when it ends (sections advance on their timers). */
  sectionIndex: number;
  sectionDeadline: Date | null;
  /** When each finished section ended (answers made before that still count). */
  sectionEnds: Date[];
  answers: AttemptAnswer[];
  submittedAt: Date | null;
  submitReason: SubmitReason | null;
  result: AttemptResult | null;
  /** Per-question outcome, kept for Phase 6 analysis. */
  outcomes: {
    questionId: Types.ObjectId;
    outcome: QuestionOutcome;
    marks: number;
    timeMs: number;
  }[];
  scoredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const answerSchema = new Schema<AttemptAnswer>(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    response: { type: Schema.Types.Mixed, default: null },
    state: { type: String, required: true },
    timeMs: { type: Number, default: 0 },
    at: { type: Number, required: true },
  },
  { _id: false },
);

const attemptSchema = new Schema<AttemptAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    testId: { type: Schema.Types.ObjectId, ref: "Test", required: true },
    status: { type: String, default: "in_progress" },
    startedAt: { type: Date, required: true },
    deadline: { type: Date, required: true },
    sectionIndex: { type: Number, default: 0 },
    sectionDeadline: { type: Date, default: null },
    sectionEnds: { type: [Date], default: [] },
    answers: { type: [answerSchema], default: [] },
    submittedAt: { type: Date, default: null },
    submitReason: { type: String, default: null },
    result: { type: Schema.Types.Mixed, default: null },
    outcomes: {
      type: [
        new Schema(
          {
            questionId: Schema.Types.ObjectId,
            outcome: String,
            marks: Number,
            timeMs: Number,
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    scoredAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

attemptSchema.index({ userId: 1, testId: 1, createdAt: -1 });
// At most one attempt in progress per student and test.
attemptSchema.index(
  { userId: 1, testId: 1 },
  { unique: true, partialFilterExpression: { status: "in_progress" }, name: "one_in_progress" },
);
attemptSchema.index({ status: 1, deadline: 1 });
attemptSchema.index({ testId: 1, status: 1 });

export const AttemptModel = model<AttemptAttrs>("Attempt", attemptSchema, "attempts");

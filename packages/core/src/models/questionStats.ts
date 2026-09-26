import { Schema, model, type Types } from "mongoose";

/** Nightly per-question statistics (see questionStats.ts). */
export interface QuestionStatsAttrs {
  questionId: Types.ObjectId;
  attempts: number;
  correct: number;
  accuracy: number;
  avgTimeMs: number;
  optionSplit: number[];
  skipped: number;
  discrimination: number | null;
  computedAt: Date;
}

const statsSchema = new Schema<QuestionStatsAttrs>({
  questionId: { type: Schema.Types.ObjectId, ref: "Question", required: true, unique: true },
  attempts: Number,
  correct: Number,
  accuracy: Number,
  avgTimeMs: Number,
  optionSplit: [Number],
  skipped: Number,
  discrimination: { type: Number, default: null },
  computedAt: Date,
});

export const QuestionStatsModel = model<QuestionStatsAttrs>(
  "QuestionStats",
  statsSchema,
  "questionStats",
);

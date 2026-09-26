import type {
  AnswerSource,
  Difficulty,
  ExamFamily,
  QuestionStatus,
  QuestionType,
} from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

export interface QuestionAttrs {
  rootId: Types.ObjectId;
  version: number;
  isLatest: boolean;
  examKey: string;
  examFamily: ExamFamily;
  section: string;
  number: number | null;
  order: number;
  type: QuestionType;
  passage: string;
  passageHi: string;
  stem: string;
  options: string[];
  stemHi: string;
  optionsHi: string[];
  correct: number[];
  numAnswer: { min: number; max: number } | null;
  answerSource: AnswerSource;
  solution: string;
  solutionHi: string;
  subject: string;
  topic: string;
  taxonomyIds: Types.ObjectId[];
  difficulty: Difficulty;
  hasFigure: boolean;
  figureUrl: string | null;
  sourcePage: number | null;
  confidence: number;
  flags: string[];
  status: QuestionStatus;
  hash: string;
  uploadId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const questionSchema = new Schema<QuestionAttrs>(
  {
    rootId: { type: Schema.Types.ObjectId, required: true },
    version: { type: Number, required: true, default: 1 },
    isLatest: { type: Boolean, required: true, default: true },
    examKey: { type: String, required: true },
    examFamily: { type: String, required: true },
    section: { type: String, required: true },
    number: { type: Number, default: null },
    order: { type: Number, default: 0 },
    type: { type: String, required: true },
    passage: { type: String, default: "" },
    passageHi: { type: String, default: "" },
    stem: { type: String, default: "" },
    options: { type: [String], default: [] },
    stemHi: { type: String, default: "" },
    optionsHi: { type: [String], default: [] },
    correct: { type: [Number], default: [] },
    numAnswer: { type: new Schema({ min: Number, max: Number }, { _id: false }), default: null },
    answerSource: { type: String, default: "manual" },
    solution: { type: String, default: "" },
    solutionHi: { type: String, default: "" },
    subject: { type: String, default: "" },
    topic: { type: String, default: "" },
    taxonomyIds: { type: [Schema.Types.ObjectId], default: [] },
    difficulty: { type: String, default: "medium" },
    hasFigure: { type: Boolean, default: false },
    figureUrl: { type: String, default: null },
    sourcePage: { type: Number, default: null },
    confidence: { type: Number, default: 1 },
    flags: { type: [String], default: [] },
    status: { type: String, default: "draft" },
    hash: { type: String, required: true },
    uploadId: { type: Schema.Types.ObjectId, default: null },
  },
  // Validation lives in the Zod schema; Mongoose only stores.
  { timestamps: true },
);

// Bank listing + rule-based selection.
questionSchema.index({ isLatest: 1, examFamily: 1, section: 1, status: 1, difficulty: 1 });
questionSchema.index({ isLatest: 1, updatedAt: -1 });
questionSchema.index({ hash: 1, isLatest: 1 });
questionSchema.index({ rootId: 1, version: -1 });
questionSchema.index({ taxonomyIds: 1 });
questionSchema.index({ uploadId: 1 });
// Full-text search. language "none": no stemming, so Hindi and formula text match literally.
questionSchema.index(
  { stem: "text", options: "text", stemHi: "text", passage: "text", topic: "text" },
  {
    weights: { stem: 10, stemHi: 10, options: 3, topic: 3, passage: 1 },
    default_language: "none",
    name: "question_text",
  },
);

export const QuestionModel = model<QuestionAttrs>("Question", questionSchema, "questions");

import type {
  ExamFamily,
  Marking,
  QuestionType,
  SectionSwitching,
  TemplateSkin,
  TemplateSnapshot,
} from "@mockprep/types";
import { Schema, model } from "mongoose";

export interface ExamTemplateAttrs {
  key: string;
  name: string;
  family: ExamFamily;
  skin: TemplateSkin;
  totalTimeSec: number;
  optionCount: number;
  sectionSwitching: SectionSwitching;
  sections: { name: string; count: number; timeSec?: number; aliases: string[] }[];
  marking: Marking;
  markingByType?: Partial<Record<QuestionType, Marking>>;
  multiPartial?: boolean;
  qualifyingPercent?: number;
  createdAt: Date;
  updatedAt: Date;
}

const markingSchema = new Schema<Marking>(
  { correct: { type: Number, required: true }, wrong: { type: Number, required: true } },
  { _id: false },
);

const templateSchema = new Schema<ExamTemplateAttrs>(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    family: { type: String, required: true },
    skin: { type: String, required: true },
    totalTimeSec: { type: Number, required: true },
    optionCount: { type: Number, required: true },
    sectionSwitching: { type: String, required: true },
    sections: [
      new Schema(
        {
          name: { type: String, required: true },
          count: { type: Number, required: true },
          timeSec: Number,
          aliases: { type: [String], default: [] },
        },
        { _id: false },
      ),
    ],
    marking: { type: markingSchema, required: true },
    markingByType: { type: Schema.Types.Mixed, default: undefined },
    multiPartial: Boolean,
    qualifyingPercent: Number,
  },
  // Validation lives in the Zod schema (@mockprep/types); Mongoose only stores.
  { timestamps: true, minimize: true },
);

templateSchema.index({ family: 1, name: 1 });

export const ExamTemplateModel = model<ExamTemplateAttrs>(
  "ExamTemplate",
  templateSchema,
  "examTemplates",
);

/** Frozen copy of a template stored on tests (so later template edits never change old tests). */
export const toTemplateSnapshot = (t: ExamTemplateAttrs): TemplateSnapshot => ({
  key: t.key,
  name: t.name,
  family: t.family,
  skin: t.skin,
  totalTimeSec: t.totalTimeSec,
  optionCount: t.optionCount,
  sectionSwitching: t.sectionSwitching,
  sections: t.sections.map((s) => ({
    name: s.name,
    count: s.count,
    ...(s.timeSec === undefined || s.timeSec === null ? {} : { timeSec: s.timeSec }),
    aliases: [...s.aliases],
  })),
  marking: { correct: t.marking.correct, wrong: t.marking.wrong },
  ...(t.markingByType ? { markingByType: t.markingByType } : {}),
  ...(t.multiPartial ? { multiPartial: true } : {}),
  ...(t.qualifyingPercent === undefined || t.qualifyingPercent === null
    ? {}
    : { qualifyingPercent: t.qualifyingPercent }),
});

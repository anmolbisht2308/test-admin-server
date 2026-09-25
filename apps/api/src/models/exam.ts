import type { ExamFamily, ExamStatus } from "@mockprep/types";
import { Schema, model } from "mongoose";

export interface ExamAttrs {
  slug: string;
  name: string;
  shortName: string;
  family: ExamFamily;
  description: string;
  templateKeys: string[];
  status: ExamStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const examSchema = new Schema<ExamAttrs>(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    shortName: { type: String, required: true },
    family: { type: String, required: true },
    description: { type: String, default: "" },
    templateKeys: { type: [String], default: [] },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true },
);

examSchema.index({ status: 1, family: 1, sortOrder: 1 });
examSchema.index({ templateKeys: 1 });

export const ExamModel = model<ExamAttrs>("Exam", examSchema, "exams");

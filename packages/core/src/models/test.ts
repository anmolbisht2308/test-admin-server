import type { TemplateSnapshot, TestStatus, TestType } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

export interface TestAttrs {
  title: string;
  examKey: string;
  type: TestType;
  templateSnapshot: TemplateSnapshot;
  sections: { name: string; timeSec?: number; questionIds: Types.ObjectId[] }[];
  testFlags: string[];
  uploadId: Types.ObjectId | null;
  status: TestStatus;
  isFree: boolean;
  publishAt: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const testSchema = new Schema<TestAttrs>(
  {
    title: { type: String, required: true },
    examKey: { type: String, required: true },
    type: { type: String, required: true },
    // Frozen copy of the exam template at creation time.
    templateSnapshot: { type: Schema.Types.Mixed, required: true },
    sections: [
      new Schema(
        {
          name: String,
          timeSec: Number,
          questionIds: { type: [Schema.Types.ObjectId], default: [] },
        },
        { _id: false },
      ),
    ],
    testFlags: { type: [String], default: [] },
    uploadId: { type: Schema.Types.ObjectId, ref: "Upload", default: null },
    status: { type: String, default: "draft" },
    isFree: { type: Boolean, default: true },
    publishAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

testSchema.index({ examKey: 1, status: 1, publishedAt: -1 });
testSchema.index({ "sections.questionIds": 1, status: 1 });
testSchema.index({ status: 1, publishedAt: -1 });

export const TestModel = model<TestAttrs>("Test", testSchema, "tests");

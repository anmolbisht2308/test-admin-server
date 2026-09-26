import type { ReportReason } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

/** "Report an error" from a student on a question. */
export interface ReportAttrs {
  questionId: Types.ObjectId;
  userId: Types.ObjectId;
  attemptId: Types.ObjectId | null;
  reason: ReportReason;
  note: string;
  status: "open" | "fixed" | "dismissed";
  resolvedBy: Types.ObjectId | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<ReportAttrs>(
  {
    questionId: { type: Schema.Types.ObjectId, ref: "Question", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    attemptId: { type: Schema.Types.ObjectId, ref: "Attempt", default: null },
    reason: { type: String, required: true },
    note: { type: String, default: "" },
    status: { type: String, default: "open" },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
reportSchema.index({ status: 1, questionId: 1 });
// One open report per student per question.
reportSchema.index(
  { questionId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: "open" }, name: "one_open_report" },
);

export const ReportModel = model<ReportAttrs>("Report", reportSchema, "reports");

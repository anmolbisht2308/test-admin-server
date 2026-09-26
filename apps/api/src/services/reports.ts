import { QuestionModel, ReportModel, TestModel } from "@mockprep/core";
import { REPORTS_TO_UNPUBLISH } from "@mockprep/types";
import type { Types } from "mongoose";

/** Touch the tests using a question so their cached student papers are rebuilt. */
async function refreshPapers(questionId: Types.ObjectId) {
  await TestModel.updateMany(
    { "sections.questionIds": questionId },
    { $set: { updatedAt: new Date() } },
  );
}

/**
 * After a new report: with REPORTS_TO_UNPUBLISH open reports the question is pulled from new
 * attempts (flag "reported", status draft) until an admin fixes or dismisses the reports.
 * Returns true when it was pulled now.
 */
export async function pullIfOverReported(questionId: Types.ObjectId): Promise<boolean> {
  const open = await ReportModel.countDocuments({ questionId, status: "open" });
  if (open < REPORTS_TO_UNPUBLISH) return false;
  const res = await QuestionModel.updateOne(
    { _id: questionId, flags: { $ne: "reported" } },
    { $addToSet: { flags: "reported" }, $set: { status: "draft" } },
  );
  if (res.modifiedCount === 0) return false;
  await refreshPapers(questionId);
  return true;
}

/** Admin resolved the reports: the question goes back into papers (approved when complete). */
export async function restoreReported(
  questionId: Types.ObjectId,
  approve: (id: Types.ObjectId) => Promise<boolean>,
) {
  const q = await QuestionModel.findById(questionId);
  if (!q || !q.flags.includes("reported")) return false;
  q.flags = q.flags.filter((f) => f !== "reported");
  await q.save();
  await approve(q._id);
  await refreshPapers(q._id);
  return true;
}

import { DUPLICATE_FLAGS, contentFlags, questionHash } from "@mockprep/core";
import { questionInputSchema, type ExamFamily, type QuestionData } from "@mockprep/types";
import { Types } from "mongoose";
import { toQuestionDto } from "../lib/dto.js";
import { HttpError, conflictError, notFoundError } from "../lib/httpError.js";
import { ExamModel } from "@mockprep/core";
import { QuestionModel, type QuestionAttrs } from "@mockprep/core";
import { TestModel } from "@mockprep/core";

export { questionHash };

/** Fields students see. Changing any of them on a question in a published test makes a new version. */
const CONTENT_FIELDS = [
  "type",
  "passage",
  "passageHi",
  "stem",
  "options",
  "stemHi",
  "optionsHi",
  "correct",
  "numAnswer",
  "solution",
  "solutionHi",
  "hasFigure",
  "figureUrl",
] as const satisfies readonly (keyof QuestionData)[];

export function contentChanged(before: QuestionAttrs, after: QuestionData): boolean {
  return CONTENT_FIELDS.some(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  );
}

/** Family of an exam slug; 400 when the exam does not exist. */
export async function examFamilyFor(examKey: string): Promise<ExamFamily> {
  const exam = await ExamModel.findOne({ slug: examKey }).select({ family: 1 }).lean();
  if (!exam) throw new HttpError(400, `Unknown exam "${examKey}"`, { examKey });
  return exam.family;
}

/** Recomputes the "duplicate" flag: another question (not a version of this one) has the same hash. */
async function withDuplicateFlag(flags: string[], hash: string, rootId: Types.ObjectId | null) {
  const clash = await QuestionModel.exists({
    hash,
    isLatest: true,
    ...(rootId ? { rootId: { $ne: rootId } } : {}),
  });
  const rest = flags.filter((f) => f !== "duplicate");
  return clash ? [...rest, "duplicate"] : rest;
}

/**
 * Flags after an edit. Questions from a PDF upload get their review flags recomputed (approved
 * ones have none); other questions only track "duplicate".
 */
async function flagsAfterEdit(
  current: QuestionAttrs & { _id: Types.ObjectId },
  data: QuestionData,
  hash: string,
) {
  const flags = await withDuplicateFlag(current.flags, hash, current.rootId);
  if (!current.uploadId) return flags;
  if (data.status === "approved") return [];
  const test = await TestModel.findOne({ "sections.questionIds": current._id })
    .select({ "templateSnapshot.optionCount": 1 })
    .lean();
  const optionCount = test?.templateSnapshot.optionCount ?? data.options.length;
  const kept = flags.filter((f) => (DUPLICATE_FLAGS as readonly string[]).includes(f));
  return [...contentFlags(data, optionCount), ...kept];
}

/** Marks a question reviewed: approved, flags cleared. 400 when it is not complete enough. */
export async function approveQuestion(doc: InstanceType<typeof QuestionModel>) {
  const check = questionInputSchema.safeParse({ ...toQuestionDto(doc), status: "approved" });
  if (!check.success) {
    const issue = check.error.issues[0];
    throw new HttpError(400, `Can't approve: ${issue?.message ?? "the question is incomplete"}`, {
      issues: check.error.issues,
    });
  }
  doc.status = "approved";
  doc.flags = [];
  await doc.save();
  return doc;
}

const toDoc = (data: QuestionData) => ({
  ...data,
  taxonomyIds: data.taxonomyIds.map((id) => new Types.ObjectId(id)),
  uploadId: data.uploadId ? new Types.ObjectId(data.uploadId) : null,
});

export async function createQuestion(data: QuestionData, extraFlags: string[] = []) {
  const _id = new Types.ObjectId();
  const hash = questionHash(data);
  return QuestionModel.create({
    ...toDoc(data),
    _id,
    rootId: _id,
    version: 1,
    isLatest: true,
    examFamily: await examFamilyFor(data.examKey),
    hash,
    flags: await withDuplicateFlag(extraFlags, hash, null),
  });
}

/** Ids (any version) that appear in tests with this status. */
export async function idsInTests(ids: Types.ObjectId[], status?: "draft" | "published") {
  const tests = await TestModel.find({
    "sections.questionIds": { $in: ids },
    ...(status ? { status } : {}),
  })
    .select({ title: 1, status: 1, "sections.questionIds": 1 })
    .lean();
  const wanted = new Set(ids.map(String));
  const used = new Map<string, { id: string; title: string; status: string }[]>();
  for (const test of tests) {
    for (const qid of test.sections.flatMap((s) => s.questionIds.map(String))) {
      if (!wanted.has(qid)) continue;
      const list = used.get(qid) ?? [];
      if (!list.some((t) => t.id === test._id.toString()))
        list.push({ id: test._id.toString(), title: test.title, status: test.status });
      used.set(qid, list);
    }
  }
  return used;
}

/**
 * Saves an edit. If the question's content changes while it is in a published test, a new version
 * is created: published tests keep the old version, draft tests move to the new one.
 */
export async function saveQuestion(id: string, data: QuestionData) {
  const current = await QuestionModel.findById(id);
  if (!current) throw notFoundError("Question");
  if (!current.isLatest)
    throw conflictError("This is an old version. Edit the latest version instead.");
  const before = toQuestionDto(current);

  const hash = questionHash(data);
  const flags = await flagsAfterEdit(current, data, hash);
  const examFamily = await examFamilyFor(data.examKey);
  const published = await TestModel.exists({
    status: "published",
    "sections.questionIds": current._id,
  });

  if (!published || !contentChanged(current, data)) {
    current.set({ ...toDoc(data), examFamily, hash, flags });
    await current.save();
    return { before, doc: current, versioned: false };
  }

  const next = await QuestionModel.create({
    ...toDoc(data),
    _id: new Types.ObjectId(),
    rootId: current.rootId,
    version: current.version + 1,
    isLatest: true,
    examFamily,
    hash,
    flags,
  });
  current.isLatest = false;
  await current.save();
  // Drafts always use the latest version.
  await TestModel.updateMany(
    { status: "draft", "sections.questionIds": current._id },
    { $set: { "sections.$[].questionIds.$[old]": next._id } },
    { arrayFilters: [{ old: current._id }] },
  );
  return { before, doc: next, versioned: true };
}

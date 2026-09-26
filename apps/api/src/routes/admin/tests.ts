import {
  answerKeyInputSchema,
  isNumericType,
  testCutoffsSchema,
  type RescoreResponse,
  testCreateInputSchema,
  testFillInputSchema,
  testPublishInputSchema,
  type ApproveAnsweredResponse,
  testUpdateInputSchema,
  type AdminTestResponse,
  type TestFillResponse,
  type TestListResponse,
  type TemplateSnapshot,
} from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import { toQuestionDto, toTemplateDto, toTestDto } from "../../lib/dto.js";
import { HttpError, conflictError, notFoundError } from "../../lib/httpError.js";
import { toStudentPaper } from "../../lib/studentPaper.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { ExamModel } from "@mockprep/core";
import { ExamTemplateModel } from "@mockprep/core";
import { QuestionModel } from "@mockprep/core";
import { AttemptModel, TestModel, type TestAttrs } from "@mockprep/core";
import type { AppContext } from "../../context.js";
import type { EnqueueRescore } from "../../services/scoreQueue.js";
import { recordAudit, recordAuditMany } from "../../services/audit.js";
import { approveQuestion } from "../../services/questions.js";
import {
  allQuestionIds,
  computeChecks,
  fillSection,
  loadQuestions,
} from "../../services/testBuilder.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

type TestDoc = TestAttrs & { _id: Types.ObjectId };

async function detail(test: TestDoc): Promise<AdminTestResponse> {
  const questions = await loadQuestions(allQuestionIds(test));
  return {
    test: toTestDto(test),
    checks: computeChecks(test, questions),
    questions: Object.fromEntries([...questions].map(([id, q]) => [id, toQuestionDto(q)])),
  };
}

async function findTest(id: unknown) {
  const test = await TestModel.findById(parseId(id, "Test"));
  if (!test || test.status === "practice") throw notFoundError("Test");
  return test;
}

const assertDraft = (test: TestAttrs) => {
  if (test.status !== "draft") throw conflictError("Unpublish the test before editing it");
};

/** /api/admin/tests */
export function adminTestsRouter(ctx: AppContext, enqueueRescore: EnqueueRescore): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const examKey = typeof req.query.examKey === "string" ? req.query.examKey : undefined;
      // Students' private practice tests are not admin content.
      const tests = await TestModel.find({
        status: { $ne: "practice" },
        ...(examKey ? { examKey } : {}),
      })
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean();
      // One query for every draft (unreviewed) question across the listed tests.
      const drafts = new Set(
        (
          await QuestionModel.find({
            _id: { $in: tests.flatMap(allQuestionIds) },
            status: "draft",
          }).distinct("_id")
        ).map(String),
      );
      const body: TestListResponse = {
        tests: tests.map((t) => ({
          id: t._id.toString(),
          title: t.title,
          examKey: t.examKey,
          templateName: t.templateSnapshot.name,
          type: t.type,
          status: t.status,
          isFree: t.isFree,
          questionCount: allQuestionIds(t).length,
          expectedCount: t.templateSnapshot.sections.reduce((acc, s) => acc + s.count, 0),
          toReview: allQuestionIds(t).filter((id) => drafts.has(id.toString())).length,
          uploadId: t.uploadId ? t.uploadId.toString() : null,
          publishAt: t.publishAt ? t.publishAt.toISOString() : null,
          publishedAt: t.publishedAt ? t.publishedAt.toISOString() : null,
          updatedAt: t.updatedAt.toISOString(),
        })),
      };
      res.json(body);
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const input = testCreateInputSchema.parse(req.body);
      const exam = await ExamModel.findOne({ slug: input.examKey }).lean();
      if (!exam) throw new HttpError(400, "Unknown exam", { examKey: input.examKey });
      if (!exam.templateKeys.includes(input.templateKey)) {
        throw new HttpError(400, `${exam.shortName} does not use this template`, {
          templateKeys: exam.templateKeys,
        });
      }
      const template = await ExamTemplateModel.findOne({ key: input.templateKey }).lean();
      if (!template) throw new HttpError(400, "Unknown template");
      const { id: _id, createdAt: _c, updatedAt: _u, ...snapshot } = toTemplateDto(template);
      const test = await TestModel.create({
        title: input.title,
        examKey: input.examKey,
        type: input.type,
        isFree: input.isFree,
        templateSnapshot: snapshot satisfies TemplateSnapshot,
        sections: snapshot.sections.map((s) => ({
          name: s.name,
          ...(s.timeSec ? { timeSec: s.timeSec } : {}),
          questionIds: [],
        })),
      });
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "create",
        after: toTestDto(test),
      });
      res.status(201).json(await detail(test));
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      res.json(await detail(await findTest(req.params.id)));
    }),
  );

  router.get(
    "/:id/preview",
    asyncHandler(async (req, res) => {
      const test = await findTest(req.params.id);
      res.json(toStudentPaper(test, await loadQuestions(allQuestionIds(test))));
    }),
  );

  router.put(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const input = testUpdateInputSchema.parse(req.body);
      const test = await findTest(req.params.id);
      assertDraft(test);
      const names = test.sections.map((s) => s.name);
      if (
        input.sections.length !== names.length ||
        input.sections.some((s, i) => s.name !== names[i])
      ) {
        throw new HttpError(400, "Sections must match the test's template", { sections: names });
      }
      const before = toTestDto(test);
      const previous = new Set(allQuestionIds(test).map(String));
      const incoming = [...new Set(input.sections.flatMap((s) => s.questionIds))];
      const docs = await QuestionModel.find({ _id: { $in: incoming } })
        .select({ isLatest: 1 })
        .lean();
      const byId = new Map(docs.map((d) => [d._id.toString(), d]));
      const unknown = incoming.filter((id) => !byId.has(id));
      const stale = incoming.filter((id) => !previous.has(id) && byId.get(id)?.isLatest === false);
      if (unknown.length) throw new HttpError(400, "Some questions do not exist", { unknown });
      if (stale.length)
        throw new HttpError(400, "Add the latest version of these questions", { stale });

      test.title = input.title;
      test.type = input.type;
      test.isFree = input.isFree;
      test.publishAt = input.publishAt ? new Date(input.publishAt) : null;
      input.sections.forEach((s, i) => {
        const section = test.sections[i];
        if (section) section.questionIds = s.questionIds.map((id) => new Types.ObjectId(id));
      });
      await test.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        before,
        after: toTestDto(test),
      });
      res.json(await detail(test));
    }),
  );

  router.post(
    "/:id/fill",
    write,
    asyncHandler(async (req, res) => {
      const input = testFillInputSchema.parse(req.body);
      const test = await findTest(req.params.id);
      assertDraft(test);
      const before = toTestDto(test);
      const report = [];
      for (const { index, rule } of input.sections) {
        if (!test.sections[index]) throw new HttpError(400, `Section ${index + 1} does not exist`);
        report.push(await fillSection(test, index, rule));
      }
      test.markModified("sections");
      await test.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        before,
        after: { ...toTestDto(test), fill: report },
      });
      const body: TestFillResponse = { ...(await detail(test)), report };
      res.json(body);
    }),
  );

  router.post(
    "/:id/publish",
    write,
    asyncHandler(async (req, res) => {
      const { force } = testPublishInputSchema.parse(req.body ?? {});
      const test = await findTest(req.params.id);
      assertDraft(test);
      const { checks } = await detail(test);
      // Missing questions or answers always block. Everything else (unreviewed drafts, counts
      // that differ from the template, option counts, duplicates) can be overridden with force.
      const blocking =
        checks.questionCount.actual === 0 ||
        checks.missing.length > 0 ||
        checks.missingAnswers.length > 0;
      if (blocking || (!checks.ok && !force)) {
        const message = checks.missingAnswers.length
          ? `${checks.missingAnswers.length} question(s) have no answer`
          : checks.questionCount.actual === 0
            ? "The test has no questions"
            : checks.drafts.length
              ? `${checks.drafts.length} question(s) are not reviewed yet`
              : checks.questionCount.actual !== checks.questionCount.expected
                ? `The test has ${checks.questionCount.actual} of the ${checks.questionCount.expected} questions its template expects`
                : "Fix the checks before publishing";
        throw new HttpError(409, message, { ...checks, canForce: !blocking });
      }
      const before = toTestDto(test);
      test.status = "published";
      test.publishedAt = new Date();
      await test.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        before,
        after: toTestDto(test),
      });
      res.json(await detail(test));
    }),
  );

  router.post(
    "/:id/approve-answered",
    write,
    asyncHandler(async (req, res) => {
      const test = await findTest(req.params.id);
      const drafts = await QuestionModel.find({
        _id: { $in: allQuestionIds(test) },
        status: "draft",
      });
      const actorId = getAuth(req).userId;
      const entries = [];
      for (const doc of drafts) {
        const before = toQuestionDto(doc);
        try {
          await approveQuestion(doc);
        } catch (err) {
          // Not complete (no stem, no answer, figure missing…): it stays for review.
          if (err instanceof HttpError && err.status === 400) continue;
          throw err;
        }
        entries.push({
          actorId,
          entity: "question",
          entityId: doc.rootId.toString(),
          action: "update" as const,
          before,
          after: toQuestionDto(doc),
        });
      }
      await recordAuditMany(entries);
      const body: ApproveAnsweredResponse = {
        approved: entries.length,
        remaining: drafts.length - entries.length,
      };
      res.json(body);
    }),
  );

  router.post(
    "/:id/unpublish",
    write,
    asyncHandler(async (req, res) => {
      const test = await findTest(req.params.id);
      if (test.status !== "published") throw conflictError("The test is not published");
      // TODO(phase 5): refuse (or warn) once students have attempts on this test.
      const before = toTestDto(test);
      test.status = "draft";
      test.publishedAt = null;
      await test.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        before,
        after: toTestDto(test),
      });
      res.json(await detail(test));
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const test = await findTest(req.params.id);
      assertDraft(test);
      const before = toTestDto(test);
      await test.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: before.id,
        action: "delete",
        before,
      });
      res.status(204).end();
    }),
  );

  router.put(
    "/:id/cutoffs",
    write,
    asyncHandler(async (req, res) => {
      const cutoffs = testCutoffsSchema.parse(req.body);
      const test = await findTest(req.params.id);
      const names = new Set(test.sections.map((s) => s.name));
      const unknown = Object.keys(cutoffs.sections).filter((n) => !names.has(n));
      if (unknown.length) throw new HttpError(400, "Unknown sections", { sections: unknown });
      const before = toTestDto(test);
      test.cutoffs = cutoffs;
      test.markModified("cutoffs");
      await test.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        before,
        after: toTestDto(test),
      });
      res.json(await detail(test));
    }),
  );

  /**
   * Corrects answer keys in place (a correction, not a content change, so no new version even in
   * published tests), then re-scores every attempt and rebuilds ranks in one worker job.
   */
  router.put(
    "/:id/answer-key",
    write,
    asyncHandler(async (req, res) => {
      const { changes } = answerKeyInputSchema.parse(req.body);
      const test = await findTest(req.params.id);
      const inTest = new Set(allQuestionIds(test).map(String));
      const outside = changes.filter((c) => !inTest.has(c.questionId));
      if (outside.length) {
        throw new HttpError(400, "Some questions are not in this test", {
          questionIds: outside.map((c) => c.questionId),
        });
      }
      const actorId = getAuth(req).userId;
      const audits = [];
      for (const change of changes) {
        const q = await QuestionModel.findById(change.questionId);
        if (!q) throw notFoundError("Question");
        const before = toQuestionDto(q);
        const numeric = isNumericType(q.type);
        if (numeric) {
          if (!change.numAnswer || change.numAnswer.min > change.numAnswer.max) {
            throw new HttpError(400, "Numeric questions need numAnswer {min ≤ max}", {
              questionId: change.questionId,
            });
          }
          q.numAnswer = change.numAnswer;
        } else {
          const correct = [...new Set(change.correct ?? [])].sort((a, b) => a - b);
          if (correct.length === 0 || correct.some((c) => c >= q.options.length)) {
            throw new HttpError(400, "Choose existing options as the answer", {
              questionId: change.questionId,
            });
          }
          if (q.type === "mcq_single" && correct.length > 1) {
            throw new HttpError(400, "Single-answer questions have one correct option", {
              questionId: change.questionId,
            });
          }
          q.correct = correct;
        }
        q.answerSource = "manual";
        q.flags = q.flags.filter(
          (f) => f !== "suspect_key" && f !== "no_answer" && f !== "ai_answer",
        );
        await q.save();
        audits.push({
          actorId,
          entity: "question",
          entityId: q.rootId.toString(),
          action: "update" as const,
          before,
          after: { ...toQuestionDto(q), answerKeyChange: true },
        });
      }
      await recordAuditMany(audits);
      const attempts = await AttemptModel.countDocuments({
        testId: test._id,
        status: { $in: ["submitted", "scored"] },
      });
      if (attempts > 0) await enqueueRescore(test.id as string);
      const body: RescoreResponse = { queued: attempts > 0, attempts };
      res.json(body);
    }),
  );

  router.post(
    "/:id/rescore",
    write,
    asyncHandler(async (req, res) => {
      const test = await findTest(req.params.id);
      const attempts = await AttemptModel.countDocuments({
        testId: test._id,
        status: { $in: ["submitted", "scored"] },
      });
      if (attempts > 0) await enqueueRescore(test.id as string);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "test",
        entityId: test.id,
        action: "update",
        after: { rescore: attempts },
      });
      const body: RescoreResponse = { queued: attempts > 0, attempts };
      res.json(body);
    }),
  );

  return router;
}

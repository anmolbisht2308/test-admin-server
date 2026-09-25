import {
  testCreateInputSchema,
  testFillInputSchema,
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
import { ExamModel } from "../../models/exam.js";
import { ExamTemplateModel } from "../../models/examTemplate.js";
import { QuestionModel } from "../../models/question.js";
import { TestModel, type TestAttrs } from "../../models/test.js";
import { recordAudit } from "../../services/audit.js";
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
  if (!test) throw notFoundError("Test");
  return test;
}

const assertDraft = (test: TestAttrs) => {
  if (test.status !== "draft") throw conflictError("Unpublish the test before editing it");
};

/** /api/admin/tests */
export function adminTestsRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const examKey = typeof req.query.examKey === "string" ? req.query.examKey : undefined;
      const tests = await TestModel.find(examKey ? { examKey } : {})
        .sort({ updatedAt: -1 })
        .limit(500)
        .lean();
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
      const test = await findTest(req.params.id);
      assertDraft(test);
      const { checks } = await detail(test);
      if (!checks.ok) throw new HttpError(409, "Fix the checks before publishing", checks);
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

  return router;
}

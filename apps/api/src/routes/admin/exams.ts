import { examInputSchema, examUpdateSchema, type ExamListResponse } from "@mockprep/types";
import { Router } from "express";
import { toExamDto } from "../../lib/dto.js";
import { HttpError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { ExamModel } from "@mockprep/core";
import { ExamTemplateModel } from "@mockprep/core";
import { recordAudit } from "../../services/audit.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

async function assertTemplatesExist(keys: string[]) {
  const found = await ExamTemplateModel.find({ key: { $in: keys } }).distinct("key");
  const missing = keys.filter((key) => !found.includes(key));
  if (missing.length > 0) throw new HttpError(400, "Unknown templates", { missing });
}

/** /api/admin/exams */
export function adminExamsRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const exams = await ExamModel.find().sort({ family: 1, sortOrder: 1, name: 1 }).lean();
      const body: ExamListResponse = { exams: exams.map(toExamDto) };
      res.json(body);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const exam = await ExamModel.findById(parseId(req.params.id, "Exam")).lean();
      if (!exam) throw notFoundError("Exam");
      res.json({ exam: toExamDto(exam) });
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const input = examInputSchema.parse(req.body);
      await assertTemplatesExist(input.templateKeys);
      const exam = await ExamModel.create(input);
      const dto = toExamDto(exam);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "exam",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      res.status(201).json({ exam: dto });
    }),
  );

  router.patch(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const input = examUpdateSchema.parse(req.body);
      const exam = await ExamModel.findById(parseId(req.params.id, "Exam"));
      if (!exam) throw notFoundError("Exam");
      if (input.templateKeys) await assertTemplatesExist(input.templateKeys);
      const before = toExamDto(exam);
      exam.set(input);
      await exam.save();
      const after = toExamDto(exam);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "exam",
        entityId: after.id,
        action: "update",
        before,
        after,
      });
      res.json({ exam: after });
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const exam = await ExamModel.findByIdAndDelete(parseId(req.params.id, "Exam"));
      if (!exam) throw notFoundError("Exam");
      const before = toExamDto(exam);
      // TODO(phase 3): refuse while tests or questions reference this exam.
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "exam",
        entityId: before.id,
        action: "delete",
        before,
      });
      res.status(204).end();
    }),
  );

  return router;
}

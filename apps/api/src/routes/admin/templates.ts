import {
  examTemplateInputSchema,
  examTemplateUpdateSchema,
  type ExamTemplateListResponse,
} from "@mockprep/types";
import { Router } from "express";
import { toTemplateDto } from "../../lib/dto.js";
import { conflictError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { ExamModel } from "../../models/exam.js";
import { ExamTemplateModel } from "../../models/examTemplate.js";
import { recordAudit } from "../../services/audit.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

/** /api/admin/templates */
export function adminTemplatesRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const templates = await ExamTemplateModel.find().sort({ family: 1, name: 1 }).lean();
      const body: ExamTemplateListResponse = { templates: templates.map(toTemplateDto) };
      res.json(body);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const template = await ExamTemplateModel.findById(parseId(req.params.id, "Template")).lean();
      if (!template) throw notFoundError("Template");
      const usedBy = await ExamModel.find({ templateKeys: template.key })
        .select({ slug: 1, name: 1 })
        .lean();
      res.json({
        template: toTemplateDto(template),
        usedBy: usedBy.map((e) => ({ id: e._id.toString(), slug: e.slug, name: e.name })),
      });
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const input = examTemplateInputSchema.parse(req.body);
      const template = await ExamTemplateModel.create(input);
      const dto = toTemplateDto(template);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "examTemplate",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      res.status(201).json({ template: dto });
    }),
  );

  /** Full replacement (cross-field rules need the whole template). `key` cannot change. */
  router.put(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const input = examTemplateUpdateSchema.parse(req.body);
      const template = await ExamTemplateModel.findById(parseId(req.params.id, "Template"));
      if (!template) throw notFoundError("Template");
      const before = toTemplateDto(template);
      template.set({
        ...input,
        markingByType: input.markingByType,
        qualifyingPercent: input.qualifyingPercent,
      });
      await template.save();
      const after = toTemplateDto(template);
      // TODO(phase 3): tests keep a templateSnapshot, so editing never changes existing tests.
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "examTemplate",
        entityId: after.id,
        action: "update",
        before,
        after,
      });
      res.json({ template: after });
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const template = await ExamTemplateModel.findById(parseId(req.params.id, "Template"));
      if (!template) throw notFoundError("Template");
      const usedBy = await ExamModel.find({ templateKeys: template.key }).distinct("slug");
      if (usedBy.length > 0) throw conflictError("Template is used by exams", { exams: usedBy });
      const before = toTemplateDto(template);
      await template.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "examTemplate",
        entityId: before.id,
        action: "delete",
        before,
      });
      res.status(204).end();
    }),
  );

  return router;
}

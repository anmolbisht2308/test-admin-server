import {
  examFamilySchema,
  taxonomyCreateInputSchema,
  taxonomyRenameInputSchema,
  type TaxonomyLevel,
  type TaxonomyListResponse,
} from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import { toTaxonomyDto } from "../../lib/dto.js";
import { HttpError, conflictError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { TaxonomyModel } from "@mockprep/core";
import { recordAudit } from "../../services/audit.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

const CHILD_LEVEL: Record<TaxonomyLevel, TaxonomyLevel | null> = {
  subject: "topic",
  topic: "subtopic",
  subtopic: null,
};

/** /api/admin/taxonomy: subject → topic → subtopic per exam family. */
export function adminTaxonomyRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const family = examFamilySchema.optional().parse(req.query.examFamily);
      const nodes = await TaxonomyModel.find(family ? { examFamily: family } : {})
        .sort({ path: 1 })
        .collation({ locale: "en" })
        .lean();
      const body: TaxonomyListResponse = { nodes: nodes.map(toTaxonomyDto) };
      res.json(body);
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const input = taxonomyCreateInputSchema.parse(req.body);
      const _id = new Types.ObjectId();
      let level: TaxonomyLevel = "subject";
      let path = `/${_id.toString()}/`;
      if (input.parentId) {
        const parent = await TaxonomyModel.findById(input.parentId).lean();
        if (!parent) throw new HttpError(400, "Parent not found");
        if (parent.examFamily !== input.examFamily)
          throw new HttpError(400, "Parent is in another exam family");
        const childLevel = CHILD_LEVEL[parent.level];
        if (!childLevel) throw new HttpError(400, "Subtopics cannot have children");
        level = childLevel;
        path = `${parent.path}${_id.toString()}/`;
      }
      const node = await TaxonomyModel.create({
        _id,
        examFamily: input.examFamily,
        parentId: input.parentId,
        level,
        name: input.name,
        path,
      });
      const dto = toTaxonomyDto(node);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "taxonomy",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      res.status(201).json({ node: dto });
    }),
  );

  router.patch(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const { name } = taxonomyRenameInputSchema.parse(req.body);
      const node = await TaxonomyModel.findById(parseId(req.params.id, "Taxonomy node"));
      if (!node) throw notFoundError("Taxonomy node");
      const before = toTaxonomyDto(node);
      node.name = name;
      await node.save();
      const after = toTaxonomyDto(node);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "taxonomy",
        entityId: after.id,
        action: "update",
        before,
        after,
      });
      res.json({ node: after });
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const node = await TaxonomyModel.findById(parseId(req.params.id, "Taxonomy node"));
      if (!node) throw notFoundError("Taxonomy node");
      if (await TaxonomyModel.exists({ parentId: node._id })) {
        throw conflictError("Delete or move its children first");
      }
      // TODO(phase 3): refuse while questions are tagged with this node.
      const before = toTaxonomyDto(node);
      await node.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "taxonomy",
        entityId: before.id,
        action: "delete",
        before,
      });
      res.status(204).end();
    }),
  );

  return router;
}

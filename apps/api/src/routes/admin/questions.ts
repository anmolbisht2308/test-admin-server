import {
  questionBulkInputSchema,
  questionInputSchema,
  questionListQuerySchema,
  type DuplicateGroupsResponse,
  type QuestionBulkResponse,
  type QuestionListResponse,
  type QuestionSaveResponse,
} from "@mockprep/types";
import { Router } from "express";
import { Types, type QueryFilter } from "mongoose";
import { toQuestionDto } from "../../lib/dto.js";
import { conflictError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { QuestionModel, QuestionStatsModel, type QuestionAttrs } from "@mockprep/core";
import { TaxonomyModel } from "@mockprep/core";
import { recordAudit, recordAuditMany } from "../../services/audit.js";
import type { QuestionStatsResponse } from "@mockprep/types";
import {
  approveQuestion,
  createQuestion,
  idsInTests,
  saveQuestion,
} from "../../services/questions.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactCI = (value: string) => new RegExp(`^${escapeRegex(value)}$`, "i");

/** A taxonomy node and all its descendants. */
async function taxonomySubtree(id: string): Promise<Types.ObjectId[]> {
  const nodes = await TaxonomyModel.find({ path: { $regex: `/${id}/` } })
    .select({ _id: 1 })
    .lean();
  return nodes.map((n) => n._id);
}

/** /api/admin/questions */
export function adminQuestionsRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = questionListQuerySchema.parse(req.query);
      const filter: QueryFilter<QuestionAttrs> = { isLatest: true };
      if (q.examFamily) filter.examFamily = q.examFamily;
      if (q.examKey) filter.examKey = q.examKey;
      if (q.section) filter.section = exactCI(q.section);
      if (q.topic) filter.topic = exactCI(q.topic);
      if (q.difficulty) filter.difficulty = q.difficulty;
      if (q.status) filter.status = q.status;
      if (q.answerSource) filter.answerSource = q.answerSource;
      if (q.type) filter.type = q.type;
      if (q.taxonomyId) filter.taxonomyIds = { $in: await taxonomySubtree(q.taxonomyId) };
      if (q.exclude.length)
        filter._id = {
          $nin: q.exclude
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id)),
        };
      if (q.q) filter.$text = { $search: q.q };

      const query = QuestionModel.find(filter)
        .sort(q.q ? { score: { $meta: "textScore" } } : { updatedAt: -1, _id: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize);
      if (q.q) query.select({ score: { $meta: "textScore" } });
      const [docs, total] = await Promise.all([query.lean(), QuestionModel.countDocuments(filter)]);
      const body: QuestionListResponse = {
        questions: docs.map(toQuestionDto),
        total,
        page: q.page,
        pageSize: q.pageSize,
      };
      res.json(body);
    }),
  );

  router.get(
    "/duplicates",
    asyncHandler(async (_req, res) => {
      const groups = await QuestionModel.aggregate<{ _id: string; ids: Types.ObjectId[] }>([
        { $match: { isLatest: true } },
        { $group: { _id: "$hash", ids: { $push: "$_id" }, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 200 },
      ]);
      const docs = await QuestionModel.find({ _id: { $in: groups.flatMap((g) => g.ids) } }).lean();
      const byId = new Map(docs.map((d) => [d._id.toString(), d]));
      const body: DuplicateGroupsResponse = {
        groups: groups.map((g) => ({
          hash: g._id,
          questions: g.ids.flatMap((id) => {
            const d = byId.get(id.toString());
            return d ? [toQuestionDto(d)] : [];
          }),
        })),
      };
      res.json(body);
    }),
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const doc = await QuestionModel.findById(parseId(req.params.id, "Question")).lean();
      if (!doc) throw notFoundError("Question");
      const versions = await QuestionModel.find({ rootId: doc.rootId })
        .select({ _id: 1, version: 1, isLatest: 1, updatedAt: 1 })
        .sort({ version: -1 })
        .lean();
      const used = await idsInTests(versions.map((v) => v._id));
      res.json({
        question: toQuestionDto(doc),
        versions: versions.map((v) => ({
          id: v._id.toString(),
          version: v.version,
          isLatest: v.isLatest,
          updatedAt: v.updatedAt.toISOString(),
          usedIn: used.get(v._id.toString()) ?? [],
        })),
      });
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const data = questionInputSchema.parse(req.body);
      const doc = await createQuestion(data);
      const dto = toQuestionDto(doc);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "question",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      const body: QuestionSaveResponse = { question: dto, versioned: false };
      res.status(201).json(body);
    }),
  );

  router.put(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const data = questionInputSchema.parse(req.body);
      const { before, doc, versioned } = await saveQuestion(
        parseId(req.params.id, "Question"),
        data,
      );
      const dto = toQuestionDto(doc);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "question",
        entityId: dto.rootId,
        action: "update",
        before,
        after: { ...dto, ...(versioned ? { newVersionOf: before.id } : {}) },
      });
      const body: QuestionSaveResponse = { question: dto, versioned };
      res.json(body);
    }),
  );

  router.post(
    "/:id/approve",
    write,
    asyncHandler(async (req, res) => {
      const doc = await QuestionModel.findById(parseId(req.params.id, "Question"));
      if (!doc) throw notFoundError("Question");
      if (!doc.isLatest) throw conflictError("This is an old version. Approve the latest version.");
      const before = toQuestionDto(doc);
      await approveQuestion(doc);
      const dto = toQuestionDto(doc);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "question",
        entityId: dto.rootId,
        action: "update",
        before,
        after: dto,
      });
      const body: QuestionSaveResponse = { question: dto, versioned: false };
      res.json(body);
    }),
  );

  router.get(
    "/:id/stats",
    asyncHandler(async (req, res) => {
      const stats = await QuestionStatsModel.findOne({
        questionId: parseId(req.params.id, "Question"),
      }).lean();
      const body: QuestionStatsResponse = {
        stats: stats
          ? {
              questionId: stats.questionId.toString(),
              attempts: stats.attempts,
              correct: stats.correct,
              accuracy: stats.accuracy,
              avgTimeMs: stats.avgTimeMs,
              optionSplit: [...stats.optionSplit],
              skipped: stats.skipped,
              discrimination: stats.discrimination,
              computedAt: stats.computedAt.toISOString(),
            }
          : null,
      };
      res.json(body);
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const doc = await QuestionModel.findById(parseId(req.params.id, "Question"));
      if (!doc) throw notFoundError("Question");
      const used = (await idsInTests([doc._id])).get(doc.id);
      if (used?.length) throw conflictError("Remove it from these tests first", { tests: used });
      const before = toQuestionDto(doc);
      await doc.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "question",
        entityId: before.rootId,
        action: "delete",
        before,
      });
      res.status(204).end();
    }),
  );

  router.post(
    "/bulk",
    write,
    asyncHandler(async (req, res) => {
      const input = questionBulkInputSchema.parse(req.body);
      const actorId = getAuth(req).userId;
      const ids = [...new Set(input.ids)].map((id) => new Types.ObjectId(id));
      const docs = await QuestionModel.find({ _id: { $in: ids }, isLatest: true });
      const found = new Set(docs.map((d) => d.id));
      const skipped: QuestionBulkResponse["skipped"] = ids
        .filter((id) => !found.has(id.toString()))
        .map((id) => ({ id: id.toString(), reason: "not found or not the latest version" }));

      if (input.action === "delete") {
        const used = await idsInTests(docs.map((d) => d._id));
        const deletable = docs.filter((d) => {
          const tests = used.get(d.id);
          if (tests?.length)
            skipped.push({ id: d.id, reason: `used in ${tests.map((t) => t.title).join(", ")}` });
          return !tests?.length;
        });
        await QuestionModel.deleteMany({ _id: { $in: deletable.map((d) => d._id) } });
        await recordAuditMany(
          deletable.map((d) => ({
            actorId,
            entity: "question",
            entityId: d.rootId.toString(),
            action: "delete" as const,
            before: toQuestionDto(d),
          })),
        );
        const body: QuestionBulkResponse = { modified: deletable.length, skipped };
        res.json(body);
        return;
      }

      // Tagging only changes metadata, never what students see, so it never creates versions.
      const entries = [];
      for (const doc of docs) {
        const before = toQuestionDto(doc);
        doc.set(input.set);
        if (input.addTaxonomyIds.length) {
          const merged = new Set([...doc.taxonomyIds.map(String), ...input.addTaxonomyIds]);
          doc.taxonomyIds = [...merged].map((id) => new Types.ObjectId(id));
        }
        await doc.save();
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
      const body: QuestionBulkResponse = { modified: docs.length, skipped };
      res.json(body);
    }),
  );

  return router;
}

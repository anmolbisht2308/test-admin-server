import { seriesInputSchema } from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import { toSeriesDto } from "../../lib/dto.js";
import { HttpError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { SeriesModel } from "@mockprep/core";
import { TestModel } from "@mockprep/core";
import { recordAudit } from "../../services/audit.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

async function parseSeries(body: unknown) {
  const input = seriesInputSchema.parse(body);
  const ids = input.tests.map((t) => t.testId);
  const tests = await TestModel.find({ _id: { $in: ids } })
    .select({ examKey: 1 })
    .lean();
  const found = new Map(tests.map((t) => [t._id.toString(), t.examKey]));
  const problems = ids.filter((id) => found.get(id) !== input.examKey);
  if (problems.length)
    throw new HttpError(400, "Every test must exist and belong to the series' exam", {
      tests: problems,
    });
  return {
    ...input,
    tests: input.tests.map((t) => ({
      ...t,
      testId: new Types.ObjectId(t.testId),
      releaseAt: t.releaseAt ? new Date(t.releaseAt) : null,
    })),
  };
}

/** /api/admin/series — test series (sold as plans in Phase 7). TODO(phase 7): admin UI. */
export function adminSeriesRouter(): Router {
  const router = Router();
  const write = requireRole(...CONTENT_WRITERS);

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const series = await SeriesModel.find().sort({ updatedAt: -1 }).lean();
      res.json({ series: series.map(toSeriesDto) });
    }),
  );

  router.post(
    "/",
    write,
    asyncHandler(async (req, res) => {
      const series = await SeriesModel.create(await parseSeries(req.body));
      const dto = toSeriesDto(series);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "series",
        entityId: dto.id,
        action: "create",
        after: dto,
      });
      res.status(201).json({ series: dto });
    }),
  );

  router.put(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const series = await SeriesModel.findById(parseId(req.params.id, "Series"));
      if (!series) throw notFoundError("Series");
      const before = toSeriesDto(series);
      series.set(await parseSeries(req.body));
      await series.save();
      const after = toSeriesDto(series);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "series",
        entityId: after.id,
        action: "update",
        before,
        after,
      });
      res.json({ series: after });
    }),
  );

  router.delete(
    "/:id",
    write,
    asyncHandler(async (req, res) => {
      const series = await SeriesModel.findByIdAndDelete(parseId(req.params.id, "Series"));
      if (!series) throw notFoundError("Series");
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "series",
        entityId: series.id,
        action: "delete",
        before: toSeriesDto(series),
      });
      res.status(204).end();
    }),
  );

  return router;
}

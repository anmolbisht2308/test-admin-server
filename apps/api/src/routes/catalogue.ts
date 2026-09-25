import { slugSchema, type ExamDetailResponse, type ExamListResponse } from "@mockprep/types";
import { Router } from "express";
import { toExamDto, toTemplateDto } from "../lib/dto.js";
import { notFoundError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { ExamModel } from "../models/exam.js";
import { ExamTemplateModel } from "../models/examTemplate.js";

// Public catalogue changes rarely; short cache keeps admin edits visible within a minute.
const CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";

/** Public exam catalogue. Mounted at /api/exams. */
export function catalogueRouter(): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const exams = await ExamModel.find({ status: "published" })
        .sort({ sortOrder: 1, name: 1 })
        .lean();
      const body: ExamListResponse = { exams: exams.map(toExamDto) };
      res.set("Cache-Control", CACHE).json(body);
    }),
  );

  router.get(
    "/:slug",
    asyncHandler(async (req, res) => {
      const slug = slugSchema.safeParse(req.params.slug);
      if (!slug.success) throw notFoundError("Exam");
      const exam = await ExamModel.findOne({ slug: slug.data, status: "published" }).lean();
      if (!exam) throw notFoundError("Exam");
      const templates = await ExamTemplateModel.find({ key: { $in: exam.templateKeys } }).lean();
      const byKey = new Map(templates.map((t) => [t.key, t]));
      const body: ExamDetailResponse = {
        exam: toExamDto(exam),
        templates: exam.templateKeys.flatMap((key) => {
          const t = byKey.get(key);
          return t ? [toTemplateDto(t)] : [];
        }),
      };
      res.set("Cache-Control", CACHE).json(body);
    }),
  );

  return router;
}

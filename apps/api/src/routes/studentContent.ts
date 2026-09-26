import { AttemptModel, BookmarkModel, QuestionModel, ReportModel, TestModel } from "@mockprep/core";
import {
  bookmarkInputSchema,
  objectIdSchema,
  reportInputSchema,
  type BookmarkListResponse,
} from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import type { AppContext } from "../context.js";
import { HttpError, notFoundError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getAuth, requireAuth, requireRole } from "../middleware/auth.js";
import { pullIfOverReported } from "../services/reports.js";

/** Tests the student has attempted (any status / only finished ones). */
async function attemptedTestIds(userId: string, finishedOnly: boolean) {
  return AttemptModel.distinct("testId", {
    userId,
    ...(finishedOnly ? { status: { $in: ["submitted", "scored"] } } : {}),
  });
}

/** Bookmarks (/api/bookmarks) and error reports (/api/questions/:id/report) for students. */
export function studentContentRouter(ctx: AppContext): Router {
  const router = Router();
  // Guards per route: this router is mounted at /api, so a router-wide guard would catch every
  // other /api request too.
  const student = [requireAuth(ctx.tokens), requireRole("student")];

  router.get(
    "/bookmarks",
    ...student,
    asyncHandler(async (req, res) => {
      const userId = getAuth(req).userId;
      const marks = await BookmarkModel.find({ userId }).sort({ createdAt: -1 }).limit(500).lean();
      const questions = new Map(
        (await QuestionModel.find({ _id: { $in: marks.map((b) => b.questionId) } }).lean()).map(
          (q) => [q._id.toString(), q],
        ),
      );
      const body: BookmarkListResponse = {
        bookmarks: marks.flatMap((b) => {
          const q = questions.get(b.questionId.toString());
          if (!q) return [];
          return [
            {
              questionId: b.questionId.toString(),
              createdAt: b.createdAt.toISOString(),
              attemptId: b.attemptId ? b.attemptId.toString() : null,
              question: {
                type: q.type,
                passage: q.passage,
                passageHi: q.passageHi,
                stem: q.stem,
                stemHi: q.stemHi,
                options: [...q.options],
                optionsHi: [...q.optionsHi],
                figureUrl: q.figureUrl ?? null,
                correct: [...q.correct],
                numAnswer: q.numAnswer ?? null,
                solution: q.solution,
                solutionHi: q.solutionHi,
                topic: q.topic,
                section: q.section,
              },
            },
          ];
        }),
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.post(
    "/bookmarks",
    ...student,
    asyncHandler(async (req, res) => {
      const { questionId, attemptId } = bookmarkInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      // Only questions from tests the student has finished (their solutions are already open).
      const tests = await attemptedTestIds(userId, true);
      const allowed = await TestModel.exists({
        _id: { $in: tests },
        "sections.questionIds": questionId,
      });
      if (!allowed) throw notFoundError("Question");
      await BookmarkModel.updateOne(
        { userId, questionId },
        { $setOnInsert: { attemptId: attemptId ? new Types.ObjectId(attemptId) : null } },
        { upsert: true },
      );
      res.status(201).json({ bookmarked: true });
    }),
  );

  router.delete(
    "/bookmarks/:questionId",
    ...student,
    asyncHandler(async (req, res) => {
      const questionId = objectIdSchema.safeParse(req.params.questionId);
      if (!questionId.success) throw notFoundError("Bookmark");
      await BookmarkModel.deleteOne({ userId: getAuth(req).userId, questionId: questionId.data });
      res.status(204).end();
    }),
  );

  router.post(
    "/questions/:id/report",
    ...student,
    asyncHandler(async (req, res) => {
      const questionId = objectIdSchema.safeParse(req.params.id);
      if (!questionId.success) throw notFoundError("Question");
      const input = reportInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      // Students report questions they have seen in a test.
      const tests = await attemptedTestIds(userId, false);
      const seen = await TestModel.exists({
        _id: { $in: tests },
        "sections.questionIds": questionId.data,
      });
      if (!seen) throw notFoundError("Question");
      try {
        await ReportModel.create({
          questionId: questionId.data,
          userId,
          attemptId: input.attemptId,
          reason: input.reason,
          note: input.note,
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw new HttpError(409, "You have already reported this question. Thanks, we're on it.");
        }
        throw err;
      }
      const pulled = await pullIfOverReported(new Types.ObjectId(questionId.data));
      res.status(201).json({ reported: true, pulled });
    }),
  );

  return router;
}

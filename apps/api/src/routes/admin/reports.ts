import { QuestionModel, ReportModel } from "@mockprep/core";
import {
  reportResolveInputSchema,
  type ReportGroup,
  type ReportListResponse,
  type ReportReason,
} from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import { HttpError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { recordAudit } from "../../services/audit.js";
import { approveQuestion } from "../../services/questions.js";
import { restoreReported } from "../../services/reports.js";
import { CONTENT_WRITERS, parseId } from "./common.js";

/** /api/admin/reports — students' "Report an error", grouped by question. */
export function adminReportsRouter(): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const reports = await ReportModel.find({ status: "open" })
        .sort({ createdAt: 1 })
        .limit(2000)
        .lean();
      const byQuestion = new Map<string, typeof reports>();
      for (const r of reports) {
        const key = r.questionId.toString();
        byQuestion.set(key, [...(byQuestion.get(key) ?? []), r]);
      }
      const questions = new Map(
        (
          await QuestionModel.find({ _id: { $in: [...byQuestion.keys()] } })
            .select({ stem: 1, stemHi: 1, examKey: 1, section: 1, flags: 1 })
            .lean()
        ).map((q) => [q._id.toString(), q]),
      );
      const groups: ReportGroup[] = [...byQuestion.entries()].map(([questionId, list]) => {
        const q = questions.get(questionId);
        const reasons: Partial<Record<ReportReason, number>> = {};
        for (const r of list) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
        return {
          questionId,
          stem: q?.stem || q?.stemHi || "(deleted question)",
          examKey: q?.examKey ?? "",
          section: q?.section ?? "",
          count: list.length,
          reasons,
          notes: list
            .filter((r) => r.note)
            .map((r) => ({ note: r.note, reason: r.reason, at: r.createdAt.toISOString() })),
          unpublished: q?.flags.includes("reported") ?? false,
          firstAt: (list[0]?.createdAt ?? new Date()).toISOString(),
          lastAt: (list.at(-1)?.createdAt ?? new Date()).toISOString(),
        };
      });
      // Most reported first.
      groups.sort((a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt));
      const body: ReportListResponse = { groups };
      res.json(body);
    }),
  );

  router.post(
    "/:questionId/resolve",
    requireRole(...CONTENT_WRITERS),
    asyncHandler(async (req, res) => {
      const { action } = reportResolveInputSchema.parse(req.body);
      const questionId = new Types.ObjectId(parseId(req.params.questionId, "Question"));
      const actorId = getAuth(req).userId;
      const result = await ReportModel.updateMany(
        { questionId, status: "open" },
        {
          $set: {
            status: action === "fix" ? "fixed" : "dismissed",
            resolvedBy: actorId,
            resolvedAt: new Date(),
          },
        },
      );
      if (result.modifiedCount === 0) throw notFoundError("Open reports for this question");
      const restored = await restoreReported(questionId, async (id) => {
        const q = await QuestionModel.findById(id);
        if (!q) return false;
        try {
          await approveQuestion(q);
          return true;
        } catch (err) {
          // Still incomplete: it stays a draft for the editor.
          if (err instanceof HttpError && err.status === 400) return false;
          throw err;
        }
      });
      await recordAudit({
        actorId,
        entity: "question",
        entityId: questionId.toString(),
        action: "update",
        after: { reports: action, resolved: result.modifiedCount, restored },
      });
      res.json({ resolved: result.modifiedCount, restored });
    }),
  );

  return router;
}

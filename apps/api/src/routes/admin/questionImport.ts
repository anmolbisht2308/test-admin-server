import express, { Router } from "express";
import { HttpError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import { recordAudit } from "../../services/audit.js";
import { XLSX_TYPE, buildImportTemplate, importQuestions } from "../../services/questionImport.js";
import { CONTENT_WRITERS } from "./common.js";

/** /api/admin/questions/import — body is the raw .xlsx or .csv file. */
export function adminQuestionImportRouter(): Router {
  const router = Router();

  router.get(
    "/import/template",
    asyncHandler(async (_req, res) => {
      res
        .set("Content-Type", XLSX_TYPE)
        .set("Content-Disposition", 'attachment; filename="mockprep-questions-template.xlsx"')
        .send(await buildImportTemplate());
    }),
  );

  router.post(
    "/import",
    requireRole(...CONTENT_WRITERS),
    express.raw({ type: [XLSX_TYPE, "text/csv", "application/octet-stream"], limit: "10mb" }),
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new HttpError(400, "Upload an .xlsx or .csv file as the request body");
      }
      const filename = typeof req.query.filename === "string" ? req.query.filename : "upload";
      const isCsv = req.is("text/csv") === "text/csv" || /\.csv$/i.test(filename);
      const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
      const report = await importQuestions(req.body, { isCsv, dryRun });
      if (!dryRun && report.imported > 0) {
        await recordAudit({
          actorId: getAuth(req).userId,
          entity: "questionImport",
          entityId: filename,
          action: "create",
          after: {
            imported: report.imported,
            rejected: report.rejected.length,
            duplicates: report.duplicates,
          },
        });
      }
      res.json(report);
    }),
  );

  return router;
}

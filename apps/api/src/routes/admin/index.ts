import { ADMIN_ROLES } from "@mockprep/types";
import { Router } from "express";
import type { AppContext } from "../../context.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { adminAuthRouter } from "../adminAuth.js";
import type { Storage } from "@mockprep/core";
import { adminFiguresRouter } from "../storage.js";
import { adminExamsRouter } from "./exams.js";
import { adminQuestionImportRouter } from "./questionImport.js";
import { adminQuestionsRouter } from "./questions.js";
import { adminSeriesRouter } from "./series.js";
import { adminTestsRouter } from "./tests.js";
import { adminUploadsRouter, type EnqueueIngest } from "./uploads.js";
import { adminTaxonomyRouter } from "./taxonomy.js";
import { adminTemplatesRouter } from "./templates.js";

/** /api/admin: auth is public; everything else needs an admin role. */
export function adminRouter(
  ctx: AppContext,
  storage: Storage,
  enqueueIngest: EnqueueIngest,
): Router {
  const router = Router();
  router.use("/auth", adminAuthRouter(ctx));

  const guarded = Router();
  guarded.use(requireAuth(ctx.tokens), requireRole(...ADMIN_ROLES));
  guarded.use("/exams", adminExamsRouter());
  guarded.use("/templates", adminTemplatesRouter());
  guarded.use("/taxonomy", adminTaxonomyRouter());
  // Import routes first: "/questions/import/template" must not match "/questions/:id".
  guarded.use("/questions", adminQuestionImportRouter());
  guarded.use("/questions", adminQuestionsRouter());
  guarded.use("/tests", adminTestsRouter());
  guarded.use("/series", adminSeriesRouter());
  guarded.use("/figures", adminFiguresRouter(storage));
  guarded.use("/uploads", adminUploadsRouter(ctx, storage, enqueueIngest));
  router.use(guarded);
  return router;
}

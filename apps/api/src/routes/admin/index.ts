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
import { adminReportsRouter } from "./reports.js";
import type { EnqueueRescore } from "../../services/scoreQueue.js";
import { adminUploadsRouter, type EnqueueIngest } from "./uploads.js";
import { adminTaxonomyRouter } from "./taxonomy.js";
import { adminTemplatesRouter } from "./templates.js";
import type { PaymentsService } from "../../services/payments.js";
import {
  adminCouponsRouter,
  adminEntitlementsRouter,
  adminOrdersRouter,
  adminPlansRouter,
  adminRevenueRouter,
} from "./payments.js";

/** /api/admin: auth is public; everything else needs an admin role. */
export function adminRouter(
  ctx: AppContext,
  storage: Storage,
  enqueueIngest: EnqueueIngest,
  enqueueRescore: EnqueueRescore,
  payments: PaymentsService,
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
  guarded.use("/tests", adminTestsRouter(ctx, enqueueRescore));
  guarded.use("/reports", adminReportsRouter());
  guarded.use("/series", adminSeriesRouter());
  guarded.use("/figures", adminFiguresRouter(storage));
  guarded.use("/uploads", adminUploadsRouter(ctx, storage, enqueueIngest));
  guarded.use("/plans", adminPlansRouter());
  guarded.use("/coupons", adminCouponsRouter());
  guarded.use("/orders", adminOrdersRouter(ctx.env, payments));
  guarded.use("/entitlements", adminEntitlementsRouter());
  guarded.use("/revenue", adminRevenueRouter());
  router.use(guarded);
  return router;
}

import { ADMIN_ROLES } from "@mockprep/types";
import { Router } from "express";
import type { AppContext } from "../../context.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { adminAuthRouter } from "../adminAuth.js";
import { adminExamsRouter } from "./exams.js";
import { adminTaxonomyRouter } from "./taxonomy.js";
import { adminTemplatesRouter } from "./templates.js";

/** /api/admin: auth is public; everything else needs an admin role. */
export function adminRouter(ctx: AppContext): Router {
  const router = Router();
  router.use("/auth", adminAuthRouter(ctx));

  const guarded = Router();
  guarded.use(requireAuth(ctx.tokens), requireRole(...ADMIN_ROLES));
  guarded.use("/exams", adminExamsRouter());
  guarded.use("/templates", adminTemplatesRouter());
  guarded.use("/taxonomy", adminTaxonomyRouter());
  router.use(guarded);
  return router;
}

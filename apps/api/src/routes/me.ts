import { onboardingInputSchema } from "@mockprep/types";
import { Router } from "express";
import type { AppContext } from "../context.js";
import { toUserDto } from "../lib/dto.js";
import { HttpError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getAuth, requireAuth, requireRole } from "../middleware/auth.js";
import { ExamModel } from "@mockprep/core";
import { UserModel } from "@mockprep/core";

/** Current user. Mounted at /api/me. */
export function meRouter(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx.tokens));

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const user = await UserModel.findById(getAuth(req).userId);
      if (!user) throw new HttpError(401, "Session expired. Please sign in again.");
      res.set("Cache-Control", "no-store").json({ user: toUserDto(user) });
    }),
  );

  router.patch(
    "/onboarding",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      const input = onboardingInputSchema.parse(req.body);
      const slugs = [...new Set(input.targetExamSlugs)];
      const found = await ExamModel.find({ slug: { $in: slugs }, status: "published" }).distinct(
        "slug",
      );
      const unknown = slugs.filter((slug) => !found.includes(slug));
      if (unknown.length > 0) throw new HttpError(400, "Unknown exams selected", { unknown });

      const user = await UserModel.findById(getAuth(req).userId);
      if (!user) throw new HttpError(401, "Session expired. Please sign in again.");
      user.name = input.name;
      user.language = input.language;
      user.targetExamSlugs = slugs;
      user.onboardedAt ??= new Date();
      await user.save();
      res.json({ user: toUserDto(user) });
    }),
  );

  return router;
}

import { googleSignInInputSchema, otpSendInputSchema, otpVerifyInputSchema } from "@mockprep/types";
import { Router } from "express";
import type { AppContext } from "../context.js";
import { HttpError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { UserModel } from "../models/user.js";
import { endSession, refreshSession, startSession } from "./sessionResponse.js";

/** Student auth: phone OTP + Google. Mounted at /api/auth. */
export function studentAuthRouter(ctx: AppContext): Router {
  const router = Router();

  router.post(
    "/otp/send",
    asyncHandler(async (req, res) => {
      const { phone } = otpSendInputSchema.parse(req.body);
      res.json(await ctx.otp.send(phone, req.ip ?? "unknown"));
    }),
  );

  router.post(
    "/otp/verify",
    asyncHandler(async (req, res) => {
      const { phone, code } = otpVerifyInputSchema.parse(req.body);
      await ctx.otp.verify(phone, code);
      const user =
        (await UserModel.findOne({ phone })) ??
        (await UserModel.create({ role: "student", phone }));
      if (user.role !== "student") throw new HttpError(403, "Use the admin panel to sign in");
      await startSession(ctx, req, res, user, "student");
    }),
  );

  router.post(
    "/google",
    asyncHandler(async (req, res) => {
      if (!ctx.google) throw new HttpError(400, "Google sign-in is not configured");
      const { idToken } = googleSignInInputSchema.parse(req.body);
      const identity = await ctx.google.verify(idToken);

      let user = await UserModel.findOne({ googleSub: identity.sub });
      if (!user && identity.email) {
        // Link to an existing student with the same verified email.
        const byEmail = await UserModel.findOne({ email: identity.email });
        if (byEmail?.role === "student") {
          byEmail.googleSub = identity.sub;
          user = byEmail;
        } else if (byEmail) {
          throw new HttpError(403, "Use the admin panel to sign in");
        }
      }
      user ??= new UserModel({
        role: "student",
        googleSub: identity.sub,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
      });
      if (user.role !== "student") throw new HttpError(403, "Use the admin panel to sign in");
      await startSession(ctx, req, res, user, "student");
    }),
  );

  router.post(
    "/refresh",
    asyncHandler((req, res) => refreshSession(ctx, req, res, "student")),
  );
  router.post(
    "/logout",
    asyncHandler((req, res) => endSession(ctx, req, res, "student")),
  );

  return router;
}

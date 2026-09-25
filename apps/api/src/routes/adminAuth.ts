import {
  adminLoginInputSchema,
  adminTotpVerifyInputSchema,
  type AdminLoginResponse,
} from "@mockprep/types";
import argon2 from "argon2";
import { Router } from "express";
import QRCode from "qrcode";
import type { AppContext } from "../context.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { HttpError } from "../lib/httpError.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { UserModel } from "../models/user.js";
import { enforceLimit } from "../services/rateLimit.js";
import { endSession, refreshSession, startSession } from "./sessionResponse.js";

const badCredentials = () => new HttpError(401, "Incorrect email or password");

// Verified against when the email is unknown, so response time doesn't reveal which emails exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= argon2.hash("not-a-real-password"));

/** Admin auth: email + password, then TOTP (enrolment forced on first login). /api/admin/auth */
export function adminAuthRouter(ctx: AppContext): Router {
  const router = Router();

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const { email, password } = adminLoginInputSchema.parse(req.body);
      const message = "Too many sign-in attempts. Try again in a few minutes.";
      await enforceLimit(ctx.redis, `admin-login:ip:${req.ip}`, 30, 900, message);
      await enforceLimit(ctx.redis, `admin-login:email:${email}`, 10, 900, message);

      const user = await UserModel.findOne({ email, role: { $ne: "student" } });
      if (!user?.passwordHash) {
        await argon2.verify(await getDummyHash(), password);
        throw badCredentials();
      }
      if (!(await argon2.verify(user.passwordHash, password))) throw badCredentials();
      if (user.disabledAt) throw new HttpError(403, "This account is disabled");

      const challengeToken = await ctx.tokens.signTotpChallenge(user.id);
      let body: AdminLoginResponse;
      if (user.totp?.enabled) {
        body = { status: "totp_required", challengeToken };
      } else {
        // Keep a pending secret across retries so an already-scanned QR keeps working.
        const secret = user.totp?.secretEnc
          ? decrypt(user.totp.secretEnc, ctx.env.TOTP_ENCRYPTION_KEY)
          : generateTotpSecret();
        if (!user.totp?.secretEnc) {
          user.totp = { secretEnc: encrypt(secret, ctx.env.TOTP_ENCRYPTION_KEY), enabled: false };
          await user.save();
        }
        const url = otpauthUrl(ctx.env.ADMIN_TOTP_ISSUER, email, secret);
        body = {
          status: "totp_setup_required",
          challengeToken,
          otpauthUrl: url,
          qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }),
          secret,
        };
      }
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.post(
    "/totp/verify",
    asyncHandler(async (req, res) => {
      const { challengeToken, code } = adminTotpVerifyInputSchema.parse(req.body);
      const userId = await ctx.tokens
        .verifyTotpChallenge(challengeToken)
        .catch(() =>
          Promise.reject(new HttpError(401, "Sign-in expired. Enter your password again.")),
        );
      await enforceLimit(
        ctx.redis,
        `admin-totp:${userId}`,
        5,
        300,
        "Too many wrong codes. Try again in 5 minutes.",
      );

      const user = await UserModel.findById(userId);
      if (!user?.totp?.secretEnc || user.role === "student")
        throw new HttpError(401, "Sign-in expired. Enter your password again.");

      const secret = decrypt(user.totp.secretEnc, ctx.env.TOTP_ENCRYPTION_KEY);
      const step = verifyTotp(secret, code, Date.now());
      if (step === null || step <= (user.totp.lastUsedStep ?? -1)) {
        throw new HttpError(400, "Incorrect or already used code");
      }
      user.totp = { secretEnc: user.totp.secretEnc, enabled: true, lastUsedStep: step };
      await startSession(ctx, req, res, user, "admin");
    }),
  );

  router.post(
    "/refresh",
    asyncHandler((req, res) => refreshSession(ctx, req, res, "admin")),
  );
  router.post(
    "/logout",
    asyncHandler((req, res) => endSession(ctx, req, res, "admin")),
  );

  return router;
}

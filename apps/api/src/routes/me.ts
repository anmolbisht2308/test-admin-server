import {
  CouponModel,
  EntitlementModel,
  InvoiceModel,
  OrderModel,
  accessFor,
  ensureReferralCode,
} from "@mockprep/core";
import {
  applyReferralInputSchema,
  onboardingInputSchema,
  type Purchase,
  type PurchaseListResponse,
  type ReferralResponse,
} from "@mockprep/types";
import { Types } from "mongoose";
import { z } from "zod";
import { toInvoiceDto } from "../lib/dto.js";
import { notFoundError } from "../lib/httpError.js";
import { sendInvoicePdf } from "../services/invoices.js";
import { parseId } from "./admin/common.js";
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
      if (input.referralCode) await applyReferral(user._id, input.referralCode).catch(() => null);
      res.json({ user: toUserDto(user) });
    }),
  );

  router.get(
    "/access",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      res.set("Cache-Control", "no-store").json(await accessFor(getAuth(req).userId));
    }),
  );

  router.get(
    "/purchases",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      const userId = new Types.ObjectId(getAuth(req).userId);
      const orders = await OrderModel.find({
        userId,
        status: { $in: ["paid", "refund_pending", "refunded"] },
      })
        .sort({ paidAt: -1 })
        .limit(200)
        .lean();
      const ids = orders.map((o) => o._id);
      const [entitlements, invoices] = await Promise.all([
        EntitlementModel.find({ orderId: { $in: ids } }).lean(),
        InvoiceModel.find({ orderId: { $in: ids } }).lean(),
      ]);
      const now = new Date();
      const purchases: Purchase[] = orders.map((o) => {
        const id = o._id.toString();
        const ent = entitlements.find((e) => e.orderId?.toString() === id);
        const inv = invoices.find((i) => i.orderId.toString() === id && i.kind === "invoice");
        const note = invoices.find((i) => i.orderId.toString() === id && i.kind === "credit_note");
        return {
          orderId: id,
          planName: o.plan.name,
          kind: o.plan.kind,
          examKeys: [...o.plan.examKeys],
          amountPaise: o.amountPaise,
          status: o.status,
          paidAt: o.paidAt?.toISOString() ?? null,
          validUntil: ent?.expiresAt.toISOString() ?? null,
          active: !!ent && !ent.revokedAt && ent.expiresAt > now,
          invoice: inv ? toInvoiceDto(inv) : null,
          creditNote: note ? toInvoiceDto(note) : null,
        };
      });
      const body: PurchaseListResponse = { purchases };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.get(
    "/purchases/:orderId/invoice",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      const { kind } = z
        .object({ kind: z.enum(["invoice", "credit_note"]).default("invoice") })
        .parse(req.query);
      const order = await OrderModel.findById(parseId(req.params.orderId, "Order")).lean();
      if (!order || order.userId.toString() !== getAuth(req).userId) throw notFoundError("Order");
      await sendInvoicePdf(res, ctx.env, order._id, kind);
    }),
  );

  router.get(
    "/referral",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      const userId = getAuth(req).userId;
      const code = await ensureReferralCode(userId);
      const [rewarded, coupons] = await Promise.all([
        UserModel.countDocuments({ referredBy: userId, referralRewardedAt: { $exists: true } }),
        CouponModel.find({ ownerUserId: userId }).sort({ createdAt: -1 }).limit(50).lean(),
      ]);
      const body: ReferralResponse = {
        code,
        rewarded,
        coupons: coupons.map((c) => ({
          code: c.code,
          kind: c.kind,
          percent: c.percent ?? null,
          flatPaise: c.flatPaise ?? null,
          expiresAt: c.expiresAt?.toISOString() ?? null,
          uses: c.uses,
        })),
      };
      res.set("Cache-Control", "no-store").json(body);
    }),
  );

  router.post(
    "/referral/apply",
    requireRole("student"),
    asyncHandler(async (req, res) => {
      const { code } = applyReferralInputSchema.parse(req.body);
      await applyReferral(new Types.ObjectId(getAuth(req).userId), code);
      res.status(204).end();
    }),
  );

  return router;
}

/** Links a new student to their referrer (once, before their first paid order, never self). */
async function applyReferral(userId: Types.ObjectId, code: string) {
  const referrer = await UserModel.findOne({ referralCode: code, role: "student" }).lean();
  if (!referrer) throw new HttpError(400, "Invalid referral code", { field: "code" });
  if (referrer._id.equals(userId)) throw new HttpError(400, "You can't use your own code");
  const paid = await OrderModel.exists({
    userId,
    status: { $ne: "created" },
    amountPaise: { $gt: 0 },
  });
  if (paid) throw new HttpError(409, "Referral codes only work before your first purchase");
  const res = await UserModel.updateOne(
    { _id: userId, referredBy: { $exists: false } },
    { $set: { referredBy: referrer._id } },
  );
  if (res.modifiedCount === 0) throw new HttpError(409, "A referral code is already applied");
}

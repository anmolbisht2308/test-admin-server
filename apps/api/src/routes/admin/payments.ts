import {
  CouponModel,
  EntitlementModel,
  InvoiceModel,
  OrderModel,
  PlanModel,
  UserModel,
} from "@mockprep/core";
import {
  adminOrderListQuerySchema,
  couponInputSchema,
  grantInputSchema,
  planInputSchema,
  refundInputSchema,
  revenueQuerySchema,
  type AdminGrant,
  type AdminGrantListResponse,
  type AdminOrderListResponse,
  type RevenueReport,
} from "@mockprep/types";
import { Router } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { toAdminOrderDto, toCouponDto, toPlanDto, toUserBrief } from "../../lib/dto.js";
import { HttpError, conflictError, notFoundError } from "../../lib/httpError.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { getAuth, requireRole } from "../../middleware/auth.js";
import type { Env } from "../../env.js";
import { recordAudit } from "../../services/audit.js";
import { sendInvoicePdf } from "../../services/invoices.js";
import type { PaymentsService } from "../../services/payments.js";
import { parseId } from "./common.js";

/** Money: plans, coupons, refunds, revenue. */
export const FINANCE = ["superadmin", "finance"] as const;
/** Orders and manual access (support cases). */
export const ORDER_DESK = ["superadmin", "finance", "support"] as const;

const PAGE_SIZE = 50;
const DAY_MS = 24 * 3600 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

const plain = (doc: object) => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;

/** /api/admin/plans */
export function adminPlansRouter(): Router {
  const router = Router();
  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const plans = await PlanModel.find().sort({ sortOrder: 1, createdAt: 1 });
      res.json({ plans: plans.map(toPlanDto) });
    }),
  );
  router.post(
    "/",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const input = planInputSchema.parse(req.body);
      const plan = await PlanModel.create(input);
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "plan",
        entityId: plan.id,
        action: "create",
        after: plain(toPlanDto(plan)),
      });
      res.status(201).json(toPlanDto(plan));
    }),
  );
  router.put(
    "/:id",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const input = planInputSchema.parse(req.body);
      const plan = await PlanModel.findById(parseId(req.params.id, "Plan"));
      if (!plan) throw notFoundError("Plan");
      const before = plain(toPlanDto(plan));
      // Past orders keep their own snapshot, so edits only affect new purchases.
      plan.set(input);
      await plan.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "plan",
        entityId: plan.id,
        action: "update",
        before,
        after: plain(toPlanDto(plan)),
      });
      res.json(toPlanDto(plan));
    }),
  );
  router.delete(
    "/:id",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const plan = await PlanModel.findById(parseId(req.params.id, "Plan"));
      if (!plan) throw notFoundError("Plan");
      if (await OrderModel.exists({ planId: plan._id })) {
        throw conflictError("This plan has orders. Deactivate it instead.");
      }
      await plan.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "plan",
        entityId: plan.id,
        action: "delete",
        before: plain(toPlanDto(plan)),
      });
      res.status(204).end();
    }),
  );
  return router;
}

/** /api/admin/coupons */
export function adminCouponsRouter(): Router {
  const router = Router();
  const toDoc = (input: z.infer<typeof couponInputSchema>) => ({
    ...input,
    percent: input.kind === "percent" ? input.percent : null,
    flatPaise: input.kind === "flat" ? input.flatPaise : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    planIds: input.planIds.map((id) => new Types.ObjectId(id)),
  });

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const { referral } = z
        .object({ referral: z.enum(["true", "false"]).optional() })
        .parse(req.query);
      const filter =
        referral === "true"
          ? { ownerUserId: { $ne: null } }
          : referral === "false"
            ? { ownerUserId: null }
            : {};
      const coupons = await CouponModel.find(filter).sort({ createdAt: -1 }).limit(500);
      res.json({ coupons: coupons.map(toCouponDto) });
    }),
  );
  router.post(
    "/",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const coupon = await CouponModel.create(toDoc(couponInputSchema.parse(req.body)));
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "coupon",
        entityId: coupon.id,
        action: "create",
        after: plain(toCouponDto(coupon)),
      });
      res.status(201).json(toCouponDto(coupon));
    }),
  );
  router.put(
    "/:id",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const input = couponInputSchema.parse(req.body);
      const coupon = await CouponModel.findById(parseId(req.params.id, "Coupon"));
      if (!coupon) throw notFoundError("Coupon");
      const before = plain(toCouponDto(coupon));
      coupon.set(toDoc(input));
      await coupon.save();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "coupon",
        entityId: coupon.id,
        action: "update",
        before,
        after: plain(toCouponDto(coupon)),
      });
      res.json(toCouponDto(coupon));
    }),
  );
  router.delete(
    "/:id",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const coupon = await CouponModel.findById(parseId(req.params.id, "Coupon"));
      if (!coupon) throw notFoundError("Coupon");
      if (await OrderModel.exists({ couponId: coupon._id })) {
        throw conflictError("This coupon has been used. Deactivate it instead.");
      }
      await coupon.deleteOne();
      await recordAudit({
        actorId: getAuth(req).userId,
        entity: "coupon",
        entityId: coupon.id,
        action: "delete",
        before: plain(toCouponDto(coupon)),
      });
      res.status(204).end();
    }),
  );
  return router;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function orderDtos(orders: Parameters<typeof toAdminOrderDto>[0][]) {
  const [users, invoices] = await Promise.all([
    UserModel.find({ _id: { $in: orders.map((o) => o.userId) } })
      .select({ name: 1, email: 1, phone: 1 })
      .lean(),
    InvoiceModel.find({ orderId: { $in: orders.map((o) => o._id) }, kind: "invoice" })
      .select({ orderId: 1, number: 1 })
      .lean(),
  ]);
  return orders.map((o) =>
    toAdminOrderDto(
      o,
      users.find((u) => u._id.equals(o.userId)),
      invoices.find((i) => i.orderId.equals(o._id))?.number ?? null,
    ),
  );
}

/** /api/admin/orders */
export function adminOrdersRouter(env: Env, payments: PaymentsService): Router {
  const router = Router();
  router.use(requireRole(...ORDER_DESK));

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const q = adminOrderListQuerySchema.parse(req.query);
      const filter: Record<string, unknown> = {};
      if (q.status) filter.status = q.status;
      if (q.planId) filter.planId = new Types.ObjectId(q.planId);
      if (q.from || q.to) {
        filter.createdAt = {
          ...(q.from ? { $gte: new Date(q.from) } : {}),
          ...(q.to ? { $lt: new Date(q.to) } : {}),
        };
      }
      if (q.q) {
        const re = new RegExp(escapeRegex(q.q), "i");
        const users = await UserModel.find({ $or: [{ email: re }, { phone: re }, { name: re }] })
          .select({ _id: 1 })
          .limit(200)
          .lean();
        filter.$or = [
          { userId: { $in: users.map((u) => u._id) } },
          { razorpayOrderId: q.q },
          { razorpayPaymentId: q.q },
          { couponCode: q.q.toUpperCase() },
        ];
      }
      const [orders, total] = await Promise.all([
        OrderModel.find(filter)
          .sort({ createdAt: -1 })
          .skip((q.page - 1) * PAGE_SIZE)
          .limit(PAGE_SIZE)
          .lean(),
        OrderModel.countDocuments(filter),
      ]);
      const body: AdminOrderListResponse = {
        orders: await orderDtos(orders),
        total,
        page: q.page,
        pageSize: PAGE_SIZE,
      };
      res.json(body);
    }),
  );

  router.get(
    "/:id/invoice",
    asyncHandler(async (req, res) => {
      const { kind } = z
        .object({ kind: z.enum(["invoice", "credit_note"]).default("invoice") })
        .parse(req.query);
      await sendInvoicePdf(res, env, new Types.ObjectId(parseId(req.params.id, "Order")), kind);
    }),
  );

  /** Full refund through the provider; access is revoked when the refund is processed. */
  router.post(
    "/:id/refund",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const { reason } = refundInputSchema.parse(req.body);
      const actorId = getAuth(req).userId;
      const id = parseId(req.params.id, "Order");
      // Claim it first so a double click never refunds twice.
      const order = await OrderModel.findOneAndUpdate(
        { _id: id, status: "paid" },
        {
          $set: {
            status: "refund_pending",
            refundReason: reason,
            refundRequestedBy: new Types.ObjectId(actorId),
          },
        },
        { returnDocument: "after" },
      ).lean();
      if (!order) {
        if (!(await OrderModel.exists({ _id: id }))) throw notFoundError("Order");
        throw conflictError("Only a paid order can be refunded");
      }
      let refundId: string | null = null;
      let processed = order.amountPaise === 0 || order.provider === "free";
      if (!processed) {
        const gateway = payments.gateway;
        try {
          if (!gateway || gateway.name !== order.provider || !order.razorpayPaymentId) {
            throw new HttpError(409, "This order can't be refunded through the provider");
          }
          const refund = await gateway.refund({
            paymentId: order.razorpayPaymentId,
            amountPaise: order.amountPaise,
            notes: { orderId: id, reason },
          });
          if (refund.status === "failed") throw new HttpError(502, "The refund failed");
          refundId = refund.id;
          processed = refund.status === "processed";
          await OrderModel.updateOne({ _id: id }, { $set: { razorpayRefundId: refund.id } });
        } catch (err) {
          await OrderModel.updateOne(
            { _id: id, status: "refund_pending" },
            { $set: { status: "paid", refundReason: null, refundRequestedBy: null } },
          );
          throw err;
        }
      }
      // Pending refunds finish on the refund.processed webhook.
      if (processed) await payments.refunded(id, refundId, reason);
      await recordAudit({
        actorId,
        entity: "order",
        entityId: id,
        action: "update",
        before: { status: "paid" },
        after: { status: processed ? "refunded" : "refund_pending", reason },
      });
      const fresh = await OrderModel.findById(id).lean();
      const [dto] = await orderDtos(fresh ? [fresh] : []);
      res.json(dto);
    }),
  );
  return router;
}

/** /api/admin/entitlements — manual access for support cases. */
export function adminEntitlementsRouter(): Router {
  const router = Router();
  router.use(requireRole(...ORDER_DESK));

  async function grantDtos(
    list: Awaited<ReturnType<typeof EntitlementModel.find>>,
  ): Promise<AdminGrant[]> {
    const users = await UserModel.find({ _id: { $in: list.map((e) => e.userId) } })
      .select({ name: 1, email: 1, phone: 1 })
      .lean();
    return list.map((e) => ({
      id: e.id,
      all: e.all,
      examKeys: [...e.examKeys],
      expiresAt: e.expiresAt.toISOString(),
      source: e.source,
      orderId: e.orderId?.toString() ?? null,
      user: toUserBrief(
        users.find((u) => u._id.equals(e.userId)),
        e.userId,
      ),
      note: e.note,
      grantedBy: e.grantedBy?.toString() ?? null,
      createdAt: e.createdAt.toISOString(),
      revokedAt: e.revokedAt?.toISOString() ?? null,
    }));
  }

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const list = await EntitlementModel.find({ source: "manual" })
        .sort({ createdAt: -1 })
        .limit(200);
      const body: AdminGrantListResponse = { grants: await grantDtos(list) };
      res.json(body);
    }),
  );

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      const input = grantInputSchema.parse(req.body);
      const id = input.identifier.toLowerCase();
      const phone = /^\+?\d{10,13}$/.test(id.replace(/\s/g, ""))
        ? `+91${id.replace(/\D/g, "").slice(-10)}`
        : null;
      const user = await UserModel.findOne({
        role: "student",
        ...(phone ? { phone } : { email: id }),
      });
      if (!user) throw new HttpError(404, "No student with that email or phone");
      const actorId = getAuth(req).userId;
      const ent = await EntitlementModel.create({
        userId: user._id,
        all: input.all,
        examKeys: input.all ? [] : input.examKeys,
        expiresAt: new Date(Date.now() + input.validityDays * DAY_MS),
        source: "manual",
        grantedBy: new Types.ObjectId(actorId),
        note: input.note,
      });
      await recordAudit({
        actorId,
        entity: "entitlement",
        entityId: ent.id,
        action: "create",
        after: {
          userId: user.id,
          all: ent.all,
          examKeys: ent.examKeys,
          expiresAt: ent.expiresAt.toISOString(),
          note: ent.note,
        },
      });
      const [dto] = await grantDtos([ent]);
      res.status(201).json(dto);
    }),
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      const ent = await EntitlementModel.findById(parseId(req.params.id, "Access"));
      if (!ent || ent.source !== "manual") throw notFoundError("Access");
      if (!ent.revokedAt) {
        ent.revokedAt = new Date();
        await ent.save();
        await recordAudit({
          actorId: getAuth(req).userId,
          entity: "entitlement",
          entityId: ent.id,
          action: "update",
          before: { revokedAt: null },
          after: { revokedAt: ent.revokedAt.toISOString() },
        });
      }
      res.status(204).end();
    }),
  );
  return router;
}

/** /api/admin/revenue — daily (IST), by plan, coupon usage. */
export function adminRevenueRouter(): Router {
  const router = Router();
  router.get(
    "/",
    requireRole(...FINANCE),
    asyncHandler(async (req, res) => {
      const q = revenueQuerySchema.parse(req.query);
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
      const paidInRange = {
        paidAt: { $gte: from, $lt: to },
        status: { $in: ["paid", "refund_pending", "refunded"] },
        amountPaise: { $gt: 0 },
      };
      const [totals, refunds, daily, byPlan, coupons] = await Promise.all([
        OrderModel.aggregate<{ gross: number; orders: number }>([
          { $match: paidInRange },
          { $group: { _id: null, gross: { $sum: "$amountPaise" }, orders: { $sum: 1 } } },
        ]),
        OrderModel.aggregate<{ amount: number; orders: number }>([
          { $match: { status: "refunded", refundedAt: { $gte: from, $lt: to } } },
          { $group: { _id: null, amount: { $sum: "$amountPaise" }, orders: { $sum: 1 } } },
        ]),
        OrderModel.aggregate<{ _id: string; amount: number; orders: number }>([
          { $match: paidInRange },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: { $add: ["$paidAt", IST_OFFSET_MS] },
                },
              },
              amount: { $sum: "$amountPaise" },
              orders: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        OrderModel.aggregate<{ _id: Types.ObjectId; name: string; amount: number; orders: number }>(
          [
            { $match: paidInRange },
            {
              $group: {
                _id: "$planId",
                name: { $last: "$plan.name" },
                amount: { $sum: "$amountPaise" },
                orders: { $sum: 1 },
              },
            },
            { $sort: { amount: -1 } },
          ],
        ),
        OrderModel.aggregate<{ _id: string; orders: number; discount: number }>([
          { $match: { ...paidInRange, couponCode: { $type: "string" } } },
          {
            $group: {
              _id: "$couponCode",
              orders: { $sum: 1 },
              discount: { $sum: "$discountPaise" },
            },
          },
          { $sort: { orders: -1 } },
          { $limit: 100 },
        ]),
      ]);
      const gross = totals[0]?.gross ?? 0;
      const refunded = refunds[0]?.amount ?? 0;
      const body: RevenueReport = {
        from: from.toISOString(),
        to: to.toISOString(),
        totals: {
          grossPaise: gross,
          refundedPaise: refunded,
          netPaise: gross - refunded,
          paidOrders: totals[0]?.orders ?? 0,
          refundedOrders: refunds[0]?.orders ?? 0,
        },
        daily: daily.map((d) => ({ date: d._id, amountPaise: d.amount, orders: d.orders })),
        byPlan: byPlan.map((p) => ({
          planId: p._id.toString(),
          name: p.name,
          amountPaise: p.amount,
          orders: p.orders,
        })),
        coupons: coupons.map((c) => ({
          code: c._id,
          orders: c.orders,
          discountPaise: c.discount,
        })),
      };
      res.json(body);
    }),
  );
  return router;
}

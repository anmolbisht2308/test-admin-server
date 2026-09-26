import {
  CouponModel,
  OrderModel,
  PlanModel,
  UserModel,
  accessFor,
  couponProblem,
  planSnapshot,
  priceWith,
} from "@mockprep/core";
import {
  fakePaymentInputSchema,
  orderCreateInputSchema,
  paymentVerifyInputSchema,
  type FakePaymentResponse,
  type OrderCreateInput,
  type OrderCreateResponse,
  type OrderStatus,
  type PlanListResponse,
  type Quote,
} from "@mockprep/types";
import express, { Router } from "express";
import { Types } from "mongoose";
import type { AppContext } from "../context.js";
import { toPlanDto } from "../lib/dto.js";
import { HttpError, notFoundError } from "../lib/httpError.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getAuth, requireAuth, requireRole } from "../middleware/auth.js";
import { FakeGateway } from "../services/paymentGateway.js";
import type { PaymentsService } from "../services/payments.js";
import { parseId } from "./admin/common.js";

/** Orders that count as "used" for a coupon's per-student limit. */
const COUNTED_STATUSES: OrderStatus[] = ["paid", "refund_pending", "refunded"];

/** Server-side price for a plan + coupon. The client never sends an amount. */
async function quoteFor(userId: string, input: OrderCreateInput) {
  const plan = await PlanModel.findOne({ _id: input.planId, active: true }).lean();
  if (!plan) throw notFoundError("Plan");
  let coupon = null;
  if (input.couponCode) {
    coupon = await CouponModel.findOne({ code: input.couponCode }).lean();
    if (!coupon) throw new HttpError(400, "Invalid coupon code", { field: "couponCode" });
    const usedByUser = await OrderModel.countDocuments({
      userId: new Types.ObjectId(userId),
      couponId: coupon._id,
      status: { $in: COUNTED_STATUSES },
    });
    const problem = couponProblem(coupon, { userId, planId: input.planId, usedByUser });
    if (problem) throw new HttpError(400, problem, { field: "couponCode" });
  }
  const price = priceWith(plan.pricePaise, coupon);
  const quote: Quote = {
    planId: plan._id.toString(),
    ...price,
    couponCode: coupon?.code ?? null,
  };
  return { plan, coupon, quote };
}

/** GET /api/plans — what students can buy (public, cacheable). */
export function plansRouter(): Router {
  const router = Router();
  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const plans = await PlanModel.find({ active: true }).sort({ sortOrder: 1, pricePaise: 1 });
      const body: PlanListResponse = { plans: plans.map(toPlanDto) };
      res.set("Cache-Control", "public, max-age=60").json(body);
    }),
  );
  return router;
}

/**
 * POST /api/webhooks/razorpay — mounted before the JSON parser: the signature is over the raw
 * bytes. Always 200 once verified (duplicates included) so Razorpay stops retrying.
 */
export function webhookRouter(payments: PaymentsService): Router {
  const router = Router();
  router.post(
    "/webhooks/razorpay",
    express.raw({ type: "*/*", limit: "1mb" }),
    asyncHandler(async (req, res) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const outcome = await payments.handleWebhook(
        body,
        req.header("x-razorpay-signature"),
        req.header("x-razorpay-event-id"),
      );
      res.json({ ok: true, outcome });
    }),
  );
  return router;
}

/** /api/orders, /api/payments — checkout for signed-in students. */
export function checkoutRouter(ctx: AppContext, payments: PaymentsService): Router {
  const router = Router();
  const student = [requireAuth(ctx.tokens), requireRole("student")] as const;

  async function ownOrder(id: unknown, userId: string) {
    const order = await OrderModel.findById(parseId(id, "Order"));
    if (!order || order.userId.toString() !== userId) throw notFoundError("Order");
    return order;
  }

  router.post(
    "/orders/quote",
    ...student,
    asyncHandler(async (req, res) => {
      const input = orderCreateInputSchema.parse(req.body);
      const { quote } = await quoteFor(getAuth(req).userId, input);
      res.json(quote);
    }),
  );

  router.post(
    "/orders",
    ...student,
    asyncHandler(async (req, res) => {
      const input = orderCreateInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      const { plan, coupon, quote } = await quoteFor(userId, input);
      const user = await UserModel.findById(userId).lean();
      if (!user) throw new HttpError(401, "Session expired. Please sign in again.");
      const free = quote.amountPaise === 0;
      const gateway = payments.gateway;
      if (!free && !gateway) throw new HttpError(503, "Payments are not enabled yet");

      const order = await OrderModel.create({
        userId: user._id,
        planId: plan._id,
        plan: planSnapshot(plan),
        pricePaise: quote.pricePaise,
        discountPaise: quote.discountPaise,
        amountPaise: quote.amountPaise,
        couponId: coupon?._id ?? null,
        couponCode: coupon?.code ?? null,
        provider: free ? "free" : (gateway?.name ?? "free"),
      });
      let razorpayOrderId: string | null = null;
      if (free) {
        await payments.fulfil(order.id, null);
      } else if (gateway) {
        try {
          razorpayOrderId = (
            await gateway.createOrder({
              amountPaise: quote.amountPaise,
              receipt: order.id,
              notes: { orderId: order.id, userId, plan: plan.name },
            })
          ).id;
        } catch (err) {
          await OrderModel.updateOne(
            { _id: order._id },
            { status: "failed", failedAt: new Date() },
          );
          throw err;
        }
        await OrderModel.updateOne({ _id: order._id }, { razorpayOrderId });
      }
      const body: OrderCreateResponse = {
        ...quote,
        orderId: order.id,
        currency: "INR",
        provider: free ? "free" : (gateway?.name ?? "free"),
        razorpayOrderId,
        keyId: free ? null : (gateway?.keyId ?? null),
        planName: plan.name,
        prefill: { name: user.name ?? "", email: user.email ?? "", contact: user.phone ?? "" },
      };
      res.status(201).json(body);
    }),
  );

  /** Polled by the web app after Checkout (and when verify failed on a flaky network). */
  router.get(
    "/orders/:id",
    ...student,
    asyncHandler(async (req, res) => {
      const userId = getAuth(req).userId;
      const order = await ownOrder(req.params.id, userId);
      res.set("Cache-Control", "no-store").json({
        status: order.status,
        access: await accessFor(userId),
      });
    }),
  );

  /** Checkout success handler → instant unlock. The webhook grants access too if this never runs. */
  router.post(
    "/payments/verify",
    ...student,
    asyncHandler(async (req, res) => {
      const input = paymentVerifyInputSchema.parse(req.body);
      const userId = getAuth(req).userId;
      const order = await ownOrder(input.orderId, userId);
      const gateway = payments.gateway;
      if (
        !gateway ||
        order.razorpayOrderId !== input.razorpayOrderId ||
        !gateway.verifyPaymentSignature(
          input.razorpayOrderId,
          input.razorpayPaymentId,
          input.razorpaySignature,
        )
      ) {
        throw new HttpError(400, "Payment verification failed");
      }
      await payments.fulfil(order.id, input.razorpayPaymentId);
      const fresh = await OrderModel.findById(order._id).lean();
      res.json({ status: fresh?.status ?? order.status, access: await accessFor(userId) });
    }),
  );

  /**
   * Dev/test stand-in for Razorpay Checkout (PAYMENTS_PROVIDER=fake only): "pays" the order,
   * sends the signed webhook like Razorpay would, and returns what Checkout returns.
   */
  router.post(
    "/payments/fake/complete",
    ...student,
    asyncHandler(async (req, res) => {
      const gateway = payments.gateway;
      if (!(gateway instanceof FakeGateway)) throw notFoundError("Route");
      const input = fakePaymentInputSchema.parse(req.body);
      const order = await ownOrder(input.orderId, getAuth(req).userId);
      if (!order.razorpayOrderId || !["created", "failed"].includes(order.status)) {
        throw new HttpError(409, "This order can't be paid");
      }
      const paymentId = gateway.newPaymentId();
      const success = input.outcome === "success";
      if (input.webhook) {
        const raw = JSON.stringify({
          entity: "event",
          event: success ? "payment.captured" : "payment.failed",
          created_at: Math.floor(Date.now() / 1000),
          payload: {
            payment: {
              entity: {
                id: paymentId,
                order_id: order.razorpayOrderId,
                amount: order.amountPaise,
                status: success ? "captured" : "failed",
              },
            },
          },
        });
        await payments.handleWebhook(
          Buffer.from(raw),
          gateway.signWebhook(raw),
          `evt_fake${paymentId.slice(8)}`,
        );
      }
      const body: FakePaymentResponse = {
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: success ? paymentId : null,
        razorpaySignature: success ? gateway.signPayment(order.razorpayOrderId, paymentId) : null,
      };
      res.json(body);
    }),
  );

  return router;
}

import {
  GST_PERCENT,
  MIN_PRICE_PAISE,
  REFERRAL_REWARD_PERCENT,
  type AccessResponse,
} from "@mockprep/types";
import { randomInt } from "node:crypto";
import mongoose, { Types, type ClientSession } from "mongoose";
import { nextSequence } from "./models/counter.js";
import { CouponModel, type CouponAttrs } from "./models/coupon.js";
import { EntitlementModel } from "./models/entitlement.js";
import { InvoiceModel, type InvoiceAttrs } from "./models/invoice.js";
import { OrderModel, type OrderAttrs } from "./models/order.js";
import type { PlanAttrs } from "./models/plan.js";
import { UserModel } from "./models/user.js";

/*
 * Payments domain shared by the api (checkout, verify, webhook, admin) and the worker (invoice
 * email). Every state change of an order runs in a MongoDB transaction together with its effects
 * (entitlement, coupon use, invoice number), and every transition is conditional on the current
 * status, so a replayed or racing call (verify vs webhook) changes nothing the second time.
 */

const DAY_MS = 24 * 3600 * 1000;
const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/** Runs `fn` in a transaction (retried on transient errors). Needs a replica set. */
export async function inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}

// ---------- pricing ----------

type CouponLike = Pick<
  CouponAttrs,
  | "kind"
  | "percent"
  | "flatPaise"
  | "maxUses"
  | "uses"
  | "perUserLimit"
  | "expiresAt"
  | "planIds"
  | "active"
  | "ownerUserId"
>;

/** Why a coupon can't be used, or null when it can. `usedByUser` = the student's paid orders with it. */
export function couponProblem(
  coupon: CouponLike,
  ctx: { userId: string; planId: string; usedByUser: number; now?: Date },
): string | null {
  const now = ctx.now ?? new Date();
  if (!coupon.active) return "This coupon is no longer active";
  if (coupon.expiresAt && coupon.expiresAt <= now) return "This coupon has expired";
  if (coupon.ownerUserId && coupon.ownerUserId.toString() !== ctx.userId)
    return "This coupon belongs to another account";
  if (coupon.planIds.length > 0 && !coupon.planIds.some((id) => id.toString() === ctx.planId))
    return "This coupon doesn't apply to this plan";
  if (coupon.maxUses !== null && coupon.uses >= coupon.maxUses)
    return "This coupon has been fully used";
  if (ctx.usedByUser >= coupon.perUserLimit) return "You have already used this coupon";
  return null;
}

/**
 * The server-side price: plan price minus the coupon. A paid amount is never below Razorpay's
 * ₹1 minimum; a 100 % coupon makes the order free.
 */
export function priceWith(
  pricePaise: number,
  coupon: Pick<CouponAttrs, "kind" | "percent" | "flatPaise"> | null,
) {
  let discount = 0;
  if (coupon?.kind === "percent" && coupon.percent)
    discount = Math.round((pricePaise * coupon.percent) / 100);
  if (coupon?.kind === "flat" && coupon.flatPaise) discount = coupon.flatPaise;
  discount = Math.min(pricePaise, Math.max(0, discount));
  let amount = pricePaise - discount;
  if (amount > 0 && amount < MIN_PRICE_PAISE) {
    amount = Math.min(MIN_PRICE_PAISE, pricePaise);
    discount = pricePaise - amount;
  }
  return { pricePaise, discountPaise: discount, amountPaise: amount };
}

// ---------- GST ----------

/**
 * GST breakup of a GST-inclusive amount (integer paise). Intra-state supply: CGST + SGST (half
 * each); IGST when the buyer is in another state. taxable + taxes === amount, always.
 */
export function gstBreakup(amountPaise: number, interState = false) {
  const taxable = Math.round((amountPaise * 100) / (100 + GST_PERCENT));
  const tax = amountPaise - taxable;
  if (interState) return { taxablePaise: taxable, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgst = Math.floor(tax / 2);
  return { taxablePaise: taxable, cgstPaise: cgst, sgstPaise: tax - cgst, igstPaise: 0 };
}

/** Indian financial year (April–March, IST) of a date, e.g. "2026-27". */
export function financialYear(date: Date): string {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const year = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

/** Sequential, gap-free per financial year: "MP/2026-27/000123" (credit notes "MP/CN/…"). */
export async function nextDocumentNumber(
  kind: InvoiceAttrs["kind"],
  date: Date,
  prefix: string,
  session: ClientSession,
): Promise<string> {
  const fy = financialYear(date);
  const series = kind === "invoice" ? prefix : `${prefix}/CN`;
  const seq = await nextSequence(`${series}/${fy}`, session);
  return `${series}/${fy}/${String(seq).padStart(6, "0")}`;
}

// ---------- access ----------

/** Active (unexpired, not revoked) entitlements of a student. */
export async function activeEntitlements(userId: string, now = new Date()) {
  return EntitlementModel.find({
    userId: new Types.ObjectId(userId),
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .sort({ expiresAt: -1 })
    .lean();
}

export async function accessFor(userId: string, now = new Date()): Promise<AccessResponse> {
  const list = await activeEntitlements(userId, now);
  return {
    all: list.some((e) => e.all),
    examKeys: [...new Set(list.flatMap((e) => e.examKeys))].sort(),
    entitlements: list.map((e) => ({
      id: e._id.toString(),
      all: e.all,
      examKeys: [...e.examKeys],
      expiresAt: e.expiresAt.toISOString(),
      source: e.source,
      orderId: e.orderId?.toString() ?? null,
    })),
  };
}

/** A test is attemptable if it is free, or an active entitlement covers its exam. */
export async function canAttempt(
  userId: string,
  test: { isFree: boolean; examKey: string; status: string },
  now = new Date(),
): Promise<boolean> {
  // Practice tests are the student's own re-attempts of a test they could already open.
  if (test.isFree || test.status === "practice") return true;
  const found = await EntitlementModel.exists({
    userId: new Types.ObjectId(userId),
    revokedAt: null,
    expiresAt: { $gt: now },
    $or: [{ all: true }, { examKeys: test.examKey }],
  });
  return found !== null;
}

// ---------- order lifecycle ----------

export interface PaymentsConfig {
  /** Invoice number prefix, e.g. "MP". */
  invoicePrefix: string;
}

export type OrderDoc = OrderAttrs & { _id: Types.ObjectId };

export const planSnapshot = (plan: PlanAttrs): OrderAttrs["plan"] => ({
  name: plan.name,
  kind: plan.kind,
  examKeys: plan.kind === "pass" ? [] : [...plan.examKeys],
  validityDays: plan.validityDays,
});

/** Creates a referral code for a student on first use (8 chars, no look-alike letters). */
export async function ensureReferralCode(userId: string): Promise<string> {
  const user = await UserModel.findById(userId).select({ referralCode: 1 }).lean();
  if (user?.referralCode) return user.referralCode;
  for (;;) {
    const code = randomCode(8);
    try {
      const updated = await UserModel.findOneAndUpdate(
        { _id: userId, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { returnDocument: "after" },
      ).lean();
      if (updated?.referralCode) return updated.referralCode;
      const again = await UserModel.findById(userId).select({ referralCode: 1 }).lean();
      if (again?.referralCode) return again.referralCode;
      throw new Error("user not found");
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** After a student's first paid order: their referrer gets a one-use credit coupon. */
async function rewardReferrer(userId: Types.ObjectId, now: Date, session: ClientSession) {
  const user = await UserModel.findOneAndUpdate(
    { _id: userId, referredBy: { $exists: true }, referralRewardedAt: { $exists: false } },
    { $set: { referralRewardedAt: now } },
    { session, returnDocument: "after" },
  ).lean();
  if (!user?.referredBy) return null;
  const [coupon] = await CouponModel.create(
    [
      {
        code: `REF-${randomCode(8)}`,
        kind: "percent",
        percent: REFERRAL_REWARD_PERCENT,
        maxUses: 1,
        perUserLimit: 1,
        expiresAt: new Date(now.getTime() + 180 * DAY_MS),
        ownerUserId: user.referredBy,
      },
    ],
    { session },
  );
  return coupon?._id ?? null;
}

export interface FulfilResult {
  /** False when the order was already paid (replay, or verify and webhook raced). */
  changed: boolean;
  invoiceId: string | null;
}

/**
 * Marks an order paid and grants access, in the caller's transaction. Only an order that is
 * "created" or "failed" (a retry after a failed attempt) can become paid.
 */
export async function fulfilOrder(
  orderId: Types.ObjectId | string,
  payment: { paymentId: string | null; at?: Date },
  config: PaymentsConfig,
  session: ClientSession,
): Promise<FulfilResult> {
  const at = payment.at ?? new Date();
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId, status: { $in: ["created", "failed"] } },
    {
      $set: {
        status: "paid",
        paidAt: at,
        ...(payment.paymentId ? { razorpayPaymentId: payment.paymentId } : {}),
      },
    },
    { session, returnDocument: "after" },
  ).lean();
  if (!order) return { changed: false, invoiceId: null };

  await EntitlementModel.create(
    [
      {
        userId: order.userId,
        all: order.plan.kind === "pass",
        examKeys: order.plan.examKeys,
        expiresAt: new Date(at.getTime() + order.plan.validityDays * DAY_MS),
        source: "purchase",
        orderId: order._id,
      },
    ],
    { session },
  );
  if (order.couponId) {
    await CouponModel.updateOne({ _id: order.couponId }, { $inc: { uses: 1 } }, { session });
  }
  const user = await UserModel.findById(order.userId).session(session).lean();
  const [invoice] = await InvoiceModel.create(
    [
      {
        kind: "invoice",
        number: await nextDocumentNumber("invoice", at, config.invoicePrefix, session),
        orderId: order._id,
        userId: order.userId,
        date: at,
        description: `${order.plan.name} — ${order.plan.validityDays} days access`,
        amountPaise: order.amountPaise,
        ...gstBreakup(order.amountPaise),
        customer: {
          name: user?.name ?? "",
          email: user?.email ?? "",
          phone: user?.phone ?? "",
        },
      },
    ],
    { session },
  );
  if (order.amountPaise > 0) await rewardReferrer(order.userId, at, session);
  return { changed: true, invoiceId: invoice?._id.toString() ?? null };
}

/** A failed payment attempt. The order stays payable (Checkout lets the student retry). */
export async function failOrder(orderId: Types.ObjectId | string, session?: ClientSession) {
  const res = await OrderModel.updateOne(
    { _id: orderId, status: "created" },
    { $set: { status: "failed", failedAt: new Date() } },
    session ? { session } : {},
  );
  return res.modifiedCount > 0;
}

export interface RefundResult {
  changed: boolean;
  creditNoteId: string | null;
}

/**
 * The refund went through: access is revoked and a credit note cancels the invoice, in the
 * caller's transaction. Only a paid (or refund-pending) order can be refunded.
 */
export async function completeRefund(
  orderId: Types.ObjectId | string,
  refund: { refundId: string | null; reason?: string; at?: Date },
  config: PaymentsConfig,
  session: ClientSession,
): Promise<RefundResult> {
  const at = refund.at ?? new Date();
  const order = await OrderModel.findOneAndUpdate(
    { _id: orderId, status: { $in: ["paid", "refund_pending"] } },
    {
      $set: {
        status: "refunded",
        refundedAt: at,
        ...(refund.refundId ? { razorpayRefundId: refund.refundId } : {}),
      },
    },
    { session, returnDocument: "after" },
  ).lean();
  if (!order) return { changed: false, creditNoteId: null };
  if (!order.refundReason) {
    await OrderModel.updateOne(
      { _id: order._id },
      { $set: { refundReason: refund.reason ?? "Refunded" } },
      { session },
    );
  }
  await EntitlementModel.updateMany(
    { orderId: order._id, revokedAt: null },
    { $set: { revokedAt: at } },
    { session },
  );
  const invoice = await InvoiceModel.findOne({ orderId: order._id, kind: "invoice" })
    .session(session)
    .lean();
  if (!invoice) return { changed: true, creditNoteId: null };
  const [note] = await InvoiceModel.create(
    [
      {
        kind: "credit_note",
        number: await nextDocumentNumber("credit_note", at, config.invoicePrefix, session),
        orderId: order._id,
        userId: order.userId,
        invoiceId: invoice._id,
        date: at,
        description: `Refund of invoice ${invoice.number}`,
        amountPaise: invoice.amountPaise,
        taxablePaise: invoice.taxablePaise,
        cgstPaise: invoice.cgstPaise,
        sgstPaise: invoice.sgstPaise,
        igstPaise: invoice.igstPaise,
        customer: invoice.customer,
      },
    ],
    { session },
  );
  return { changed: true, creditNoteId: note?._id.toString() ?? null };
}

import { z } from "zod";
import { isoDateSchema, objectIdSchema, slugSchema } from "./common.js";

/** GST on digital services (prices are GST-inclusive). */
export const GST_PERCENT = 18;
/** Razorpay's minimum charge is ₹1. */
export const MIN_PRICE_PAISE = 100;

// ---------- plans ----------

/** series: some exams' paid tests; pass: every exam. */
export const planKindSchema = z.enum(["series", "pass"]);
export type PlanKind = z.infer<typeof planKindSchema>;

const planFields = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).default(""),
  kind: planKindSchema,
  /** Exams whose paid tests it unlocks (ignored for a pass). */
  examKeys: z.array(slugSchema).max(50).default([]),
  /** GST-inclusive price. */
  pricePaise: z.number().int().min(MIN_PRICE_PAISE).max(100_000_00),
  /** Optional "was" price shown struck through. */
  mrpPaise: z.number().int().min(0).nullable().default(null),
  validityDays: z.number().int().min(1).max(1095),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(100),
});

export const planInputSchema = planFields.superRefine((p, ctx) => {
  if (p.kind === "series" && p.examKeys.length === 0) {
    ctx.addIssue({ code: "custom", path: ["examKeys"], message: "pick at least one exam" });
  }
});
export type PlanInput = z.input<typeof planInputSchema>;

export const planSchema = planFields.extend({
  id: objectIdSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Plan = z.infer<typeof planSchema>;
export const planListResponseSchema = z.object({ plans: z.array(planSchema) });
export type PlanListResponse = z.infer<typeof planListResponseSchema>;

// ---------- coupons ----------

export const couponKindSchema = z.enum(["percent", "flat"]);

const couponFields = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{3,24}$/, "3–24 letters, digits or dashes"),
  kind: couponKindSchema,
  /** percent: 1–100. */
  percent: z.number().int().min(1).max(100).nullable().default(null),
  /** flat: discount in paise. */
  flatPaise: z.number().int().min(1).nullable().default(null),
  /** Total uses across all students (null = unlimited). */
  maxUses: z.number().int().min(1).nullable().default(null),
  perUserLimit: z.number().int().min(1).default(1),
  expiresAt: isoDateSchema.nullable().default(null),
  /** Plans it applies to (empty = every plan). */
  planIds: z.array(objectIdSchema).max(50).default([]),
  active: z.boolean().default(true),
});

export const couponInputSchema = couponFields.superRefine((c, ctx) => {
  if (c.kind === "percent" && c.percent === null) {
    ctx.addIssue({ code: "custom", path: ["percent"], message: "enter the percent" });
  }
  if (c.kind === "flat" && c.flatPaise === null) {
    ctx.addIssue({ code: "custom", path: ["flatPaise"], message: "enter the amount" });
  }
});
export type CouponInput = z.input<typeof couponInputSchema>;

export const couponSchema = couponFields.extend({
  id: objectIdSchema,
  uses: z.number().int(),
  /** Referral credit: only this student can use it. */
  ownerUserId: objectIdSchema.nullable(),
  createdAt: isoDateSchema,
});
export type Coupon = z.infer<typeof couponSchema>;
export const couponListResponseSchema = z.object({ coupons: z.array(couponSchema) });

// ---------- checkout ----------

/**
 * POST /api/orders/quote and POST /api/orders. Strict: a client-sent amount is rejected — the
 * server always computes the price.
 */
export const orderCreateInputSchema = z
  .object({
    planId: objectIdSchema,
    couponCode: z.string().trim().toUpperCase().max(24).optional(),
  })
  .strict();
export type OrderCreateInput = z.infer<typeof orderCreateInputSchema>;

export const quoteSchema = z.object({
  planId: objectIdSchema,
  pricePaise: z.number().int(),
  discountPaise: z.number().int(),
  amountPaise: z.number().int(),
  couponCode: z.string().nullable(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const paymentProviderSchema = z.enum(["razorpay", "fake", "free"]);
export type PaymentProvider = z.infer<typeof paymentProviderSchema>;

export const orderCreateResponseSchema = quoteSchema.extend({
  orderId: objectIdSchema,
  currency: z.literal("INR"),
  /** free: nothing to pay (100 % coupon) — the order is already paid. */
  provider: paymentProviderSchema,
  razorpayOrderId: z.string().nullable(),
  /** Public Razorpay key id (safe to send). */
  keyId: z.string().nullable(),
  planName: z.string(),
  prefill: z.object({ name: z.string(), email: z.string(), contact: z.string() }),
});
export type OrderCreateResponse = z.infer<typeof orderCreateResponseSchema>;

/** POST /api/payments/verify — what Razorpay Checkout returns on success. */
export const paymentVerifyInputSchema = z.object({
  orderId: objectIdSchema,
  razorpayOrderId: z.string().min(1).max(64),
  razorpayPaymentId: z.string().min(1).max(64),
  razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/, "invalid signature"),
});
export type PaymentVerifyInput = z.infer<typeof paymentVerifyInputSchema>;

/** POST /api/payments/fake/complete — dev/test stand-in for Razorpay Checkout. */
export const fakePaymentInputSchema = z.object({
  orderId: objectIdSchema,
  outcome: z.enum(["success", "failure"]),
  /** false: the webhook is not sent (to test the verify-only path). */
  webhook: z.boolean().default(true),
});

/** What Checkout would return: the web app then calls /payments/verify like with Razorpay. */
export const fakePaymentResponseSchema = z.object({
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string().nullable(),
  razorpaySignature: z.string().nullable(),
});
export type FakePaymentResponse = z.infer<typeof fakePaymentResponseSchema>;

export const orderStatusSchema = z.enum([
  "created",
  "paid",
  "failed",
  "refund_pending",
  "refunded",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

export const paymentVerifyResponseSchema = z.object({
  status: orderStatusSchema,
  access: z.lazy(() => accessResponseSchema),
});

// ---------- access ----------

export const entitlementSchema = z.object({
  id: objectIdSchema,
  all: z.boolean(),
  examKeys: z.array(z.string()),
  expiresAt: isoDateSchema,
  source: z.enum(["purchase", "manual"]),
  orderId: objectIdSchema.nullable(),
});
export type Entitlement = z.infer<typeof entitlementSchema>;

/** GET /api/me/access — what the student can open now. */
export const accessResponseSchema = z.object({
  all: z.boolean(),
  examKeys: z.array(z.string()),
  entitlements: z.array(entitlementSchema),
});
export type AccessResponse = z.infer<typeof accessResponseSchema>;

/** Students see this 403 detail when a paid test is locked. */
export const LOCKED_REASON = "locked";

// ---------- purchases & invoices ----------

export const invoiceSchema = z.object({
  number: z.string(),
  kind: z.enum(["invoice", "credit_note"]),
  date: isoDateSchema,
  amountPaise: z.number().int(),
  taxablePaise: z.number().int(),
  cgstPaise: z.number().int(),
  sgstPaise: z.number().int(),
  igstPaise: z.number().int(),
});
export type Invoice = z.infer<typeof invoiceSchema>;

export const purchaseSchema = z.object({
  orderId: objectIdSchema,
  planName: z.string(),
  kind: planKindSchema,
  examKeys: z.array(z.string()),
  amountPaise: z.number().int(),
  status: orderStatusSchema,
  paidAt: isoDateSchema.nullable(),
  validUntil: isoDateSchema.nullable(),
  active: z.boolean(),
  invoice: invoiceSchema.nullable(),
  creditNote: invoiceSchema.nullable(),
});
export type Purchase = z.infer<typeof purchaseSchema>;
export const purchaseListResponseSchema = z.object({ purchases: z.array(purchaseSchema) });
export type PurchaseListResponse = z.infer<typeof purchaseListResponseSchema>;

// ---------- referrals ----------

export const referralResponseSchema = z.object({
  code: z.string(),
  /** Friends who made a first paid order. */
  rewarded: z.number().int(),
  /** Credit coupons earned (only you can use them). */
  coupons: z.array(
    couponSchema.pick({
      code: true,
      kind: true,
      percent: true,
      flatPaise: true,
      expiresAt: true,
      uses: true,
    }),
  ),
});
export type ReferralResponse = z.infer<typeof referralResponseSchema>;
export const applyReferralInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/),
});
/** The referrer's reward after a friend's first paid order. */
export const REFERRAL_REWARD_PERCENT = 20;

// ---------- admin ----------

export const adminOrderSchema = z.object({
  id: objectIdSchema,
  user: z.object({
    id: objectIdSchema,
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  plan: z.object({ id: objectIdSchema, name: z.string() }),
  pricePaise: z.number().int(),
  discountPaise: z.number().int(),
  amountPaise: z.number().int(),
  couponCode: z.string().nullable(),
  status: orderStatusSchema,
  razorpayOrderId: z.string().nullable(),
  razorpayPaymentId: z.string().nullable(),
  refundReason: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  createdAt: isoDateSchema,
  paidAt: isoDateSchema.nullable(),
  refundedAt: isoDateSchema.nullable(),
});
export type AdminOrder = z.infer<typeof adminOrderSchema>;

export const adminOrderListQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  planId: objectIdSchema.optional(),
  /** Email, phone or name. */
  q: z.string().trim().max(100).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export const adminOrderListResponseSchema = z.object({
  orders: z.array(adminOrderSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AdminOrderListResponse = z.infer<typeof adminOrderListResponseSchema>;

export const refundInputSchema = z.object({ reason: z.string().trim().min(3).max(300) });

/** POST /api/admin/entitlements — manual access (support cases), always audited. */
export const grantInputSchema = z
  .object({
    /** The student's email or +91 phone. */
    identifier: z.string().trim().min(3).max(120),
    all: z.boolean().default(false),
    examKeys: z.array(slugSchema).max(50).default([]),
    validityDays: z.number().int().min(1).max(1095),
    note: z.string().trim().min(3).max(300),
  })
  .refine((g) => g.all || g.examKeys.length > 0, {
    path: ["examKeys"],
    message: "pick exams or all",
  });
export type GrantInput = z.input<typeof grantInputSchema>;

export const adminGrantSchema = entitlementSchema.extend({
  user: z.object({
    id: objectIdSchema,
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  }),
  note: z.string(),
  grantedBy: z.string().nullable(),
  createdAt: isoDateSchema,
  revokedAt: isoDateSchema.nullable(),
});
export type AdminGrant = z.infer<typeof adminGrantSchema>;
export const adminGrantListResponseSchema = z.object({ grants: z.array(adminGrantSchema) });
export type AdminGrantListResponse = z.infer<typeof adminGrantListResponseSchema>;

/** GET /api/admin/revenue?from=&to= (default: the last 30 days). */
export const revenueQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const revenueReportSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  totals: z.object({
    grossPaise: z.number().int(),
    refundedPaise: z.number().int(),
    netPaise: z.number().int(),
    paidOrders: z.number().int(),
    refundedOrders: z.number().int(),
  }),
  /** IST calendar days. */
  daily: z.array(
    z.object({ date: z.string(), amountPaise: z.number().int(), orders: z.number().int() }),
  ),
  byPlan: z.array(
    z.object({
      planId: objectIdSchema,
      name: z.string(),
      amountPaise: z.number().int(),
      orders: z.number().int(),
    }),
  ),
  coupons: z.array(
    z.object({ code: z.string(), orders: z.number().int(), discountPaise: z.number().int() }),
  ),
});
export type RevenueReport = z.infer<typeof revenueReportSchema>;

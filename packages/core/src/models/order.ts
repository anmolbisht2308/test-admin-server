import type { OrderStatus } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

export interface OrderAttrs {
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  /** Plan snapshot at purchase time (plans can change later). */
  plan: { name: string; kind: "series" | "pass"; examKeys: string[]; validityDays: number };
  pricePaise: number;
  discountPaise: number;
  amountPaise: number;
  couponId: Types.ObjectId | null;
  couponCode: string | null;
  provider: "razorpay" | "fake" | "free";
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  razorpayRefundId: string | null;
  status: OrderStatus;
  paidAt: Date | null;
  failedAt: Date | null;
  refundReason: string | null;
  refundRequestedBy: Types.ObjectId | null;
  refundedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const orderSchema = new Schema<OrderAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    planId: { type: Schema.Types.ObjectId, ref: "Plan", required: true },
    plan: {
      name: String,
      kind: { type: String },
      examKeys: [String],
      validityDays: Number,
    },
    pricePaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    amountPaise: { type: Number, required: true },
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", default: null },
    couponCode: { type: String, default: null },
    provider: { type: String, required: true },
    razorpayOrderId: { type: String, default: null },
    razorpayPaymentId: { type: String, default: null },
    razorpayRefundId: { type: String, default: null },
    status: { type: String, default: "created" },
    paidAt: { type: Date, default: null },
    failedAt: { type: Date, default: null },
    refundReason: { type: String, default: null },
    refundRequestedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    refundedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
orderSchema.index(
  { razorpayOrderId: 1 },
  { unique: true, partialFilterExpression: { razorpayOrderId: { $type: "string" } } },
);
orderSchema.index(
  { razorpayPaymentId: 1 },
  { partialFilterExpression: { razorpayPaymentId: { $type: "string" } } },
);
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, paidAt: -1 });
orderSchema.index({ couponId: 1, userId: 1, status: 1 });

export const OrderModel = model<OrderAttrs>("Order", orderSchema, "orders");

import { Schema, model, type Types } from "mongoose";

export interface CouponAttrs {
  code: string;
  kind: "percent" | "flat";
  percent: number | null;
  flatPaise: number | null;
  maxUses: number | null;
  perUserLimit: number;
  expiresAt: Date | null;
  planIds: Types.ObjectId[];
  active: boolean;
  /** Paid orders that used it. */
  uses: number;
  /** Referral credit coupons belong to one student. */
  ownerUserId: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponAttrs>(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    kind: { type: String, required: true },
    percent: { type: Number, default: null },
    flatPaise: { type: Number, default: null },
    maxUses: { type: Number, default: null },
    perUserLimit: { type: Number, default: 1 },
    expiresAt: { type: Date, default: null },
    planIds: { type: [Schema.Types.ObjectId], default: [] },
    active: { type: Boolean, default: true },
    uses: { type: Number, default: 0 },
    ownerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);
couponSchema.index({ ownerUserId: 1 });

export const CouponModel = model<CouponAttrs>("Coupon", couponSchema, "coupons");

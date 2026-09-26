import { Schema, model, type Types } from "mongoose";

/** Access to paid tests: an exam list or everything, until expiresAt. */
export interface EntitlementAttrs {
  userId: Types.ObjectId;
  all: boolean;
  examKeys: string[];
  expiresAt: Date;
  source: "purchase" | "manual";
  orderId: Types.ObjectId | null;
  /** Manual grants: who and why (also in the audit log). */
  grantedBy: Types.ObjectId | null;
  note: string;
  /** Refunded / withdrawn. */
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const entitlementSchema = new Schema<EntitlementAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    all: { type: Boolean, default: false },
    examKeys: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    source: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
entitlementSchema.index({ userId: 1, expiresAt: -1 });
// One entitlement per order, even if verify and the webhook race.
entitlementSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: "objectId" } } },
);

export const EntitlementModel = model<EntitlementAttrs>(
  "Entitlement",
  entitlementSchema,
  "entitlements",
);

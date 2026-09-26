import { Schema, model, type Types } from "mongoose";

export type SessionKind = "student" | "admin";

/** One document per signed-in device. Refresh tokens are stored only as sha256 hashes. */
export interface SessionAttrs {
  userId: Types.ObjectId;
  kind: SessionKind;
  tokenHash: string;
  /** Previous token hash, accepted for a short grace window after rotation. */
  previousTokenHash?: string;
  rotatedAt?: Date;
  userAgent?: string;
  ip?: string;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revokedReason?: "logout" | "device_limit" | "reuse_detected" | "admin";
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionAttrs>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    kind: { type: String, enum: ["student", "admin"], required: true },
    tokenHash: { type: String, required: true },
    previousTokenHash: String,
    rotatedAt: Date,
    userAgent: String,
    ip: String,
    lastUsedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokedReason: String,
  },
  { timestamps: true },
);

sessionSchema.index({ userId: 1, revokedAt: 1, lastUsedAt: 1 });
// Mongo deletes sessions once they expire.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SessionModel = model<SessionAttrs>("Session", sessionSchema, "sessions");

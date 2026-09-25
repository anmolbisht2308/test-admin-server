import { ROLES, type Language, type Role } from "@mockprep/types";
import { Schema, model, type HydratedDocument, type Types } from "mongoose";

export interface UserTotp {
  /** AES-GCM encrypted base32 secret. */
  secretEnc: string;
  enabled: boolean;
  /** Last accepted TOTP step, to reject replays. */
  lastUsedStep?: number;
}

export interface UserAttrs {
  role: Role;
  name?: string;
  phone?: string;
  email?: string;
  googleSub?: string;
  passwordHash?: string;
  totp?: UserTotp;
  language: Language;
  targetExamSlugs: string[];
  onboardedAt?: Date;
  disabledAt?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type UserDoc = HydratedDocument<UserAttrs> & { _id: Types.ObjectId };

const uniqueWhenSet = (field: string) => ({
  unique: true,
  partialFilterExpression: { [field]: { $type: "string" } },
});

const userSchema = new Schema<UserAttrs>(
  {
    role: { type: String, enum: ROLES, required: true },
    name: { type: String, trim: true },
    phone: String,
    email: { type: String, lowercase: true, trim: true },
    googleSub: String,
    passwordHash: String,
    totp: {
      type: new Schema<UserTotp>(
        { secretEnc: String, enabled: Boolean, lastUsedStep: Number },
        { _id: false },
      ),
      default: undefined,
    },
    language: { type: String, enum: ["en", "hi"], default: "en" },
    targetExamSlugs: { type: [String], default: [] },
    onboardedAt: Date,
    disabledAt: Date,
    lastLoginAt: Date,
  },
  { timestamps: true },
);

userSchema.index({ phone: 1 }, uniqueWhenSet("phone"));
userSchema.index({ email: 1 }, uniqueWhenSet("email"));
userSchema.index({ googleSub: 1 }, uniqueWhenSet("googleSub"));
userSchema.index({ role: 1, createdAt: -1 });

export const UserModel = model<UserAttrs>("User", userSchema, "users");

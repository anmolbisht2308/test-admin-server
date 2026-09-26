import { z } from "zod";
import { userSchema } from "./user.js";

export const ROLES = [
  "student",
  "superadmin",
  "content",
  "reviewer",
  "support",
  "finance",
] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

export const ADMIN_ROLES = ["superadmin", "content", "reviewer", "support", "finance"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
export const isAdminRole = (role: Role): role is AdminRole => role !== "student";

/**
 * Indian mobile number, normalised to E.164 (+91XXXXXXXXXX).
 * Accepts "9876543210", "09876543210", "+91 98765 43210", "91-9876543210".
 */
export const indianPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ""))
  .transform((value) => value.replace(/^(\+?91|0)(?=\d{10}$)/, ""))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, "enter a valid 10-digit Indian mobile number"))
  .transform((digits) => `+91${digits}`);

export const otpCodeSchema = z.string().regex(/^\d{6}$/, "enter the 6-digit code");

export const otpSendInputSchema = z.object({ phone: indianPhoneSchema });
export type OtpSendInput = z.input<typeof otpSendInputSchema>;

export const otpSendResponseSchema = z.object({
  expiresInSec: z.number().int(),
  resendInSec: z.number().int(),
});
export type OtpSendResponse = z.infer<typeof otpSendResponseSchema>;

export const otpVerifyInputSchema = z.object({
  phone: indianPhoneSchema,
  code: otpCodeSchema,
});
export type OtpVerifyInput = z.input<typeof otpVerifyInputSchema>;

/** Email sign-in (free alternative to SMS): same code rules as phone OTP. */
export const studentEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("enter a valid email address").max(254));

export const emailOtpSendInputSchema = z.object({ email: studentEmailSchema });
export type EmailOtpSendInput = z.input<typeof emailOtpSendInputSchema>;

export const emailOtpVerifyInputSchema = z.object({
  email: studentEmailSchema,
  code: otpCodeSchema,
});
export type EmailOtpVerifyInput = z.input<typeof emailOtpVerifyInputSchema>;

export const googleSignInInputSchema = z.object({ idToken: z.string().min(20) });
export type GoogleSignInInput = z.infer<typeof googleSignInInputSchema>;

/** Returned by every endpoint that starts or refreshes a session. */
export const authSessionResponseSchema = z.object({
  accessToken: z.string(),
  /** Seconds until accessToken expires. */
  expiresInSec: z.number().int(),
  user: userSchema,
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

// ---------- Admin ----------

export const adminLoginInputSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1, "enter your password").max(200),
});
export type AdminLoginInput = z.input<typeof adminLoginInputSchema>;

export const adminLoginResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("totp_required"), challengeToken: z.string() }),
  z.object({
    status: z.literal("totp_setup_required"),
    challengeToken: z.string(),
    /** otpauth:// URL for authenticator apps. */
    otpauthUrl: z.string(),
    /** PNG data URL of the QR code for otpauthUrl. */
    qrDataUrl: z.string(),
    /** Base32 secret, for manual entry. */
    secret: z.string(),
  }),
]);
export type AdminLoginResponse = z.infer<typeof adminLoginResponseSchema>;

export const adminTotpVerifyInputSchema = z.object({
  challengeToken: z.string().min(1),
  code: otpCodeSchema,
});
export type AdminTotpVerifyInput = z.infer<typeof adminTotpVerifyInputSchema>;

/** Password rules for admin accounts. */
export const adminPasswordSchema = z
  .string()
  .min(12, "at least 12 characters")
  .max(200)
  .regex(/[a-z]/, "needs a lowercase letter")
  .regex(/[A-Z]/, "needs an uppercase letter")
  .regex(/\d/, "needs a digit");

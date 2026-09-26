import { randomInt } from "node:crypto";
import type { Redis } from "ioredis";
import { hmacSha256, safeEqualHex } from "../lib/crypto.js";
import { HttpError } from "../lib/httpError.js";
import { otpEmail, type EmailSender } from "./email.js";
import type { OtpSender } from "./otpSender.js";
import { enforceLimit } from "./rateLimit.js";

export const OTP_TTL_SEC = 300;
export const OTP_RESEND_SEC = 30;
export const OTP_MAX_ATTEMPTS = 5;
const PER_DESTINATION_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;

/** Redis key part for a destination: the phone number as-is, or "email:<address>". */
export const emailKey = (email: string) => `email:${email}`;

/**
 * One-time codes for phone (SMS) and email sign-in. Same rules for both channels: 30 s resend
 * cooldown, 5 codes per destination per hour, 20 per IP per hour (shared across channels),
 * 5 wrong attempts per code, single use, hashed at rest.
 */
export function createOtpService(
  redis: Redis,
  senders: { sms: OtpSender; email: EmailSender },
  secret: string,
) {
  const codeKey = (dest: string) => `otp:code:${dest}`;
  const hash = (dest: string, code: string) => hmacSha256(secret, `${dest}:${code}`);

  async function issue(
    dest: string,
    ip: string,
    label: string,
    deliver: (code: string) => Promise<void>,
  ) {
    // Cheapest checks first; the resend cooldown also stops double-taps.
    const cooldown = await redis.set(`otp:cooldown:${dest}`, "1", "EX", OTP_RESEND_SEC, "NX");
    if (cooldown === null) {
      const ttl = await redis.ttl(`otp:cooldown:${dest}`);
      throw new HttpError(429, "Please wait before requesting another code", {
        retryAfterSec: Math.max(ttl, 1),
      });
    }
    await enforceLimit(
      redis,
      `otp:dest:${dest}`,
      PER_DESTINATION_PER_HOUR,
      3600,
      `Too many codes requested for ${label}. Try again later.`,
    );
    await enforceLimit(
      redis,
      `otp:ip:${ip}`,
      PER_IP_PER_HOUR,
      3600,
      "Too many codes requested from this network. Try again later.",
    );

    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await redis
      .multi()
      .hset(codeKey(dest), { hash: hash(dest, code), attempts: 0 })
      .expire(codeKey(dest), OTP_TTL_SEC)
      .exec();
    try {
      await deliver(code);
    } catch (error) {
      await redis.del(codeKey(dest), `otp:cooldown:${dest}`);
      throw new HttpError(502, "Could not send the code. Please try again.", undefined, error);
    }
    return { expiresInSec: OTP_TTL_SEC, resendInSec: OTP_RESEND_SEC };
  }

  /** Resolves when the code is right; throws 400/429 otherwise. Codes are single-use. */
  async function check(dest: string, code: string) {
    const key = codeKey(dest);
    const stored = await redis.hgetall(key);
    if (!stored.hash) throw new HttpError(400, "Code expired. Request a new one.");
    const attempts = Number(stored.attempts ?? 0);
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await redis.del(key);
      throw new HttpError(429, "Too many wrong attempts. Request a new code.");
    }
    if (!safeEqualHex(stored.hash, hash(dest, code))) {
      const used = await redis.hincrby(key, "attempts", 1);
      const attemptsLeft = Math.max(OTP_MAX_ATTEMPTS - used, 0);
      if (attemptsLeft === 0) await redis.del(key);
      throw new HttpError(400, "Incorrect code", { attemptsLeft });
    }
    await redis.del(key);
  }

  return {
    send: (phone: string, ip: string) =>
      issue(phone, ip, "this number", (code) => senders.sms.send(phone, code)),
    verify: (phone: string, code: string) => check(phone, code),
    sendEmail: (email: string, ip: string) =>
      issue(emailKey(email), ip, "this email address", (code) =>
        senders.email.send({ to: email, ...otpEmail(code, OTP_TTL_SEC / 60) }),
      ),
    verifyEmail: (email: string, code: string) => check(emailKey(email), code),
  };
}

export type OtpService = ReturnType<typeof createOtpService>;

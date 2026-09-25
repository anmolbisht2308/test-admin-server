import { randomInt } from "node:crypto";
import type { Redis } from "ioredis";
import { hmacSha256, safeEqualHex } from "../lib/crypto.js";
import { HttpError } from "../lib/httpError.js";
import type { OtpSender } from "./otpSender.js";
import { enforceLimit } from "./rateLimit.js";

export const OTP_TTL_SEC = 300;
export const OTP_RESEND_SEC = 30;
export const OTP_MAX_ATTEMPTS = 5;
const PER_PHONE_PER_HOUR = 5;
const PER_IP_PER_HOUR = 20;

export function createOtpService(redis: Redis, sender: OtpSender, secret: string) {
  const codeKey = (phone: string) => `otp:code:${phone}`;
  const hash = (phone: string, code: string) => hmacSha256(secret, `${phone}:${code}`);

  return {
    async send(phone: string, ip: string) {
      // Cheapest checks first; the resend cooldown also stops double-taps.
      const cooldown = await redis.set(`otp:cooldown:${phone}`, "1", "EX", OTP_RESEND_SEC, "NX");
      if (cooldown === null) {
        const ttl = await redis.ttl(`otp:cooldown:${phone}`);
        throw new HttpError(429, "Please wait before requesting another code", {
          retryAfterSec: Math.max(ttl, 1),
        });
      }
      await enforceLimit(
        redis,
        `otp:phone:${phone}`,
        PER_PHONE_PER_HOUR,
        3600,
        "Too many codes requested for this number. Try again later.",
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
        .hset(codeKey(phone), { hash: hash(phone, code), attempts: 0 })
        .expire(codeKey(phone), OTP_TTL_SEC)
        .exec();
      try {
        await sender.send(phone, code);
      } catch (error) {
        await redis.del(codeKey(phone), `otp:cooldown:${phone}`);
        throw new HttpError(502, "Could not send the code. Please try again.", undefined, error);
      }
      return { expiresInSec: OTP_TTL_SEC, resendInSec: OTP_RESEND_SEC };
    },

    /** Resolves when the code is right; throws 400/429 otherwise. Codes are single-use. */
    async verify(phone: string, code: string) {
      const key = codeKey(phone);
      const stored = await redis.hgetall(key);
      if (!stored.hash) throw new HttpError(400, "Code expired. Request a new one.");
      const attempts = Number(stored.attempts ?? 0);
      if (attempts >= OTP_MAX_ATTEMPTS) {
        await redis.del(key);
        throw new HttpError(429, "Too many wrong attempts. Request a new code.");
      }
      if (!safeEqualHex(stored.hash, hash(phone, code))) {
        const used = await redis.hincrby(key, "attempts", 1);
        const attemptsLeft = Math.max(OTP_MAX_ATTEMPTS - used, 0);
        if (attemptsLeft === 0) await redis.del(key);
        throw new HttpError(400, "Incorrect code", { attemptsLeft });
      }
      await redis.del(key);
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;

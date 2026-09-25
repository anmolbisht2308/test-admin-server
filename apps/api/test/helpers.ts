import argon2 from "argon2";
import { Redis } from "ioredis";
import mongoose from "mongoose";
import { pino } from "pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, inject } from "vitest";
import type { Role } from "@mockprep/types";
import { createApp, type AppDeps } from "../src/app.js";
import { connectMongo } from "../src/db.js";
import { parseEnv } from "../src/env.js";
import { encrypt } from "../src/lib/crypto.js";
import { HttpError } from "../src/lib/httpError.js";
import { createTokenService } from "../src/lib/tokens.js";
import { generateTotpSecret, totpCode } from "../src/lib/totp.js";
import { UserModel } from "../src/models/user.js";
import type { GoogleVerifier } from "../src/services/google.js";
import type { OtpSender } from "../src/services/otpSender.js";

export const silentLogger = pino({ level: "silent" });

export const testEnv = parseEnv({
  NODE_ENV: "test",
  MONGODB_URI: "mongodb://localhost:27017/unused",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000",
  RATE_LIMIT_MAX: "10000",
  JWT_SECRET: "test-jwt-secret-0123456789abcdefghijklmnop",
  TOTP_ENCRYPTION_KEY: "test-totp-key-0123456789abcdefghijklmnop",
  COOKIE_SECURE: "false",
  APP_VERSION: "test",
});

export const tokens = createTokenService(testEnv.JWT_SECRET, testEnv.ACCESS_TOKEN_TTL_SEC);

/** Captures OTPs instead of sending them. */
export class RecordingOtpSender implements OtpSender {
  readonly name = "recording";
  readonly sent = new Map<string, string>();
  send(phone: string, code: string) {
    this.sent.set(phone, code);
    return Promise.resolve();
  }
}

/** Accepts "google:<sub>:<email>" as an ID token. */
export const fakeGoogle: GoogleVerifier = {
  verify(idToken) {
    const [prefix, sub, email] = idToken.split(":");
    if (prefix !== "google" || !sub)
      return Promise.reject(new HttpError(401, "Google sign-in failed"));
    return Promise.resolve({ sub, ...(email ? { email } : {}), name: "Google User" });
  },
};

let redis: Redis;

/** Connects Mongo + Redis for the file and wipes both before each test. */
export function useTestDatabase() {
  beforeAll(async () => {
    await connectMongo(inject("mongoUri"), silentLogger, { maxAttempts: 3 });
    await mongoose.connection.syncIndexes();
    redis = new Redis(process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15", {
      maxRetriesPerRequest: 1,
    });
  });
  beforeEach(async () => {
    await redis.flushdb();
    const collections = await mongoose.connection.db?.collections();
    await Promise.all((collections ?? []).map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    redis.disconnect();
  });
  return { redis: () => redis };
}

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: testEnv,
    logger: silentLogger,
    redis,
    health: { db: () => true, redis: () => true, version: "test" },
    otpSender: new RecordingOtpSender(),
    googleVerifier: fakeGoogle,
    ...overrides,
  });
}

/** Returns the "name=value" part of a Set-Cookie header for `name`. */
export function cookieFrom(res: request.Response, name: string): string | undefined {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  const line = header?.find((c) => c.startsWith(`${name}=`));
  const pair = line?.split(";")[0];
  return pair && pair !== `${name}=` ? pair : undefined;
}

export function setCookieLine(res: request.Response, name: string): string | undefined {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith(`${name}=`));
}

type App = ReturnType<typeof buildTestApp>;

/** Full OTP login. Returns the access token and refresh cookie. */
export async function loginStudent(
  app: App,
  sender: RecordingOtpSender,
  phone = "9876543210",
  userAgent = "test-device",
) {
  await request(app).post("/api/auth/otp/send").send({ phone }).expect(200);
  const code = sender.sent.get(`+91${phone.slice(-10)}`);
  const res = await request(app)
    .post("/api/auth/otp/verify")
    .set("User-Agent", userAgent)
    .send({ phone, code })
    .expect(200);
  return {
    accessToken: res.body.accessToken as string,
    userId: res.body.user.id as string,
    cookie: cookieFrom(res, "mp_rt") ?? "",
  };
}

export const ADMIN_PASSWORD = "Correct-Horse-Battery-9";

/** Creates an admin user with a password and (optionally) enrolled TOTP. */
export async function createAdmin(
  role: Role = "superadmin",
  email = `${role}@example.com`,
  enrolled = true,
) {
  const secret = generateTotpSecret();
  const user = await UserModel.create({
    role,
    email,
    name: `${role} admin`,
    passwordHash: await argon2.hash(ADMIN_PASSWORD),
    ...(enrolled
      ? { totp: { secretEnc: encrypt(secret, testEnv.TOTP_ENCRYPTION_KEY), enabled: true } }
      : {}),
  });
  return { user, secret };
}

/** Access token for any user id + role, without going through a login flow. */
export async function accessTokenFor(userId: string, role: Role) {
  return tokens.signAccess({ userId, role, sessionId: new mongoose.Types.ObjectId().toString() });
}

/** Full admin login (password + TOTP). */
export async function loginAdmin(app: App, email: string, secret: string) {
  const login = await request(app)
    .post("/api/admin/auth/login")
    .send({ email, password: ADMIN_PASSWORD })
    .expect(200);
  const res = await request(app)
    .post("/api/admin/auth/totp/verify")
    .send({ challengeToken: login.body.challengeToken, code: totpCode(secret, Date.now()) })
    .expect(200);
  return { accessToken: res.body.accessToken as string, cookie: cookieFrom(res, "mp_art") ?? "" };
}

import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

const valid = {
  MONGODB_URI: "mongodb://localhost:27017/mockprep",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000, http://localhost:3001",
  JWT_SECRET: "x".repeat(32),
  TOTP_ENCRYPTION_KEY: "y".repeat(32),
};

describe("parseEnv", () => {
  it("parses a valid env with defaults", () => {
    const env = parseEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000", "http://localhost:3001"]);
    expect(env.version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("prefers APP_VERSION, then the short Render commit", () => {
    expect(parseEnv({ ...valid, APP_VERSION: "v9" }).version).toBe("v9");
    expect(parseEnv({ ...valid, RENDER_GIT_COMMIT: "abcdef1234" }).version).toBe("abcdef1");
  });

  it("defaults COOKIE_SECURE to true only in production", () => {
    expect(parseEnv(valid).COOKIE_SECURE).toBe(false);
    expect(parseEnv({ ...valid, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
    expect(
      parseEnv({ ...valid, NODE_ENV: "production", COOKIE_SECURE: "false" }).COOKIE_SECURE,
    ).toBe(false);
  });

  it("requires MSG91 credentials when OTP_PROVIDER=msg91", () => {
    expect(() => parseEnv({ ...valid, OTP_PROVIDER: "msg91" })).toThrow(
      /MSG91_AUTH_KEY[\s\S]*MSG91_TEMPLATE_ID/,
    );
  });

  it("parses GOOGLE_CLIENT_IDS as a list", () => {
    expect(parseEnv(valid).GOOGLE_CLIENT_IDS).toEqual([]);
    expect(parseEnv({ ...valid, GOOGLE_CLIENT_IDS: "a.apps, b.apps" }).GOOGLE_CLIENT_IDS).toEqual([
      "a.apps",
      "b.apps",
    ]);
  });

  it("parses the free-hosting switches", () => {
    expect(parseEnv(valid)).toMatchObject({
      RUN_WORKER_IN_API: false,
      SEED_ON_START: false,
      WORKER_CONCURRENCY: 2,
    });
    const free = parseEnv({
      ...valid,
      RUN_WORKER_IN_API: "true",
      SEED_ON_START: "1",
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    });
    expect(free).toMatchObject({
      RUN_WORKER_IN_API: true,
      SEED_ON_START: true,
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    });
  });

  it("fails with every invalid variable listed", () => {
    expect(() => parseEnv({ CORS_ORIGINS: "not-a-url", PORT: "abc" })).toThrow(
      /MONGODB_URI[\s\S]*REDIS_URL[\s\S]*CORS_ORIGINS[\s\S]*JWT_SECRET/,
    );
  });
});

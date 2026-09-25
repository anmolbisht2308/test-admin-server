import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";

const valid = {
  MONGODB_URI: "mongodb://localhost:27017/mockprep",
  REDIS_URL: "redis://localhost:6379",
  CORS_ORIGINS: "http://localhost:3000, http://localhost:3001",
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

  it("fails with every invalid variable listed", () => {
    expect(() => parseEnv({ CORS_ORIGINS: "not-a-url", PORT: "abc" })).toThrow(
      /MONGODB_URI[\s\S]*REDIS_URL[\s\S]*CORS_ORIGINS/,
    );
  });
});

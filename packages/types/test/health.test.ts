import { describe, expect, it } from "vitest";
import { healthResponseSchema, pingJobDataSchema } from "../src/index.js";

describe("healthResponseSchema", () => {
  it("accepts a valid payload", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      db: "up",
      redis: "up",
      version: "0.1.0",
    });
    expect(parsed.status).toBe("ok");
  });

  it("rejects unknown service states", () => {
    expect(() =>
      healthResponseSchema.parse({ status: "ok", db: "maybe", redis: "up", version: "x" }),
    ).toThrow();
  });
});

describe("pingJobDataSchema", () => {
  it("requires an ISO timestamp", () => {
    expect(() => pingJobDataSchema.parse({ requestedAt: "yesterday", source: "x" })).toThrow();
  });
});

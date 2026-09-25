import type { Job } from "bullmq";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { parseEnv } from "../src/env.js";
import { createPingProcessor } from "../src/jobs/ping.js";

const logger = pino({ level: "silent" });
const fakeJob = (data: unknown) => ({ id: "1", data }) as Job<unknown>;

describe("ping processor", () => {
  it("returns pong with latency", async () => {
    const requestedAt = "2026-01-01T00:00:00.000Z";
    const process = createPingProcessor(logger, () => Date.parse(requestedAt) + 42);
    await expect(process(fakeJob({ requestedAt, source: "test" }))).resolves.toEqual({
      pong: true,
      latencyMs: 42,
    });
  });

  it("rejects invalid job data", async () => {
    const process = createPingProcessor(logger);
    await expect(process(fakeJob({ source: "" }))).rejects.toThrow();
  });
});

describe("worker env", () => {
  it("requires REDIS_URL", () => {
    expect(() => parseEnv({})).toThrow(/REDIS_URL/);
    expect(parseEnv({ REDIS_URL: "rediss://default:x@host:6379" }).WORKER_CONCURRENCY).toBe(5);
  });
});

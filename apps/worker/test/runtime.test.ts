import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { startWorkers } from "../src/runtime.js";

describe("startWorkers", () => {
  it("starts, runs the startup ping and closes cleanly", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "info" }, { write: (line: string) => lines.push(line) });
    const runtime = await startWorkers({
      redisUrl: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      logger,
      concurrency: 1,
      source: "test",
    });
    // The startup ping is processed by the same runtime.
    for (let i = 0; i < 50 && !lines.some((l) => l.includes('"pong"')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await runtime.close();
    expect(lines.some((l) => l.includes('"worker started"'))).toBe(true);
    expect(lines.some((l) => l.includes('"pong"') && l.includes('"source":"test"'))).toBe(true);
    expect(lines.some((l) => l.includes('"worker stopped"'))).toBe(true);
  });
});

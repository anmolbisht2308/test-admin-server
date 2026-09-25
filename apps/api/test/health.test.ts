import { healthResponseSchema } from "@mockprep/types";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, inject } from "vitest";
import { connectMongo, isMongoUp } from "../src/db.js";
import { buildTestApp, silentLogger } from "./helpers.js";

describe("GET /health", () => {
  beforeAll(async () => {
    await connectMongo(inject("mongoUri"), silentLogger, { maxAttempts: 3 });
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it("reports ok when Mongo and Redis are up", async () => {
    const app = buildTestApp({
      health: { db: isMongoUp, redis: () => true, version: "1.2.3" },
    });
    const res = await request(app).get("/health").expect(200);

    expect(healthResponseSchema.parse(res.body)).toEqual({
      status: "ok",
      db: "up",
      redis: "up",
      version: "1.2.3",
    });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns 503 degraded when Redis is down", async () => {
    const app = buildTestApp({
      health: { db: isMongoUp, redis: () => Promise.resolve(false), version: "1.2.3" },
    });
    const res = await request(app).get("/health").expect(503);
    expect(res.body).toMatchObject({ status: "degraded", db: "up", redis: "down" });
  });

  it("returns 503 degraded when Mongo is down", async () => {
    const app = buildTestApp({
      health: { db: () => false, redis: () => true, version: "1.2.3" },
    });
    const res = await request(app).get("/health").expect(503);
    expect(res.body).toMatchObject({ status: "degraded", db: "down", redis: "up" });
  });

  it("sends CORS headers only for allowed origins", async () => {
    const app = buildTestApp();
    const allowed = await request(app).get("/health").set("Origin", "http://localhost:3000");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");

    const denied = await request(app).get("/health").set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

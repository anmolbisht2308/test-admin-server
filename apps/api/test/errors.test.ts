import { apiErrorSchema } from "@mockprep/types";
import { Router } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { HttpError } from "../src/lib/httpError.js";
import { asyncHandler } from "../src/middleware/asyncHandler.js";
import { buildTestApp, useTestDatabase } from "./helpers.js";

describe("error handling", () => {
  useTestDatabase();

  it("returns { error } with 404 for unknown routes", async () => {
    const res = await request(buildTestApp()).get("/nope").expect(404);
    expect(apiErrorSchema.parse(res.body).error).toContain("/nope");
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await request(buildTestApp())
      .post("/anything")
      .set("Content-Type", "application/json")
      .send("{bad json")
      .expect(400);
    expect(res.body).toEqual({ error: "Invalid JSON" });
  });

  it("maps HttpError, ZodError and unknown errors from async handlers", async () => {
    const router = Router();
    router.get(
      "/http",
      asyncHandler(async () => {
        await Promise.resolve();
        throw new HttpError(409, "Already exists", { id: "x" });
      }),
    );
    router.get(
      "/zod",
      asyncHandler(async () => {
        await Promise.resolve();
        z.object({ n: z.number() }).parse({ n: "one" });
      }),
    );
    router.get(
      "/boom",
      asyncHandler(async () => {
        await Promise.resolve();
        throw new Error("secret internals");
      }),
    );
    const app = buildTestApp({ routers: [router] });

    const http = await request(app).get("/api/http").expect(409);
    expect(http.body).toEqual({ error: "Already exists", details: { id: "x" } });

    const zod = await request(app).get("/api/zod").expect(400);
    const zodBody = apiErrorSchema.parse(zod.body);
    expect(zodBody.error).toBe("Validation failed");
    expect(Array.isArray(zodBody.details)).toBe(true);

    const boom = await request(app).get("/api/boom").expect(500);
    expect(boom.body).toEqual({ error: "Internal server error" });
  });
});

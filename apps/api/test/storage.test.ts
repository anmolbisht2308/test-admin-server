import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalStorage, S3Storage, newFigureKey } from "../src/services/storage.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mockprep-uploads-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

async function setup() {
  const storage = new LocalStorage(dir, "test-secret-0123456789abcdef0123456789");
  const app = buildTestApp({ storage });
  const auth = {
    Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "content")}`,
  };
  return { app, auth };
}

describe("figure uploads (local driver)", () => {
  it("presigns, accepts the PUT and serves the file", async () => {
    const { app, auth } = await setup();
    const presign = await request(app)
      .post("/api/admin/figures/presign")
      .set(auth)
      .send({ contentType: "image/png", size: png.length })
      .expect(200);
    const { uploadUrl, headers, fileUrl } = presign.body;
    expect(fileUrl).toMatch(/^\/api\/files\/figures\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);

    // No Authorization header: the signed URL is the permission (like S3).
    await request(app).put(uploadUrl).set(headers).send(png).expect(204);
    const file = await request(app).get(fileUrl).expect(200);
    expect(file.headers["content-type"]).toBe("image/png");
    expect(file.headers["cache-control"]).toMatch(/immutable/);
  });

  it("rejects tampered, mismatched or oversized uploads", async () => {
    const { app, auth } = await setup();
    const { body } = await request(app)
      .post("/api/admin/figures/presign")
      .set(auth)
      .send({ contentType: "image/png", size: png.length })
      .expect(200);
    await request(app).put(body.uploadUrl).set("Content-Type", "image/jpeg").send(png).expect(403);
    await request(app)
      .put(body.uploadUrl.replace(/sig=[0-9a-f]+/, "sig=00"))
      .set(body.headers)
      .send(png)
      .expect(403);
    await request(app)
      .put(body.uploadUrl)
      .set(body.headers)
      .send(Buffer.concat([png, png]))
      .expect(403);
    const traversal = body.uploadUrl.replace(/figures\/[^?]+/, "..%2F..%2Fetc%2Fpasswd");
    await request(app).put(traversal).set(body.headers).send(png).expect(403);
  });

  it("only lets content writers presign, and only small images", async () => {
    const { app, auth } = await setup();
    const reviewer = {
      Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000ab", "reviewer")}`,
    };
    await request(app)
      .post("/api/admin/figures/presign")
      .set(reviewer)
      .send({ contentType: "image/png", size: 10 })
      .expect(403);
    await request(app)
      .post("/api/admin/figures/presign")
      .set(auth)
      .send({ contentType: "image/svg+xml", size: 10 })
      .expect(400);
    await request(app)
      .post("/api/admin/figures/presign")
      .set(auth)
      .send({ contentType: "image/png", size: 3 * 1024 * 1024 })
      .expect(400);
  });
});

describe("S3 driver", () => {
  it("returns a presigned PUT URL and the public file URL", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    const s3 = new S3Storage("mockprep-files", "ap-south-1", "https://cdn.example.com/");
    const key = newFigureKey("image/webp");
    const result = await s3.presignUpload(key, "image/webp", 1234);
    expect(result.uploadUrl).toMatch(
      /^https:\/\/mockprep-files\.s3\.ap-south-1\.amazonaws\.com\/figures\//,
    );
    expect(result.uploadUrl).toMatch(/X-Amz-Signature=/);
    expect(result.fileUrl).toBe(`https://cdn.example.com/${key}`);
  });
});

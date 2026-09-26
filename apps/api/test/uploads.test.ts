import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalStorage, QuestionModel, TestModel, UploadModel } from "@mockprep/core";
import type { Question, Upload } from "@mockprep/types";
import { startWorkers, type WorkerRuntime } from "@mockprep/worker/runtime";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seed } from "./factories.js";
import { accessTokenFor, buildTestApp, silentLogger, useTestDatabase } from "./helpers.js";

useTestDatabase();

const FIXTURES = fileURLToPath(new URL("../../worker/test/fixtures/", import.meta.url));
const fixture = (name: string) => readFile(path.join(FIXTURES, name));

let dir: string;
let storage: LocalStorage;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mockprep-ingest-"));
  storage = new LocalStorage(dir, "test-secret-0123456789abcdef0123456789");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

let auth: { Authorization: string };
beforeEach(async () => {
  await seed();
  auth = { Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "content")}` };
});

type App = ReturnType<typeof buildTestApp>;

/** Presign → PUT, like the admin upload page. */
async function put(app: App, file: string, kind: "paper" | "key" | "solutions") {
  const body = await fixture(file);
  const presign = await request(app)
    .post("/api/admin/uploads/presign")
    .set(auth)
    .send({ kind, contentType: "application/pdf", size: body.length })
    .expect(200);
  await request(app).put(presign.body.uploadUrl).set(presign.body.headers).send(body).expect(204);
  const key = (presign.body.fileUrl as string).replace("/api/files/", "");
  return { key, name: file, contentType: "application/pdf" as const };
}

/** Runs the real worker runtime (text parser) against the test Redis + Mongo. */
let runtime: WorkerRuntime | undefined;
async function startIngestWorker() {
  runtime = await startWorkers({
    redisUrl: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
    logger: silentLogger,
    concurrency: 1,
    source: "test",
    ingest: { storage, ai: null, chunkPages: 6 },
  });
}
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function waitFor(app: App, id: string): Promise<Upload> {
  for (let i = 0; i < 100; i++) {
    const res = await request(app).get(`/api/admin/uploads/${id}`).set(auth).expect(200);
    const upload = res.body as Upload;
    if (upload.status === "ready" || upload.status === "failed") return upload;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("upload did not finish");
}

async function uploadSbi(app: App, withKey = true) {
  const paper = await put(app, "sbi-paper.pdf", "paper");
  const key = withKey ? await put(app, "sbi-key.pdf", "key") : null;
  const res = await request(app)
    .post("/api/admin/uploads")
    .set(auth)
    .send({
      title: "SBI PO Practice 3",
      examKey: "sbi-po",
      templateKey: "sbi-po-prelims",
      files: { paper, key },
    })
    .expect(201);
  return waitFor(app, (res.body as Upload).id);
}

const questionsOf = async (app: App, testId: string) => {
  const res = await request(app).get(`/api/admin/tests/${testId}`).set(auth).expect(200);
  const ids = (res.body.test.sections as { questionIds: string[] }[]).flatMap((s) => s.questionIds);
  return { body: res.body, questions: ids.map((id) => res.body.questions[id] as Question) };
};

describe("PDF upload → draft test", () => {
  it("SBI sample + key: correct draft, only the figure question flagged, review → publish", async () => {
    await startIngestWorker();
    const app = buildTestApp({ storage });
    const upload = await uploadSbi(app);
    expect(upload).toMatchObject({ status: "ready", progress: 100, error: null });
    expect(upload.stats).toMatchObject({
      extractor: "text",
      found: 12,
      expected: 100,
      autoApproved: 11,
      toReview: 1,
      flagCounts: { needs_figure: 1 },
    });
    expect(upload.log.map((l) => l.message)).toContain(
      "Answer key: 12 of 12 answers applied (matched by number)",
    );

    const testId = upload.testId as string;
    const { body, questions } = await questionsOf(app, testId);
    expect(body.test).toMatchObject({ status: "draft", isFree: true, uploadId: upload.id });
    expect(body.test.testFlags).toEqual([
      "Found 12 questions; the SBI PO Prelims template expects 100.",
    ]);
    expect(questions.map((q) => q.section)).toEqual([
      ...Array(4).fill("English Language"),
      ...Array(4).fill("Quantitative Aptitude"),
      ...Array(4).fill("Reasoning Ability"),
    ]);
    expect(questions.map((q) => q.correct[0])).toEqual([1, 1, 2, 1, 2, 2, 2, 1, 2, 3, 0, 2]);
    const flagged = questions.filter((q) => q.status === "draft");
    expect(flagged.map((q) => [q.number, q.flags])).toEqual([[8, ["needs_figure"]]]);
    expect(questions.every((q) => q.answerSource === "key" && (q.sourcePage ?? 0) >= 1)).toBe(true);

    // The tests list shows what is left to review.
    const list = await request(app).get("/api/admin/tests").set(auth).expect(200);
    expect(list.body.tests[0]).toMatchObject({ id: testId, toReview: 1, uploadId: upload.id });

    // Publishing with an unreviewed question needs confirmation.
    const blocked = await request(app)
      .post(`/api/admin/tests/${testId}/publish`)
      .set(auth)
      .send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("1 question(s) are not reviewed yet");
    expect(blocked.body.details).toMatchObject({ canForce: true, drafts: [flagged[0]?.id] });

    // Approve is blocked until the figure is dealt with.
    const q8 = flagged[0] as Question;
    const refused = await request(app).post(`/api/admin/questions/${q8.id}/approve`).set(auth);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^Can't approve: upload the figure/);

    // The admin adds the figure (editing recomputes flags), then approves.
    const {
      id: _id,
      rootId: _r,
      version: _v,
      isLatest: _l,
      examFamily: _f,
      hash: _h,
      flags: _fl,
      createdAt: _c,
      updatedAt: _u,
      ...fields
    } = q8;
    const edited = await request(app)
      .put(`/api/admin/questions/${q8.id}`)
      .set(auth)
      .send({
        ...fields,
        figureUrl: "/api/files/figures/2026/01/00000000-0000-4000-8000-000000000000.png",
      })
      .expect(200);
    expect(edited.body.question).toMatchObject({ flags: [], status: "draft" });
    const approved = await request(app)
      .post(`/api/admin/questions/${q8.id}/approve`)
      .set(auth)
      .expect(200);
    expect(approved.body.question).toMatchObject({ status: "approved", flags: [] });

    // 12 of 100 questions: still needs confirmation, then publishes.
    const again = await request(app).post(`/api/admin/tests/${testId}/publish`).set(auth).send({});
    expect(again.status).toBe(409);
    expect(again.body.details.canForce).toBe(true);
    const published = await request(app)
      .post(`/api/admin/tests/${testId}/publish`)
      .set(auth)
      .send({ force: true })
      .expect(200);
    expect(published.body.test.status).toBe("published");

    // A published test's upload cannot be re-run.
    const retry = await request(app).post(`/api/admin/uploads/${upload.id}/retry`).set(auth);
    expect(retry.status).toBe(409);
  });

  it("re-running replaces the previous output; approve-answered approves complete drafts only", async () => {
    await startIngestWorker();
    const app = buildTestApp({ storage });
    const first = await uploadSbi(app, false);
    expect(first.stats).toMatchObject({
      autoApproved: 0,
      toReview: 12,
      flagCounts: { no_answer: 12, needs_figure: 1 },
    });

    const retry = await request(app)
      .post(`/api/admin/uploads/${first.id}/retry`)
      .set(auth)
      .expect(200);
    expect(retry.body).toMatchObject({ status: "queued", progress: 0 });
    const second = await waitFor(app, first.id);
    expect(second.status).toBe("ready");
    expect(second.testId).not.toBe(first.testId);
    expect(await TestModel.countDocuments()).toBe(1);
    expect(await QuestionModel.countDocuments()).toBe(12);

    // Answer Q1 by hand, then approve everything answered.
    const { questions } = await questionsOf(app, second.testId as string);
    const q1 = questions[0] as Question;
    const {
      id: _id,
      rootId: _r,
      version: _v,
      isLatest: _l,
      examFamily: _f,
      hash: _h,
      flags: _fl,
      createdAt: _c,
      updatedAt: _u,
      ...fields
    } = q1;
    const edited = await request(app)
      .put(`/api/admin/questions/${q1.id}`)
      .set(auth)
      .send({ ...fields, correct: [1], answerSource: "manual" })
      .expect(200);
    expect(edited.body.question.flags).toEqual([]);

    const res = await request(app)
      .post(`/api/admin/tests/${second.testId}/approve-answered`)
      .set(auth)
      .expect(200);
    expect(res.body).toEqual({ approved: 1, remaining: 11 });

    // Missing answers block publishing even with force.
    const blocked = await request(app)
      .post(`/api/admin/tests/${second.testId}/publish`)
      .set(auth)
      .send({ force: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("11 question(s) have no answer");
    expect(blocked.body.details.canForce).toBe(false);
  });

  it("fails a scanned PDF with a clear message when there is no AI key", async () => {
    await startIngestWorker();
    const app = buildTestApp({ storage });
    const paper = await put(app, "scan.pdf", "paper");
    const created = await request(app)
      .post("/api/admin/uploads")
      .set(auth)
      .send({
        title: "Scanned",
        examKey: "sbi-po",
        templateKey: "sbi-po-prelims",
        files: { paper },
      })
      .expect(201);
    const upload = await waitFor(app, created.body.id as string);
    expect(upload).toMatchObject({
      status: "failed",
      error: "This PDF is a scan — add GEMINI_API_KEY",
    });
  });

  it("re-queues unfinished uploads when a worker starts", async () => {
    const app = buildTestApp({ storage, enqueueIngest: () => Promise.resolve() });
    const paper = await put(app, "jee-paper.pdf", "paper");
    const created = await request(app)
      .post("/api/admin/uploads")
      .set(auth)
      .send({
        title: "JEE Practice",
        examKey: "jee-main",
        templateKey: "jee-main",
        files: { paper },
      })
      .expect(201);
    // Nothing processed it (the enqueue was dropped, as if the worker died).
    expect((await UploadModel.findById(created.body.id))?.status).toBe("queued");
    await startIngestWorker();
    const upload = await waitFor(app, created.body.id as string);
    expect(upload.stats).toMatchObject({ found: 9, autoApproved: 9, toReview: 0 });
    const { questions } = await questionsOf(app, upload.testId as string);
    expect(questions.map((q) => [q.section, q.number, q.type])).toEqual([
      ["Physics", 1, "mcq_single"],
      ["Physics", 2, "mcq_single"],
      ["Physics", 3, "integer"],
      ["Chemistry", 1, "mcq_single"],
      ["Chemistry", 2, "mcq_single"],
      ["Chemistry", 3, "integer"],
      ["Mathematics", 1, "mcq_single"],
      ["Mathematics", 2, "numeric"],
      ["Mathematics", 3, "mcq_single"],
    ]);
    expect(questions[7]?.numAnswer).toEqual({ min: 2.5, max: 2.5 });
  });
});

describe("upload endpoints", () => {
  it("validates input, reports the extractor and enforces roles", async () => {
    const enqueued: [string, number][] = [];
    const app = buildTestApp({
      storage,
      enqueueIngest: (id, run) => {
        enqueued.push([id, run]);
        return Promise.resolve();
      },
    });
    const config = await request(app).get("/api/admin/uploads/config").set(auth).expect(200);
    expect(config.body).toEqual({ ai: false, model: null, chunkPages: 6 });

    const paper = await put(app, "sbi-paper.pdf", "paper");
    const notPdf = await request(app)
      .post("/api/admin/uploads")
      .set(auth)
      .send({
        title: "Bad",
        examKey: "sbi-po",
        templateKey: "sbi-po-prelims",
        files: { paper: { ...paper, contentType: "image/png" } },
      });
    expect(notPdf.status).toBe(400);
    const wrongTemplate = await request(app)
      .post("/api/admin/uploads")
      .set(auth)
      .send({ title: "Bad", examKey: "sbi-po", templateKey: "jee-main", files: { paper } });
    expect(wrongTemplate.status).toBe(400);

    const ok = await request(app)
      .post("/api/admin/uploads")
      .set(auth)
      .send({ title: "Good", examKey: "sbi-po", templateKey: "sbi-po-prelims", files: { paper } })
      .expect(201);
    expect(enqueued).toEqual([[ok.body.id, 1]]);
    expect(ok.body.files.paper.url).toBe(`/api/files/${paper.key}`);
    const list = await request(app).get("/api/admin/uploads").set(auth).expect(200);
    expect(list.body.uploads).toHaveLength(1);
    expect(list.body.uploads[0].log).toBeUndefined();

    const reviewer = {
      Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000bb", "reviewer")}`,
    };
    await request(app).get("/api/admin/uploads").set(reviewer).expect(200);
    await request(app)
      .post("/api/admin/uploads")
      .set(reviewer)
      .send({ title: "Good", examKey: "sbi-po", templateKey: "sbi-po-prelims", files: { paper } })
      .expect(403);
    const student = {
      Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000cc", "student")}`,
    };
    await request(app).get("/api/admin/uploads").set(student).expect(403);
    await request(app).get("/api/admin/uploads/64b0000000000000000000dd").set(auth).expect(404);
  });
});

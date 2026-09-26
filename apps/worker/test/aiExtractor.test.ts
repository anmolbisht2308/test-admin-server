import { describe, expect, it } from "vitest";
import {
  aiExtract,
  aiReadKey,
  mergeChunks,
  retryDelaySec,
  withRetry,
  type AiClient,
} from "../src/ingest/aiExtractor.js";
import { emptyQuestion, type IngestReporter, type RawQuestion } from "../src/ingest/types.js";
import { SSC_QUESTIONS, SSC_SECTIONS } from "./fixtures/data.js";
import { readFixture } from "./helpers.js";

const recorder = () => {
  const lines: string[] = [];
  const reporter: IngestReporter = {
    log: (message) => {
      lines.push(message);
      return Promise.resolve();
    },
  };
  return { lines, reporter };
};

const noSleep = { sleep: () => Promise.resolve() };

/** Fake Gemini: answers each chunk with the SSC fixture questions on its pages (10 per page). */
function fakeGemini(opts: { failFirst?: { status: number; message: string } } = {}) {
  const calls: { prompt: string; mimeType: string; size: number }[] = [];
  let failed = false;
  const client: AiClient = {
    model: "fake-flash",
    generateJson({ files, prompt }) {
      calls.push({ prompt, mimeType: files[0]?.mimeType ?? "", size: files[0]?.data.length ?? 0 });
      if (opts.failFirst && !failed) {
        failed = true;
        return Promise.reject(
          Object.assign(new Error(opts.failFirst.message), { status: opts.failFirst.status }),
        );
      }
      const [, first, last] = /pages (\d+)-(\d+)/.exec(prompt) ?? [];
      const questions = SSC_QUESTIONS.filter((q) => {
        const page = Math.ceil(q.number / 10);
        return page >= Number(first) && page <= Number(last);
      }).map((q) => ({
        number: q.number,
        page: Math.ceil(q.number / 10),
        section: q.section,
        type: "mcq_single",
        passage: "",
        passageHi: "",
        // The copy at an inner chunk's last page is "cut off" (less complete) to test the merge.
        stem:
          Number(last) < 4 && Math.ceil(q.number / 10) === Number(last) && q.number % 10 === 0
            ? ""
            : q.stem,
        stemHi: "",
        options: q.options,
        optionsHi: [],
        answer: Array.isArray(q.answer) ? q.answer : [],
        numAnswer: null,
        answerSource: "ai",
        solution: "",
        topic: "Arithmetic",
        difficulty: "easy",
        hasFigure: false,
        confidence: 0.9,
      }));
      return Promise.resolve(JSON.stringify({ questions }));
    },
  };
  return { client, calls };
}

const template = {
  name: "SSC CGL Tier 1",
  optionCount: 4,
  sections: SSC_SECTIONS.map((name) => ({ name, count: 10, aliases: [] })),
};

describe("AI extractor (mocked Gemini)", () => {
  it("splits into overlapping chunks, merges duplicates and keeps the complete copy", async () => {
    const { client, calls } = fakeGemini();
    const { lines, reporter } = recorder();
    const progress: string[] = [];
    const questions = await aiExtract(await readFixture("ssc-paper.pdf"), {
      client,
      template,
      chunkPages: 2,
      hasKey: false,
      reporter,
      onChunk: (done, total) => {
        progress.push(`${done}/${total}`);
        return Promise.resolve();
      },
    });
    // 4 pages, 2 per chunk, 1 page overlap → 1-2, 2-3, 3-4.
    expect(calls.map((c) => /pages (\d+-\d+)/.exec(c.prompt)?.[1])).toEqual(["1-2", "2-3", "3-4"]);
    expect(calls.every((c) => c.mimeType === "application/pdf" && c.size > 0)).toBe(true);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(questions.map((q) => q.number)).toEqual(SSC_QUESTIONS.map((q) => q.number));
    expect(questions.every((q) => q.stem.length > 0)).toBe(true);
    expect(questions[0]).toMatchObject({
      answerSource: "ai",
      correct: [1],
      section: SSC_SECTIONS[0],
      page: 1,
    });
    expect(lines).toContain("pages 1-2: 20 questions");
    // Prompt rules reach the model.
    expect(calls[0]?.prompt).toMatch(/Copy text exactly/);
    expect(calls[0]?.prompt).toMatch(/solve the question and set answerSource "ai"/);
  });

  it("tells the model not to solve when a key was uploaded", async () => {
    const { client, calls } = fakeGemini();
    await aiExtract(await readFixture("sbi-paper.pdf"), {
      client,
      template,
      chunkPages: 6,
      hasKey: true,
      reporter: recorder().reporter,
    });
    expect(calls[0]?.prompt).toMatch(/Do not solve questions/);
  });

  it("waits and retries when rate limited, logging the wait", async () => {
    const { client, calls } = fakeGemini({
      failFirst: { status: 429, message: "Resource exhausted. Please retry in 7.2s." },
    });
    const { lines, reporter } = recorder();
    const waits: number[] = [];
    const questions = await aiExtract(await readFixture("ssc-paper.pdf"), {
      client,
      template,
      chunkPages: 6,
      hasKey: false,
      reporter,
      retry: { sleep: (ms) => (waits.push(ms), Promise.resolve()) },
    });
    expect(calls).toHaveLength(2);
    expect(waits).toEqual([8000]);
    expect(lines).toContain("rate limited, waiting 8s");
    expect(questions).toHaveLength(40);
  });

  it("does not retry client errors and gives up after max attempts", async () => {
    expect(retryDelaySec(Object.assign(new Error("bad key"), { status: 400 }), 0)).toBeNull();
    expect(retryDelaySec(Object.assign(new Error("oops"), { status: 503 }), 2)).toBe(8);
    let n = 0;
    await expect(
      withRetry(
        () => {
          n++;
          return Promise.reject(Object.assign(new Error("down"), { status: 500 }));
        },
        recorder().reporter,
        { maxAttempts: 3, ...noSleep },
      ),
    ).rejects.toThrow("down");
    expect(n).toBe(3);
  });

  it("reads an answer key image", async () => {
    const client: AiClient = {
      model: "fake",
      generateJson: () =>
        Promise.resolve(
          JSON.stringify({
            answers: [
              { number: 1, answer: "(B)", solution: "" },
              { number: 2, answer: "A, C", solution: "Both." },
            ],
          }),
        ),
    };
    const entries = await aiReadKey(
      { data: new Uint8Array([1]), mimeType: "image/png" },
      client,
      recorder().reporter,
    );
    expect(entries).toEqual([
      { number: 1, token: "(B)", solution: "" },
      { number: 2, token: "A, C", solution: "Both." },
    ]);
  });
});

describe("mergeChunks", () => {
  const q = (number: number, page: number, stem: string, section = "A"): RawQuestion => ({
    ...emptyQuestion(),
    number,
    page,
    stem,
    section,
    options: ["1", "2"],
  });

  it("keeps restarted numbering in other sections", () => {
    const merged = mergeChunks([
      [q(1, 1, "a"), q(2, 1, "b")],
      [q(1, 2, "c", "B"), q(2, 2, "d", "B")],
    ]);
    expect(merged.map((m) => m.stem)).toEqual(["a", "b", "c", "d"]);
  });

  it("replaces a cut-off copy with the complete one", () => {
    const merged = mergeChunks([
      [q(1, 1, "a"), { ...q(2, 2, "b"), options: [] }],
      [q(2, 2, "b"), q(3, 3, "c")],
    ]);
    expect(merged.map((m) => [m.number, m.options.length])).toEqual([
      [1, 2],
      [2, 2],
      [3, 2],
    ]);
  });
});

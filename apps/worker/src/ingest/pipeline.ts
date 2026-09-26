import {
  ExamModel,
  ExamTemplateModel,
  QuestionModel,
  TestModel,
  UploadModel,
  contentFlags,
  questionHash,
  toTemplateSnapshot,
  type Storage,
  type UploadAttrs,
  type UploadFile,
} from "@mockprep/core";
import {
  MAX_OPTIONS,
  type TemplateSnapshot,
  type UploadStats,
  type UploadStatus,
  type ValidationFlag,
} from "@mockprep/types";
import { Types } from "mongoose";
import type { Logger } from "pino";
import { aiExtract, aiReadKey, type AiClient, type RetryOptions } from "./aiExtractor.js";
import { applyKey, parseAnswerKey, parseSolutions } from "./keyParser.js";
import { SCAN_MESSAGE, extractPages, looksScanned } from "./pdf.js";
import { assignSections, missingNumbers } from "./sections.js";
import { parseQuestionPaper } from "./textParser.js";
import type { IngestReporter, KeyEntry, RawQuestion } from "./types.js";

export interface IngestDeps {
  storage: Pick<Storage, "get">;
  /** null → the free text parser is used. */
  ai: AiClient | null;
  chunkPages: number;
  logger: Logger;
  retry?: RetryOptions;
}

/** A failure the admin can act on; its message is shown as-is. */
export class IngestError extends Error {}

const LOG_LIMIT = 300;

function uploadReporter(uploadId: Types.ObjectId): IngestReporter & {
  step(status: UploadStatus, progress: number, message: string): Promise<void>;
  progress(progress: number, message?: string): Promise<void>;
} {
  const push = (message: string, level: "info" | "warn" | "error") => ({
    $push: { log: { $each: [{ at: new Date(), level, message }], $slice: -LOG_LIMIT } },
  });
  return {
    async log(message, level = "info") {
      await UploadModel.updateOne({ _id: uploadId }, push(message, level));
    },
    async step(status, progress, message) {
      await UploadModel.updateOne(
        { _id: uploadId },
        { $set: { status, progress, message }, ...push(message, "info") },
      );
    },
    async progress(progress, message) {
      await UploadModel.updateOne(
        { _id: uploadId },
        { $set: { progress: Math.round(progress), ...(message ? { message } : {}) } },
      );
    },
  };
}

const isPdf = (f: UploadFile) => f.contentType === "application/pdf";

/** Final question type from what was found (options / numeric answer / several answers). */
function settleType(q: RawQuestion) {
  if (q.options.length === 0) {
    q.correct = [];
    q.type =
      q.numAnswer && !Number.isInteger(q.numAnswer.min)
        ? "numeric"
        : q.type === "numeric"
          ? "numeric"
          : "integer";
    if (q.type === "integer" && q.numAnswer && !Number.isInteger(q.numAnswer.max))
      q.type = "numeric";
  } else {
    q.numAnswer = null;
    q.type =
      q.correct.length > 1
        ? "mcq_multi"
        : q.type === "mcq_multi" && q.correct.length === 0
          ? "mcq_multi"
          : "mcq_single";
  }
  // Keep what the schema accepts: at most 6 options, Hindi options only when they pair up.
  q.options = q.options.slice(0, MAX_OPTIONS).map((o) => o ?? "");
  q.correct = q.correct.filter((i) => i < q.options.length);
  if (q.optionsHi.length !== q.options.length) q.optionsHi = [];
}

async function readKeyFile(
  kind: "answer key" | "solutions",
  file: UploadFile,
  deps: IngestDeps,
  reporter: IngestReporter,
  expected: number,
): Promise<KeyEntry[]> {
  const bytes = new Uint8Array(await deps.storage.get(file.key));
  if (isPdf(file)) {
    const pages = await extractPages(bytes);
    if (!looksScanned(pages)) {
      const text = pages.join("\n");
      const entries = kind === "answer key" ? parseAnswerKey(text) : parseSolutions(text);
      // A text key that covers most of the paper is used as is; otherwise let the AI read it.
      if (entries.length >= Math.ceil(expected * 0.5) || !deps.ai) {
        await reporter.log(`${kind}: read ${entries.length} entries from the text`);
        return entries;
      }
    }
  }
  if (!deps.ai) {
    await reporter.log(
      `The ${kind} is ${isPdf(file) ? "a scan" : "an image"}: add GEMINI_API_KEY to read it. Skipped.`,
      "warn",
    );
    return [];
  }
  const entries = await aiReadKey(
    { data: bytes, mimeType: file.contentType },
    deps.ai,
    reporter,
    deps.retry,
  );
  await reporter.log(`${kind}: AI read ${entries.length} entries`);
  return entries;
}

/** Runs the whole pipeline for one upload. Never throws: failures are written to the upload. */
export async function runIngest(uploadId: string, deps: IngestDeps): Promise<void> {
  const id = new Types.ObjectId(uploadId);
  const upload = await UploadModel.findById(id).lean<UploadAttrs & { _id: Types.ObjectId }>();
  if (!upload) {
    deps.logger.warn({ uploadId }, "ingest: upload not found");
    return;
  }
  const reporter = uploadReporter(id);
  const started = Date.now();
  await UploadModel.updateOne(
    { _id: id },
    {
      $set: {
        status: "extracting",
        progress: 5,
        message: "Reading the paper",
        log: [{ at: new Date(), level: "info", message: `Run ${upload.runs} started` }],
        error: null,
        stats: null,
        startedAt: new Date(),
        finishedAt: null,
      },
    },
  );

  try {
    const [template, exam] = await Promise.all([
      ExamTemplateModel.findOne({ key: upload.templateKey }).lean(),
      ExamModel.findOne({ slug: upload.examKey }).lean(),
    ]);
    if (!template || !exam) throw new IngestError("The exam or its template no longer exists");
    const snapshot: TemplateSnapshot = toTemplateSnapshot(template);
    const expected = snapshot.sections.reduce((acc, s) => acc + s.count, 0);

    // ---- 1. extract
    const paper = new Uint8Array(await deps.storage.get(upload.files.paper.key));
    let questions: RawQuestion[];
    let pages = 0;
    const hasKey = upload.files.key !== null;
    if (deps.ai) {
      await reporter.step("extracting", 10, `Extracting questions with AI (${deps.ai.model})`);
      questions = await aiExtract(paper, {
        client: deps.ai,
        template: snapshot,
        chunkPages: deps.chunkPages,
        hasKey,
        reporter,
        retry: deps.retry,
        onChunk: (done, total) =>
          reporter.progress(10 + (50 * done) / total, `Extracting: part ${done} of ${total}`),
      });
      pages = Math.max(0, ...questions.map((q) => q.page ?? 0));
    } else {
      await reporter.step(
        "extracting",
        10,
        "Extracting questions with the text parser (no GEMINI_API_KEY)",
      );
      const texts = await extractPages(paper);
      pages = texts.length;
      if (looksScanned(texts)) throw new IngestError(SCAN_MESSAGE);
      questions = parseQuestionPaper(texts, {
        sectionNames: snapshot.sections.flatMap((s) => [s.name, ...s.aliases]),
      });
    }
    if (questions.length === 0) throw new IngestError("No questions were found in the paper");
    await reporter.log(`Found ${questions.length} questions (template expects ${expected})`);

    // ---- 2. answer key + solutions
    await reporter.step(
      "answer_key",
      60,
      hasKey || upload.files.solutions ? "Reading the answer key" : "No answer key uploaded",
    );
    if (upload.files.solutions) {
      const entries = await readKeyFile(
        "solutions",
        upload.files.solutions,
        deps,
        reporter,
        questions.length,
      );
      const r = applyKey(questions, entries, "key");
      await reporter.log(
        `Solutions: ${r.solutions} explanations, ${r.answered} answers (matched by ${r.matchedBy})`,
      );
    }
    await reporter.progress(68);
    if (upload.files.key) {
      const entries = await readKeyFile(
        "answer key",
        upload.files.key,
        deps,
        reporter,
        questions.length,
      );
      const r = applyKey(questions, entries, "key");
      await reporter.log(
        `Answer key: ${r.answered} of ${questions.length} answers applied (matched by ${r.matchedBy})`,
      );
      if (r.answered < questions.length) {
        await reporter.log(
          `${questions.length - r.answered} questions have no answer from the key`,
          "warn",
        );
      }
    }

    // ---- 3. validate
    await reporter.step("validating", 75, "Checking every question");
    questions.forEach(settleType);
    const assigned = assignSections(questions, snapshot.sections);
    await reporter.log(
      assigned.method === "headings"
        ? "Sections: matched from the paper's headings"
        : "Sections: headings did not match the template, filled in order by section counts",
      assigned.method === "headings" ? "info" : "warn",
    );
    const hashes = questions.map((q) => questionHash(q));
    const inBank = new Set(
      (
        await QuestionModel.find({
          hash: { $in: hashes },
          isLatest: true,
          uploadId: { $ne: id },
        }).distinct("hash")
      ).map(String),
    );
    const seen = new Set<string>();
    const flags = questions.map((q, i) => {
      const f: ValidationFlag[] = contentFlags({ ...q, figureUrl: null }, snapshot.optionCount);
      const hash = hashes[i] as string;
      if (inBank.has(hash)) f.push("duplicate");
      if (seen.has(hash)) f.push("duplicate_in_paper");
      seen.add(hash);
      return f;
    });
    const testFlags: string[] = [];
    if (questions.length !== expected) {
      testFlags.push(
        `Found ${questions.length} questions; the ${snapshot.name} template expects ${expected}.`,
      );
    }
    const missing = missingNumbers(questions.map((q) => q.number));
    if (missing.length)
      testFlags.push(
        `Question numbers missing from the paper: ${missing.slice(0, 30).join(", ")}${missing.length > 30 ? "…" : ""}.`,
      );
    for (const f of testFlags) await reporter.log(f, "warn");
    await reporter.progress(85);

    // ---- 4. save (replacing what an earlier run produced)
    const previous = await TestModel.findOne({ uploadId: id });
    if (previous?.status === "published") {
      throw new IngestError(
        "The test from this upload is published. Unpublish it before re-running.",
      );
    }
    const previousIds = previous ? previous.sections.flatMap((s) => s.questionIds) : [];
    const usedElsewhere = new Set(
      (
        await TestModel.find({
          _id: { $ne: previous?._id },
          "sections.questionIds": { $in: previousIds },
        }).distinct("sections.questionIds")
      ).map(String),
    );
    await QuestionModel.deleteMany({
      uploadId: id,
      _id: { $nin: [...usedElsewhere].map((s) => new Types.ObjectId(s)) },
    });
    if (previous) await previous.deleteOne();

    const docs = questions.map((q, i) => {
      const _id = new Types.ObjectId();
      const questionFlags = flags[i] as ValidationFlag[];
      return {
        _id,
        rootId: _id,
        version: 1,
        isLatest: true,
        examKey: upload.examKey,
        examFamily: exam.family,
        section: assigned.sections[i] as string,
        number: q.number,
        order: i,
        type: q.type,
        passage: q.passage,
        passageHi: q.passageHi,
        stem: q.stem,
        options: q.options,
        stemHi: q.stemHi,
        optionsHi: q.optionsHi,
        correct: q.correct,
        numAnswer: q.numAnswer,
        answerSource: q.answerSource,
        solution: q.solution,
        solutionHi: q.solutionHi,
        subject: assigned.sections[i] as string,
        topic: q.topic.slice(0, 120),
        difficulty: q.difficulty,
        hasFigure: q.hasFigure,
        figureUrl: null,
        sourcePage: q.page && q.page > 0 ? q.page : null,
        confidence: q.confidence,
        flags: questionFlags,
        status: questionFlags.length === 0 ? "approved" : "draft",
        hash: hashes[i] as string,
        uploadId: id,
      };
    });
    await QuestionModel.insertMany(docs);
    const test = await TestModel.create({
      title: upload.title,
      examKey: upload.examKey,
      type: "full",
      isFree: true,
      templateSnapshot: snapshot,
      sections: snapshot.sections.map((s) => ({
        name: s.name,
        ...(s.timeSec ? { timeSec: s.timeSec } : {}),
        questionIds: docs.filter((d) => d.section === s.name).map((d) => d._id),
      })),
      testFlags,
      uploadId: id,
    });

    const flagCounts: Partial<Record<ValidationFlag, number>> = {};
    for (const f of flags.flat()) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
    const approved = docs.filter((d) => d.status === "approved").length;
    const stats: UploadStats = {
      extractor: deps.ai ? "ai" : "text",
      pages,
      found: questions.length,
      expected,
      autoApproved: approved,
      toReview: docs.length - approved,
      flagCounts,
      durationMs: Date.now() - started,
    };
    const summary = `Ready: found ${questions.length} of ${expected}, ${approved} auto-approved, ${docs.length - approved} to review`;
    await UploadModel.updateOne(
      { _id: id },
      {
        $set: {
          status: "ready",
          progress: 100,
          message: summary,
          stats,
          testId: test._id,
          finishedAt: new Date(),
        },
        $push: {
          log: { $each: [{ at: new Date(), level: "info", message: summary }], $slice: -LOG_LIMIT },
        },
      },
    );
  } catch (err) {
    const message =
      err instanceof IngestError
        ? err.message
        : `Processing failed: ${err instanceof Error ? err.message : String(err)}`;
    deps.logger.error({ err, uploadId }, "ingest failed");
    await UploadModel.updateOne(
      { _id: id },
      {
        $set: { status: "failed", message, error: message, finishedAt: new Date() },
        $push: {
          log: { $each: [{ at: new Date(), level: "error", message }], $slice: -LOG_LIMIT },
        },
      },
    );
  }
}

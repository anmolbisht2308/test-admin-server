import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type { TemplateSnapshot } from "@mockprep/types";
import { z } from "zod";
import { splitPdf } from "./pdf.js";
import { collapse } from "./text.js";
import { emptyQuestion, type IngestReporter, type KeyEntry, type RawQuestion } from "./types.js";

// ---------------------------------------------------------------- client

export interface AiFile {
  data: Uint8Array;
  mimeType: string;
}

/** The one call the pipeline makes to a model. Tests replace it with a fake. */
export interface AiClient {
  readonly model: string;
  /** Sends files + a prompt, returns the model's JSON text (shaped by `schema`). */
  generateJson(request: { files: AiFile[]; prompt: string; schema: Schema }): Promise<string>;
}

export function createGeminiClient(apiKey: string, model: string): AiClient {
  const ai = new GoogleGenAI({ apiKey });
  return {
    model,
    async generateJson({ files, prompt, schema }) {
      const response = await ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              ...files.map((f) => ({
                inlineData: { mimeType: f.mimeType, data: Buffer.from(f.data).toString("base64") },
              })),
              { text: prompt },
            ],
          },
        ],
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0 },
      });
      return response.text ?? "";
    },
  };
}

// ---------------------------------------------------------------- retry

const statusOf = (err: unknown) =>
  typeof err === "object" &&
  err !== null &&
  typeof (err as { status?: unknown }).status === "number"
    ? (err as { status: number }).status
    : null;

/** Seconds to wait before retrying, or null when the error is not worth retrying. */
export function retryDelaySec(err: unknown, attempt: number): number | null {
  const status = statusOf(err);
  const message = err instanceof Error ? err.message : String(err);
  const network =
    status === null && /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
  if (!(status === 429 || (status !== null && status >= 500) || network)) return null;
  // Gemini says "Please retry in 23.4s" and/or sends retryDelay "23s".
  const hinted =
    /retry in (\d+(?:\.\d+)?)\s*s/i.exec(message) ??
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (hinted) return Math.ceil(Number(hinted[1]));
  return Math.min(60, 2 * 2 ** attempt);
}

export interface RetryOptions {
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn`, retrying on 429/5xx with backoff; waits are logged to the upload. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  reporter: IngestReporter,
  { maxAttempts = 6, sleep = defaultSleep }: RetryOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const wait = retryDelaySec(err, attempt);
      if (wait === null || attempt + 1 >= maxAttempts) throw err;
      await reporter.log(
        statusOf(err) === 429
          ? `rate limited, waiting ${wait}s`
          : `AI service error (${statusOf(err) ?? "network"}), retrying in ${wait}s`,
        "warn",
      );
      await sleep(wait * 1000);
    }
  }
}

// ---------------------------------------------------------------- question extraction

const S = (type: Type, extra: Partial<Schema> = {}): Schema => ({ type, ...extra });
const str = S(Type.STRING);
const strArr = S(Type.ARRAY, { items: str });

export const QUESTIONS_SCHEMA: Schema = S(Type.OBJECT, {
  properties: {
    questions: S(Type.ARRAY, {
      items: S(Type.OBJECT, {
        properties: {
          number: S(Type.INTEGER, { nullable: true }),
          page: S(Type.INTEGER),
          section: str,
          type: S(Type.STRING, { enum: ["mcq_single", "mcq_multi", "integer", "numeric"] }),
          passage: str,
          passageHi: str,
          stem: str,
          stemHi: str,
          options: strArr,
          optionsHi: strArr,
          answer: S(Type.ARRAY, { items: S(Type.INTEGER) }),
          numAnswer: S(Type.NUMBER, { nullable: true }),
          answerSource: S(Type.STRING, { enum: ["document", "ai", "none"] }),
          solution: str,
          topic: str,
          difficulty: S(Type.STRING, { enum: ["easy", "medium", "hard"] }),
          hasFigure: S(Type.BOOLEAN),
          confidence: S(Type.NUMBER),
        },
        required: [
          "number",
          "page",
          "section",
          "type",
          "stem",
          "options",
          "answer",
          "answerSource",
          "hasFigure",
          "confidence",
        ],
        propertyOrdering: [
          "number",
          "page",
          "section",
          "type",
          "passage",
          "passageHi",
          "stem",
          "stemHi",
          "options",
          "optionsHi",
          "answer",
          "numAnswer",
          "answerSource",
          "solution",
          "topic",
          "difficulty",
          "hasFigure",
          "confidence",
        ],
      }),
    }),
  },
  required: ["questions"],
});

export function questionPrompt(opts: {
  template: Pick<TemplateSnapshot, "name" | "optionCount" | "sections">;
  firstPage: number;
  lastPage: number;
  hasKey: boolean;
}): string {
  const sections = opts.template.sections
    .map(
      (s) => `"${s.name}"${s.aliases.length ? ` (also printed as: ${s.aliases.join(", ")})` : ""}`,
    )
    .join(", ");
  return [
    `This file is pages ${opts.firstPage}-${opts.lastPage} of a ${opts.template.name} question paper. Extract every question on these pages.`,
    "Rules:",
    "- Copy text exactly as printed. Do not paraphrase, correct or summarise.",
    "- Strip option labels such as (a), A., (1) from option text.",
    "- Write maths and chemistry as LaTeX inside $...$ (inline) or $$...$$ (display). Write tables as Markdown tables.",
    "- When a passage, data table or set of directions is shared by several questions, copy it in full into `passage` of EVERY question it belongs to.",
    "- Bilingual papers: English goes in stem/options/passage, Hindi in stemHi/optionsHi/passageHi. A Hindi-only paper leaves the English fields empty.",
    "- hasFigure = true when the question needs a diagram, graph or picture to be answered.",
    "- number = the question number as printed. page = the absolute page number in the full paper (this file starts at page " +
      `${opts.firstPage}).`,
    `- section = one of: ${sections}. Use the section heading the question is printed under.`,
    `- The exam normally has ${opts.template.optionCount} options per question. type: mcq_single, mcq_multi (several correct), integer or numeric (no options).`,
    "- answer = 0-based indices of the correct options; numAnswer = the value for integer/numeric questions.",
    opts.hasKey
      ? '- If the paper prints the answer, give it with answerSource "document". Otherwise leave answer empty with answerSource "none" (a separate answer key will be applied). Do not solve questions.'
      : '- If the paper prints the answer, give it with answerSource "document". Otherwise solve the question and set answerSource "ai".',
    "- solution = a short explanation (printed solution if there is one).",
    "- topic = a short topic name; difficulty = easy, medium or hard.",
    "- confidence 0-1 = how sure you are the question was read completely and correctly. Use a low value when it is cut off at the page edge or hard to read.",
    "- A question cut off at the first or last page of this file must still be included, with a low confidence.",
  ].join("\n");
}

const aiQuestionSchema = z.object({
  number: z.number().int().positive().nullable().catch(null),
  page: z.number().int().catch(0),
  section: z.string().catch(""),
  type: z.enum(["mcq_single", "mcq_multi", "integer", "numeric"]).catch("mcq_single"),
  passage: z.string().catch(""),
  passageHi: z.string().catch(""),
  stem: z.string().catch(""),
  stemHi: z.string().catch(""),
  options: z.array(z.string()).catch([]),
  optionsHi: z.array(z.string()).catch([]),
  answer: z.array(z.number().int()).catch([]),
  numAnswer: z.number().nullable().catch(null),
  answerSource: z.enum(["document", "ai", "none"]).catch("none"),
  solution: z.string().catch(""),
  topic: z.string().catch(""),
  difficulty: z.enum(["easy", "medium", "hard"]).catch("medium"),
  hasFigure: z.boolean().catch(false),
  confidence: z.number().min(0).max(1).catch(0.5),
});
const aiQuestionsSchema = z.object({ questions: z.array(z.unknown()) });

/** Model JSON → RawQuestions. Items that cannot be read at all are dropped. */
export function parseAiQuestions(
  json: string,
  pages: { first: number; last: number },
): RawQuestion[] {
  const outer = aiQuestionsSchema.safeParse(JSON.parse(json));
  if (!outer.success) throw new Error("The AI reply was not in the expected shape");
  return outer.data.questions.flatMap((item) => {
    const parsed = aiQuestionSchema.safeParse(item);
    if (!parsed.success) return [];
    const a = parsed.data;
    const mcq = a.type === "mcq_single" || a.type === "mcq_multi";
    const options = mcq ? a.options.map(collapse) : [];
    const correct = mcq
      ? [...new Set(a.answer)].filter((i) => i >= 0 && i < options.length).sort((x, y) => x - y)
      : [];
    const numAnswer = !mcq && a.numAnswer !== null ? { min: a.numAnswer, max: a.numAnswer } : null;
    const answered = correct.length > 0 || numAnswer !== null;
    const q: RawQuestion = {
      ...emptyQuestion(),
      number: a.number,
      section: a.section || null,
      // Some models count pages within the chunk; clamp into the chunk's absolute range.
      page:
        a.page >= pages.first && a.page <= pages.last
          ? a.page
          : a.page >= 1 && a.page <= pages.last - pages.first + 1
            ? pages.first + a.page - 1
            : pages.first,
      type:
        mcq && correct.length > 1
          ? "mcq_multi"
          : a.type === "mcq_multi" && correct.length <= 1
            ? "mcq_single"
            : a.type,
      passage: a.passage.trim(),
      passageHi: a.passageHi.trim(),
      stem: a.stem.trim(),
      stemHi: a.stemHi.trim(),
      options,
      optionsHi: mcq && a.optionsHi.length === options.length ? a.optionsHi.map(collapse) : [],
      correct,
      numAnswer,
      answerSource: answered ? (a.answerSource === "none" ? "ai" : a.answerSource) : "none",
      solution: a.solution.trim(),
      topic: a.topic.trim().slice(0, 120),
      difficulty: a.difficulty,
      hasFigure: a.hasFigure,
      confidence: a.confidence,
    };
    if (q.type === "numeric" && numAnswer && Number.isInteger(numAnswer.min)) q.type = "integer";
    if (q.type === "integer" && numAnswer && !Number.isInteger(numAnswer.min)) q.type = "numeric";
    return [q];
  });
}

/** How complete a copy of a question is (to pick between duplicates from overlapping chunks). */
const completeness = (q: RawQuestion) =>
  (q.stem || q.stemHi ? 3 : 0) +
  q.options.filter(Boolean).length +
  (q.correct.length || q.numAnswer ? 2 : 0) +
  q.confidence +
  (q.stem.length + q.stemHi.length + q.passage.length) / 10_000;

/**
 * Merges chunk results in order. Chunks overlap by a page, so the same question can come back
 * twice: a number seen among the last ~15 merged questions, in the same section and on an
 * adjacent page, is a duplicate, and the more complete copy wins.
 */
export function mergeChunks(chunks: RawQuestion[][]): RawQuestion[] {
  const merged: RawQuestion[] = [];
  for (const chunk of chunks) {
    for (const q of chunk) {
      const from = Math.max(0, merged.length - 15);
      const index =
        q.number === null
          ? -1
          : merged.findIndex(
              (m, i) =>
                i >= from &&
                m.number === q.number &&
                (!m.section || !q.section || m.section === q.section) &&
                Math.abs((m.page ?? 0) - (q.page ?? 0)) <= 1,
            );
      if (index < 0) merged.push(q);
      else if (completeness(q) > completeness(merged[index] as RawQuestion)) merged[index] = q;
    }
  }
  return merged;
}

export interface AiExtractOptions {
  client: AiClient;
  template: Pick<TemplateSnapshot, "name" | "optionCount" | "sections">;
  chunkPages: number;
  hasKey: boolean;
  reporter: IngestReporter;
  /** Called after each chunk with (done, total). */
  onChunk?: (done: number, total: number) => Promise<void>;
  retry?: RetryOptions;
}

/** AI extractor: sends the paper to the model in overlapping page chunks. */
export async function aiExtract(pdf: Uint8Array, opts: AiExtractOptions): Promise<RawQuestion[]> {
  const chunks = await splitPdf(pdf, opts.chunkPages);
  const results: RawQuestion[][] = [];
  for (const [i, chunk] of chunks.entries()) {
    const json = await withRetry(
      () =>
        opts.client.generateJson({
          files: [{ data: chunk.bytes, mimeType: "application/pdf" }],
          prompt: questionPrompt({
            template: opts.template,
            firstPage: chunk.firstPage,
            lastPage: chunk.lastPage,
            hasKey: opts.hasKey,
          }),
          schema: QUESTIONS_SCHEMA,
        }),
      opts.reporter,
      opts.retry,
    );
    const found = parseAiQuestions(json, { first: chunk.firstPage, last: chunk.lastPage });
    results.push(found);
    await opts.reporter.log(
      `pages ${chunk.firstPage}-${chunk.lastPage}: ${found.length} questions`,
    );
    await opts.onChunk?.(i + 1, chunks.length);
  }
  return mergeChunks(results);
}

// ---------------------------------------------------------------- answer keys

export const KEY_SCHEMA: Schema = S(Type.OBJECT, {
  properties: {
    answers: S(Type.ARRAY, {
      items: S(Type.OBJECT, {
        properties: { number: S(Type.INTEGER), answer: str, solution: str },
        required: ["number", "answer"],
        propertyOrdering: ["number", "answer", "solution"],
      }),
    }),
  },
  required: ["answers"],
});

export const KEY_PROMPT = [
  "This file is the answer key and/or solutions for a question paper.",
  "List every question in the order printed, with:",
  "- number: the question number as printed (numbering may restart per section; keep the printed order),",
  "- answer: exactly as printed: an option letter (A-F), an option number (1-6), several letters separated by commas, or the numeric value; empty if none is printed,",
  "- solution: the printed explanation, copied exactly (maths as LaTeX in $...$), or empty.",
].join("\n");

const keyReplySchema = z.object({
  answers: z.array(
    z.object({
      number: z.number().int().positive(),
      answer: z.string().catch(""),
      solution: z.string().catch(""),
    }),
  ),
});

/** Reads an answer key or solutions file (PDF or image) with the model. */
export async function aiReadKey(
  file: AiFile,
  client: AiClient,
  reporter: IngestReporter,
  retry?: RetryOptions,
): Promise<KeyEntry[]> {
  const json = await withRetry(
    () => client.generateJson({ files: [file], prompt: KEY_PROMPT, schema: KEY_SCHEMA }),
    reporter,
    retry,
  );
  const parsed = keyReplySchema.safeParse(JSON.parse(json));
  if (!parsed.success)
    throw new Error("The AI reply for the answer key was not in the expected shape");
  return parsed.data.answers.map((a) => ({
    number: a.number,
    token: a.answer.trim() || null,
    solution: a.solution.trim(),
  }));
}

import { QUESTION_RE, answerTokens, applyAnswerTokens } from "./textParser.js";
import type { KeyEntry, RawQuestion } from "./types.js";
import { append, collapse } from "./text.js";

/*
 * Answer keys come in many shapes: "1. B", "1-(c)", "Q1 (B)", "12. (3)", table dumps like
 * "1 B 2 C 3 D", and plain values for integer questions ("21. 12.5").
 */
const PAIR_RE =
  /(?:^|[\s,;|])(?:Q\s*\.?\s*)?(\d{1,3})(?!\d)\s*(?:[.):\-–]\s*)?\(?\s*([A-Fa-f]|-?\d+(?:\.\d+)?)\s*\)?(?=$|[\s,;|])/g;

/** Parses an answer-key text layer into entries, in printed order. */
export function parseAnswerKey(text: string): KeyEntry[] {
  const entries: KeyEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = collapse(raw);
    for (const m of line.matchAll(PAIR_RE)) {
      entries.push({ number: Number(m[1]), token: m[2] ?? null, solution: "" });
    }
  }
  return entries;
}

/**
 * Parses a solutions file: each "12." / "Q.12" starts an entry; an "Ans:" line or a leading
 * "(b)" gives its answer; everything else is the explanation.
 */
export function parseSolutions(text: string): KeyEntry[] {
  const entries: KeyEntry[] = [];
  let current: KeyEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = collapse(raw);
    if (!line) continue;
    const q = QUESTION_RE.exec(line);
    if (q) {
      current = { number: Number(q[1] ?? q[2]), token: null, solution: "" };
      entries.push(current);
      let rest = q[3] ?? "";
      const lead = /^(?:ans(?:wer)?\s*[:.-]?\s*)?\(?([A-Fa-f])\)?(?:\s+|$)/i.exec(rest);
      if (lead) {
        current.token = lead[1] ?? null;
        rest = rest.slice(lead[0].length);
      }
      current.solution = rest;
      continue;
    }
    if (!current) continue;
    const ans = /^(?:ans(?:wer)?|correct\s+(?:option|answer))\s*\.?\s*[:\-–]?\s*(.+)$/i.exec(line);
    if (ans && !current.token) {
      current.token = answerTokens(ans[1] ?? "")[0] ?? null;
      continue;
    }
    current.solution = append(
      current.solution,
      line.replace(/^(?:sol(?:ution)?|explanation)\s*[:.\-–]?\s*/i, ""),
    );
  }
  return entries;
}

const hasDuplicates = (numbers: (number | null)[]) => new Set(numbers).size !== numbers.length;

/**
 * Applies key entries to questions. Matches by printed number, or by paper order when numbering
 * restarts (per section) in the paper or the key. Key answers replace answers found in the paper.
 */
export function applyKey(
  questions: RawQuestion[],
  entries: KeyEntry[],
  source: "key" | "document" = "key",
) {
  const byOrder =
    hasDuplicates(questions.map((q) => q.number)) || hasDuplicates(entries.map((e) => e.number));
  const byNumber = new Map(entries.map((e) => [e.number, e]));
  let answered = 0;
  let solutions = 0;
  questions.forEach((q, i) => {
    const entry = byOrder ? entries[i] : q.number === null ? undefined : byNumber.get(q.number);
    if (!entry) return;
    if (entry.token && applyAnswerTokens(q, answerTokens(entry.token))) {
      q.answerSource = source;
      answered++;
    }
    if (entry.solution && !q.solution) {
      q.solution = entry.solution;
      solutions++;
    }
  });
  return { answered, solutions, matchedBy: byOrder ? ("order" as const) : ("number" as const) };
}

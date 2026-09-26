import { emptyQuestion, type RawQuestion } from "./types.js";
import { append, collapse, isHindi, mentionsFigure, norm, optionIndex } from "./text.js";

/*
 * Free text parser: turns the text layer of a question paper into questions, without AI.
 * Handles "1." / "Q.1" / "Q1)" / "Question 1" numbering, (a)/a)/A./(1) option styles (several
 * per line too), "Ans:" lines, "Solution:" blocks, "Directions (1-5)" passages, section
 * headings and Hindi (Devanagari) lines.
 */

export const QUESTION_RE =
  /^(?:q(?:uestion)?\s*\.?\s*(\d{1,3})\s*[.):-]?\s*|(\d{1,3})[.)](?:\s+|$))(.*)$/i;
const ANSWER_RE = /^(?:ans(?:wer)?|correct\s+(?:option|answer))\s*\.?\s*[:\-–]?\s*(.+)$/i;
const SOLUTION_RE =
  /^(?:sol(?:ution)?|explanation|expl?)\s*\.?\s*[:\-–]?\s+(.*)$|^(?:solution|explanation)\s*[:\-–]?\s*$/i;
const DIRECTIONS_RE =
  /^directions?\s*(?:\(|for\s+)?\s*(?:q(?:uestions?|s|\.)?\s*(?:nos?\.?)?\s*)?(\d{1,3})\s*(?:-|–|to|&|and)\s*(\d{1,3})\s*\)?\s*[:.\-–]?\s*(.*)$/i;
/** An option marker: "(a)", "(1)", or "a)" / "A." preceded by start-of-line or a space. */
const MARKER_RE = /(^|\s)(?:\(([A-Fa-f]|[1-6])\)|([A-Fa-f])[.)])(?=\s)/g;

const looksLikeContent = (line: string) =>
  QUESTION_RE.test(line) ||
  ANSWER_RE.test(line) ||
  DIRECTIONS_RE.test(line) ||
  /^(?:\(([A-Fa-f]|[1-6])\)|([A-Fa-f])[.)])\s/.test(line);

/**
 * Removes running headers/footers. Only the first/last 3 lines of each page are candidates, only
 * when repeated on >= 60% of pages (digits ignored, so "Page 2 of 4" matches), and never lines that
 * look like questions or options: a naive filter would delete a repeated option like "(a) 56".
 */
export function stripHeadersFooters(pages: string[][]): string[][] {
  if (pages.length < 2) return pages;
  const key = (line: string) => line.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const edge = (lines: string[]) => new Set([...lines.slice(0, 3), ...lines.slice(-3)].map(key));
  const counts = new Map<string, number>();
  for (const page of pages) for (const k of edge(page)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const threshold = Math.ceil(pages.length * 0.6);

  return pages.map((lines) =>
    lines.filter((line, i) => {
      const atEdge = i < 3 || i >= lines.length - 3;
      if (!atEdge || looksLikeContent(line)) return true;
      return (counts.get(key(line)) ?? 0) < threshold;
    }),
  );
}

/** Splits "(a) 12 (b) 15" into options, if the markers start the line and run in order from `expected`. */
export function parseOptionLine(
  line: string,
  expected: number,
): { index: number; text: string }[] | null {
  const markers = [...line.matchAll(MARKER_RE)].map((m) => ({
    index: optionIndex((m[2] ?? m[3]) as string),
    start: (m.index ?? 0) + (m[1]?.length ?? 0),
    end: (m.index ?? 0) + m[0].length,
  }));
  if (markers.length === 0 || markers[0]?.start !== 0) return null;
  if (markers.some((m, i) => m.index !== expected + i)) return null;
  return markers.map((m, i) => ({
    index: m.index,
    text: collapse(line.slice(m.end, markers[i + 1]?.start ?? line.length)),
  }));
}

/** "B", "(c)", "2", "12.5", "a, c", "12.4 to 12.6" → tokens. */
export function answerTokens(text: string): string[] {
  const range = text.match(
    /^\(?\s*(-?\d+(?:\.\d+)?)\s*(?:to|–|-)\s*(-?\d+(?:\.\d+)?)\s*\)?\s*\.?$/i,
  );
  if (range) return [`${range[1]}..${range[2]}`];
  return text
    .replace(/[()[\]]/g, " ")
    .split(/[\s,;&/]+|\band\b/i)
    .map((t) => t.replace(/\.$/, "").trim())
    .filter((t) => /^([A-Fa-f]|-?\d+(?:\.\d+)?)$/.test(t));
}

/**
 * Resolves answer tokens against a question: letters → option index, a digit → 1-based option
 * (when the question has options) or a numeric value (when it has none).
 */
export function applyAnswerTokens(q: RawQuestion, tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  if (q.options.length > 0) {
    const indices = tokens.map((t) => optionIndex(t)).filter((i) => i >= 0 && i < q.options.length);
    if (indices.length !== tokens.length) return false;
    q.correct = [...new Set(indices)].sort((a, b) => a - b);
    q.numAnswer = null;
    return true;
  }
  const token = tokens[0] as string;
  const [lo, hi] = token.includes("..")
    ? token.split("..").map(Number)
    : [Number(token), Number(token)];
  if (lo === undefined || hi === undefined || Number.isNaN(lo) || Number.isNaN(hi)) return false;
  q.numAnswer = { min: Math.min(lo, hi), max: Math.max(lo, hi) };
  q.correct = [];
  return true;
}

function isHeading(line: string, sectionNames: string[]): boolean {
  if (looksLikeContent(line) || line.length > 90 || /\?\s*$/.test(line)) return false;
  const n = norm(line);
  if (
    sectionNames.some(
      (name) => name && (n === name || (n.includes(name) && n.length <= name.length + 25)),
    )
  )
    return true;
  if (/^(section|part)\b/i.test(line)) return true;
  const letters = line.match(/\p{L}/gu) ?? [];
  const upper = line.match(/\p{Lu}/gu) ?? [];
  return (
    letters.length >= 4 && upper.length / letters.length >= 0.9 && line.split(/\s+/).length <= 10
  );
}

/** Final type and bookkeeping for a question once all its lines are read. */
function finish(q: RawQuestion): RawQuestion {
  q.stem = collapse(q.stem);
  q.stemHi = collapse(q.stemHi);
  q.solution = collapse(q.solution);
  if (q.options.length === 0) {
    q.type = q.numAnswer && !Number.isInteger(q.numAnswer.min) ? "numeric" : "integer";
  } else {
    q.type = q.correct.length > 1 ? "mcq_multi" : "mcq_single";
  }
  q.hasFigure = mentionsFigure(`${q.passage} ${q.stem}`);
  q.answerSource = q.correct.length > 0 || q.numAnswer ? "document" : "none";
  // Text extraction reads the layer exactly; lower confidence only when the shape looks wrong.
  q.confidence =
    !q.stem && !q.stemHi ? 0.3 : q.type.startsWith("mcq") && q.options.length < 2 ? 0.5 : 0.95;
  return q;
}

export interface TextParseOptions {
  /** Template section names and aliases, to recognise section headings. */
  sectionNames?: string[];
}

/** Parses per-page text (lines split by "\n") into questions in paper order. */
export function parseQuestionPaper(
  pageTexts: string[],
  options: TextParseOptions = {},
): RawQuestion[] {
  const sectionNames = (options.sectionNames ?? []).map(norm).filter(Boolean);
  const pages = stripHeadersFooters(
    pageTexts.map((t) => t.split("\n").map(collapse).filter(Boolean)),
  );

  const questions: RawQuestion[] = [];
  let current: RawQuestion | null = null;
  let mode: "none" | "passage" | "stem" | "options" | "hindiOptions" | "solution" = "none";
  let section: string | null = null;
  let passage: { text: string; textHi: string; from: number; to: number } | null = null;
  let lastNumber: number | null = null;

  const complete = (q: RawQuestion | null) =>
    !q || q.options.length > 0 || q.correct.length > 0 || q.numAnswer !== null;
  const close = () => {
    if (current) questions.push(finish(current));
    current = null;
  };

  pages.forEach((lines, pageIndex) => {
    for (const line of lines) {
      const directions = DIRECTIONS_RE.exec(line);
      if (directions) {
        close();
        passage = {
          text: directions[3] ?? "",
          textHi: "",
          from: Number(directions[1]),
          to: Number(directions[2]),
        };
        mode = "passage";
        continue;
      }

      const q = QUESTION_RE.exec(line);
      if (q) {
        const number = Number(q[1] ?? q[2]);
        const ok =
          lastNumber === null ||
          number === lastNumber + 1 ||
          (complete(current) &&
            (number === 1 || (number > lastNumber && number <= lastNumber + 3)));
        if (ok) {
          close();
          const next: RawQuestion = { ...emptyQuestion(), number, section, page: pageIndex + 1 };
          const rest = q[3] ?? "";
          if (isHindi(rest)) next.stemHi = rest;
          else next.stem = rest;
          const p = passage;
          if (p && number >= p.from && number <= p.to) {
            next.passage = collapse(p.text);
            next.passageHi = collapse(p.textHi);
          }
          if (p && number >= p.to) passage = null;
          current = next;
          lastNumber = number;
          mode = "stem";
          continue;
        }
      }

      if (current) {
        const cur: RawQuestion = current;
        // English options continue from where they are; a Hindi option run restarts at (a).
        const opts = parseOptionLine(
          line,
          mode === "hindiOptions" ? cur.optionsHi.length : cur.options.length,
        );
        const hindiRun = !opts && cur.options.length > 0 ? parseOptionLine(line, 0) : null;
        if (
          opts &&
          mode !== "hindiOptions" &&
          !opts.every((o) => isHindi(o.text) && cur.options.length > 0)
        ) {
          for (const o of opts) cur.options[o.index] = o.text;
          mode = "options";
          continue;
        }
        const hindiOpts =
          mode === "hindiOptions"
            ? opts
            : (hindiRun ?? (opts?.every((o) => isHindi(o.text)) ? parseOptionLine(line, 0) : null));
        if (hindiOpts?.every((o) => isHindi(o.text))) {
          for (const o of hindiOpts) cur.optionsHi[o.index] = o.text;
          mode = "hindiOptions";
          continue;
        }

        const ans = ANSWER_RE.exec(line);
        if (ans && applyAnswerTokens(cur, answerTokens(ans[1] ?? ""))) {
          mode = "none";
          continue;
        }

        const sol = SOLUTION_RE.exec(line);
        if (sol) {
          const text = sol[1] ?? "";
          if (isHindi(text)) cur.solutionHi = append(cur.solutionHi, text);
          else cur.solution = append(cur.solution, text);
          mode = "solution";
          continue;
        }
      }

      if (isHeading(line, sectionNames) && complete(current)) {
        close();
        section = line;
        passage = null;
        mode = "none";
        continue;
      }

      // Continuation of whatever we are in.
      const hindi = isHindi(line);
      const cur = current;
      const p = passage as { text: string; textHi: string } | null;
      if (mode === "passage" && p) {
        if (hindi) p.textHi = append(p.textHi, line);
        else p.text = append(p.text, line);
      } else if (cur && mode === "stem") {
        if (hindi) cur.stemHi = append(cur.stemHi, line);
        else cur.stem = append(cur.stem, line);
      } else if (cur && mode === "options" && cur.options.length) {
        cur.options[cur.options.length - 1] = append(
          cur.options[cur.options.length - 1] ?? "",
          line,
        );
      } else if (cur && mode === "hindiOptions" && cur.optionsHi.length) {
        cur.optionsHi[cur.optionsHi.length - 1] = append(
          cur.optionsHi[cur.optionsHi.length - 1] ?? "",
          line,
        );
      } else if (cur && mode === "solution") {
        if (hindi) cur.solutionHi = append(cur.solutionHi, line);
        else cur.solution = append(cur.solution, line);
      }
      // mode "none" with no question: instructions / preamble; ignored.
    }
  });
  close();
  return questions;
}

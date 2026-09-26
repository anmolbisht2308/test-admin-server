import {
  hasAnswer,
  isNumericType,
  type AnswerSource,
  type QuestionType,
  type ValidationFlag,
} from "@mockprep/types";

export interface FlaggableQuestion {
  type: QuestionType;
  stem: string;
  stemHi: string;
  passage: string;
  options: string[];
  correct: number[];
  numAnswer: { min: number; max: number } | null;
  answerSource: AnswerSource;
  hasFigure: boolean;
  figureUrl: string | null;
  confidence: number;
  solution: string;
}

/** Flags about a question's own content (duplicate flags need the bank; see DUPLICATE_FLAGS). */
export function contentFlags(q: FlaggableQuestion, optionCount: number): ValidationFlag[] {
  const flags: ValidationFlag[] = [];
  if (!q.stem.trim() && !q.stemHi.trim()) flags.push("empty_stem");
  if (!isNumericType(q.type) && q.options.length !== optionCount) flags.push("option_count");
  if (!hasAnswer(q)) flags.push("no_answer");
  else if (q.answerSource === "ai") flags.push("ai_answer");
  if (q.hasFigure && !q.figureUrl) flags.push("needs_figure");
  if (q.confidence < 0.7) flags.push("low_confidence");
  // An odd number of unescaped `$` means a formula lost its closing delimiter.
  const dollars = [q.passage, q.stem, q.stemHi, q.solution, ...q.options]
    .map((t) => (t.match(/(?<!\\)\$/g) ?? []).length)
    .reduce((a, b) => a + b, 0);
  if (dollars % 2 === 1) flags.push("latex");
  return flags;
}

export const DUPLICATE_FLAGS: readonly ValidationFlag[] = ["duplicate", "duplicate_in_paper"];

/** Flags an edit doesn't recompute (bank lookups, student reports, stats): kept as they are. */
export const STICKY_FLAGS: readonly ValidationFlag[] = [
  ...DUPLICATE_FLAGS,
  "reported",
  "suspect_key",
];

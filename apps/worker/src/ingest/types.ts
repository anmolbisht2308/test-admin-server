import type { Difficulty, QuestionType } from "@mockprep/types";

/** A question as an extractor found it, before answer keys, flags and sections are applied. */
export interface RawQuestion {
  /** Number as printed (null when the extractor could not tell). */
  number: number | null;
  /** Section heading/name as found in the paper (matched to the template later). */
  section: string | null;
  /** 1-based page in the uploaded PDF. */
  page: number | null;
  type: QuestionType;
  passage: string;
  passageHi: string;
  stem: string;
  stemHi: string;
  options: string[];
  optionsHi: string[];
  /** 0-based option indices (MCQ) … */
  correct: number[];
  /** … or the accepted range for integer/numeric questions. */
  numAnswer: { min: number; max: number } | null;
  answerSource: "document" | "key" | "ai" | "none";
  solution: string;
  solutionHi: string;
  topic: string;
  difficulty: Difficulty;
  hasFigure: boolean;
  /** 0–1: how sure the extractor is that it read the question completely. */
  confidence: number;
}

/** One answer from an answer key or solutions file. `token` is the raw answer text. */
export interface KeyEntry {
  number: number;
  /** As printed: option letter(s) A–F, a 1-based option digit, a numeric value or range. */
  token: string | null;
  solution: string;
}

export const emptyQuestion = (): RawQuestion => ({
  number: null,
  section: null,
  page: null,
  type: "mcq_single",
  passage: "",
  passageHi: "",
  stem: "",
  stemHi: "",
  options: [],
  optionsHi: [],
  correct: [],
  numAnswer: null,
  answerSource: "none",
  solution: "",
  solutionHi: "",
  topic: "",
  difficulty: "medium",
  hasFigure: false,
  confidence: 1,
});

/** Reports progress to the upload document (log lines are shown to the admin). */
export interface IngestReporter {
  log(message: string, level?: "info" | "warn" | "error"): Promise<void>;
}

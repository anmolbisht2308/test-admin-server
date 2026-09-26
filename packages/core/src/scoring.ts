import {
  EVALUATED_STATES,
  isNumericType,
  type AttemptResponse,
  type AttemptResult,
  type Marking,
  type QuestionState,
  type QuestionType,
  type TemplateSnapshot,
} from "@mockprep/types";

/** What scoring needs from a question (the answer key, never sent to students before submit). */
export interface ScoringQuestion {
  id: string;
  type: QuestionType;
  correct: number[];
  numAnswer: { min: number; max: number } | null;
}

export interface ScoringAnswer {
  response: AttemptResponse;
  state: QuestionState;
  timeMs: number;
}

export type QuestionOutcome = "correct" | "wrong" | "partial" | "skipped";

export interface QuestionScore {
  questionId: string;
  outcome: QuestionOutcome;
  marks: number;
  timeMs: number;
}

type Template = Pick<
  TemplateSnapshot,
  "marking" | "markingByType" | "multiPartial" | "qualifyingPercent"
>;

const round2 = (n: number) => Math.round(n * 100) / 100;

export const markingFor = (template: Template, type: QuestionType): Marking =>
  template.markingByType?.[type] ?? template.marking;

/** Parses a keypad value ("12", "-2.5", ".5"); null when it is not a number. */
export function parseNumeric(value: string): number | null {
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Scores one question. Only "answered" / "answered_marked" responses are evaluated. */
export function scoreQuestion(
  q: ScoringQuestion,
  answer: ScoringAnswer | undefined,
  template: Template,
): QuestionScore {
  const timeMs = answer?.timeMs ?? 0;
  const skipped: QuestionScore = { questionId: q.id, outcome: "skipped", marks: 0, timeMs };
  if (!answer || !EVALUATED_STATES.includes(answer.state) || answer.response === null)
    return skipped;
  const m = markingFor(template, q.type);
  const right = { questionId: q.id, outcome: "correct" as const, marks: m.correct, timeMs };
  const wrong = { questionId: q.id, outcome: "wrong" as const, marks: m.wrong, timeMs };

  if (isNumericType(q.type)) {
    if (typeof answer.response !== "string") return skipped;
    const value = parseNumeric(answer.response);
    if (value === null) return skipped;
    if (!q.numAnswer) return wrong;
    // Tolerance for float noise ("0.30000000000000004").
    const eps = 1e-9;
    return value >= q.numAnswer.min - eps && value <= q.numAnswer.max + eps ? right : wrong;
  }

  if (!Array.isArray(answer.response) || answer.response.length === 0) return skipped;
  const chosen = [...new Set(answer.response)].sort((a, b) => a - b);
  const key = [...new Set(q.correct)].sort((a, b) => a - b);
  if (key.length === 0) return wrong;
  const exact = chosen.length === key.length && chosen.every((c, i) => c === key[i]);
  if (exact) return right;
  if (q.type === "mcq_single") return wrong;
  // mcq_multi: exact only, unless the template gives partial credit.
  const anyWrong = chosen.some((c) => !key.includes(c));
  if (!template.multiPartial || anyWrong) return wrong;
  return {
    questionId: q.id,
    outcome: "partial",
    marks: round2((m.correct * chosen.length) / key.length),
    timeMs,
  };
}

export interface ScoredAttempt {
  result: AttemptResult;
  questions: QuestionScore[];
}

/** Scores a whole attempt: per question, per section and in total. */
export function scoreAttempt(
  sections: { name: string; questions: ScoringQuestion[] }[],
  answers: Map<string, ScoringAnswer>,
  template: Template,
  timeTakenSec: number,
): ScoredAttempt {
  const questions: QuestionScore[] = [];
  const sectionResults = sections.map((s) => {
    const scored = s.questions.map((q) => scoreQuestion(q, answers.get(q.id), template));
    questions.push(...scored);
    const count = (o: QuestionOutcome) => scored.filter((x) => x.outcome === o).length;
    return {
      name: s.name,
      score: round2(scored.reduce((a, x) => a + x.marks, 0)),
      maxScore: round2(s.questions.reduce((a, q) => a + markingFor(template, q.type).correct, 0)),
      correct: count("correct"),
      wrong: count("wrong"),
      partial: count("partial"),
      skipped: count("skipped"),
      timeMs: scored.reduce((a, x) => a + x.timeMs, 0),
    };
  });
  const sum = (f: (s: (typeof sectionResults)[number]) => number) =>
    sectionResults.reduce((a, s) => a + f(s), 0);
  const score = round2(sum((s) => s.score));
  const maxScore = round2(sum((s) => s.maxScore));
  const correct = sum((s) => s.correct);
  const wrong = sum((s) => s.wrong);
  const partial = sum((s) => s.partial);
  const attempted = correct + wrong + partial;
  const qualifying =
    template.qualifyingPercent === undefined
      ? null
      : {
          percent: template.qualifyingPercent,
          passed: maxScore > 0 && (score / maxScore) * 100 >= template.qualifyingPercent,
        };
  return {
    questions,
    result: {
      score,
      maxScore,
      correct,
      wrong,
      partial,
      skipped: sum((s) => s.skipped),
      accuracy: attempted ? round2((correct / attempted) * 100) : 0,
      timeTakenSec: Math.max(0, Math.round(timeTakenSec)),
      qualifying,
      sections: sectionResults,
    },
  };
}

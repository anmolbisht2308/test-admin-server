import { describe, expect, it } from "vitest";
import {
  parseNumeric,
  scoreAttempt,
  scoreQuestion,
  type ScoringAnswer,
  type ScoringQuestion,
} from "../src/scoring.js";

const sbi = { marking: { correct: 1, wrong: -0.25 } };
const jee = {
  marking: { correct: 4, wrong: -1 },
  markingByType: { integer: { correct: 4, wrong: 0 } },
};
const jeeAdv = { marking: { correct: 4, wrong: -2 }, multiPartial: true };

const single: ScoringQuestion = { id: "q1", type: "mcq_single", correct: [2], numAnswer: null };
const multi: ScoringQuestion = { id: "q2", type: "mcq_multi", correct: [0, 2, 3], numAnswer: null };
const integer: ScoringQuestion = {
  id: "q3",
  type: "integer",
  correct: [],
  numAnswer: { min: 9, max: 9 },
};
const numeric: ScoringQuestion = {
  id: "q4",
  type: "numeric",
  correct: [],
  numAnswer: { min: 2.45, max: 2.55 },
};

const ans = (response: ScoringAnswer["response"], state: ScoringAnswer["state"] = "answered") => ({
  response,
  state,
  timeMs: 1000,
});

describe("scoreQuestion", () => {
  it("single-correct MCQ: exact match, negative marking for wrong", () => {
    expect(scoreQuestion(single, ans([2]), sbi)).toMatchObject({ outcome: "correct", marks: 1 });
    expect(scoreQuestion(single, ans([1]), sbi)).toMatchObject({ outcome: "wrong", marks: -0.25 });
    expect(scoreQuestion(single, ans([]), sbi)).toMatchObject({ outcome: "skipped", marks: 0 });
    expect(scoreQuestion(single, undefined, sbi)).toMatchObject({ outcome: "skipped", marks: 0 });
  });

  it("only saved answers count: marked-without-answer and not_answered are skipped", () => {
    expect(scoreQuestion(single, ans([2], "answered_marked"), sbi).outcome).toBe("correct");
    expect(scoreQuestion(single, ans([2], "marked"), sbi).outcome).toBe("skipped");
    expect(scoreQuestion(single, ans([2], "not_answered"), sbi).outcome).toBe("skipped");
    expect(scoreQuestion(single, ans(null), sbi).outcome).toBe("skipped");
  });

  it("multi-correct MCQ: exact only by default", () => {
    expect(scoreQuestion(multi, ans([3, 0, 2]), jee)).toMatchObject({
      outcome: "correct",
      marks: 4,
    });
    expect(scoreQuestion(multi, ans([0, 2]), jee)).toMatchObject({ outcome: "wrong", marks: -1 });
  });

  it("multi-correct MCQ with partial marking", () => {
    expect(scoreQuestion(multi, ans([0, 2, 3]), jeeAdv)).toMatchObject({
      outcome: "correct",
      marks: 4,
    });
    expect(scoreQuestion(multi, ans([0, 2]), jeeAdv)).toMatchObject({
      outcome: "partial",
      marks: 2.67,
    });
    expect(scoreQuestion(multi, ans([3]), jeeAdv)).toMatchObject({
      outcome: "partial",
      marks: 1.33,
    });
    // Any wrong option chosen → wrong marks.
    expect(scoreQuestion(multi, ans([0, 1]), jeeAdv)).toMatchObject({
      outcome: "wrong",
      marks: -2,
    });
  });

  it("integer: exact value, per-type marking (no negative)", () => {
    expect(scoreQuestion(integer, ans("9"), jee)).toMatchObject({ outcome: "correct", marks: 4 });
    expect(scoreQuestion(integer, ans("09"), jee)).toMatchObject({ outcome: "correct" });
    expect(scoreQuestion(integer, ans("8"), jee)).toMatchObject({ outcome: "wrong", marks: 0 });
  });

  it("numeric: inside the [min, max] range, incomplete keypad input is skipped", () => {
    expect(scoreQuestion(numeric, ans("2.5"), jee)).toMatchObject({ outcome: "correct", marks: 4 });
    expect(scoreQuestion(numeric, ans("2.45"), jee).outcome).toBe("correct");
    expect(scoreQuestion(numeric, ans("2.56"), jee)).toMatchObject({ outcome: "wrong", marks: -1 });
    expect(scoreQuestion(numeric, ans("-"), jee).outcome).toBe("skipped");
    expect(scoreQuestion(numeric, ans(""), jee).outcome).toBe("skipped");
  });

  it("parses keypad values", () => {
    expect([
      parseNumeric("-2.5"),
      parseNumeric(".5"),
      parseNumeric("3."),
      parseNumeric("-"),
    ]).toEqual([-2.5, 0.5, 3, null]);
  });
});

describe("scoreAttempt", () => {
  it("adds up sections, accuracy and the qualifying mark", () => {
    const sections = [
      { name: "A", questions: [single, { ...single, id: "q5" }, { ...single, id: "q6" }] },
      { name: "B", questions: [{ ...single, id: "q7" }] },
    ];
    const answers = new Map([
      ["q1", ans([2])],
      ["q5", ans([0])],
      ["q7", ans([2])],
    ]);
    const { result, questions } = scoreAttempt(
      sections,
      answers,
      { ...sbi, qualifyingPercent: 33 },
      1234.4,
    );
    expect(result).toMatchObject({
      score: 1.75,
      maxScore: 4,
      correct: 2,
      wrong: 1,
      skipped: 1,
      accuracy: 66.67,
      timeTakenSec: 1234,
      qualifying: { percent: 33, passed: true },
    });
    expect(result.sections).toEqual([
      {
        name: "A",
        score: 0.75,
        maxScore: 3,
        correct: 1,
        wrong: 1,
        partial: 0,
        skipped: 1,
        timeMs: 2000,
      },
      {
        name: "B",
        score: 1,
        maxScore: 1,
        correct: 1,
        wrong: 0,
        partial: 0,
        skipped: 0,
        timeMs: 1000,
      },
    ]);
    expect(questions).toHaveLength(4);
  });
});

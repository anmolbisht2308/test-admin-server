import { describe, expect, it } from "vitest";
import {
  hasAnswer,
  normaliseForHash,
  questionInputSchema,
  selectionRuleSchema,
  studentQuestionSchema,
  type QuestionInput,
} from "../src/index.js";

const mcq: QuestionInput = {
  examKey: "sbi-po",
  section: "Quantitative Aptitude",
  type: "mcq_single",
  stem: "If $x + 2 = 5$, what is $x$?",
  options: ["1", "2", "3", "4", "5"],
  correct: [2],
  status: "approved",
};

const issues = (input: unknown) => {
  const r = questionInputSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("questionInputSchema", () => {
  it("accepts a complete approved MCQ and fills defaults", () => {
    const q = questionInputSchema.parse(mcq);
    expect(q).toMatchObject({
      difficulty: "medium",
      answerSource: "manual",
      passage: "",
      numAnswer: null,
      confidence: 1,
    });
    expect(hasAnswer(q)).toBe(true);
  });

  it("lets drafts be incomplete but not structurally wrong", () => {
    expect(issues({ ...mcq, status: "draft", stem: "", correct: [] })).toEqual([]);
    expect(issues({ ...mcq, status: "draft", correct: [7] })).toContain(
      "correct.0: Too big: expected number to be <=5",
    );
    expect(issues({ ...mcq, status: "draft", options: ["a", "b"], correct: [3] })).toContain(
      "correct.0: option D does not exist",
    );
  });

  it("requires text, options and an answer when approved", () => {
    expect(issues({ ...mcq, stem: "" })).toContain("stem: approved questions need a question text");
    expect(issues({ ...mcq, correct: [] })).toContain("correct: approved questions need an answer");
    expect(issues({ ...mcq, options: ["only one"], correct: [0] })).toContain(
      "options: add at least 2 options",
    );
    expect(issues({ ...mcq, options: ["a", " "], correct: [0] })).toContain(
      "options.1: option text is empty",
    );
    expect(issues({ ...mcq, hasFigure: true })).toContain(
      "figureUrl: upload the figure or untick “has figure”",
    );
  });

  it("allows Hindi-only stems and checks Hindi options line up", () => {
    expect(issues({ ...mcq, stem: "", stemHi: "यदि $x + 2 = 5$ है, तो $x$ क्या है?" })).toEqual([]);
    expect(issues({ ...mcq, optionsHi: ["१", "२"] })).toContain(
      "optionsHi: Hindi options must match the English options one-to-one",
    );
  });

  it("enforces single vs multi answers", () => {
    expect(issues({ ...mcq, correct: [0, 1] })).toContain(
      "correct: single-answer questions have one correct option",
    );
    expect(issues({ ...mcq, type: "mcq_multi", correct: [0, 1] })).toEqual([]);
    expect(issues({ ...mcq, type: "mcq_multi", correct: [1, 1] })).toContain(
      "correct: duplicate answer",
    );
  });

  it("validates numeric answers", () => {
    const numeric = {
      ...mcq,
      type: "numeric",
      options: [],
      correct: [],
      numAnswer: { min: 2.5, max: 2.6 },
    };
    expect(issues(numeric)).toEqual([]);
    expect(issues({ ...numeric, numAnswer: { min: 3, max: 2 } })).toContain(
      "numAnswer.max: max must be ≥ min",
    );
    expect(issues({ ...numeric, type: "integer" })).toContain(
      "numAnswer.min: integer answers must be whole numbers",
    );
    expect(issues({ ...numeric, options: ["1"] })).toContain(
      "options: numeric questions have no options",
    );
    expect(issues({ ...numeric, numAnswer: null })).toContain(
      "numAnswer: approved questions need an answer",
    );
    expect(issues({ ...mcq, numAnswer: { min: 1, max: 1 } })).toContain(
      "numAnswer: only integer/numeric questions have a numeric answer",
    );
  });

  it("only accepts uploaded or https figure URLs", () => {
    expect(issues({ ...mcq, hasFigure: true, figureUrl: "/api/files/figures/a.png" })).toEqual([]);
    expect(issues({ ...mcq, figureUrl: "javascript:alert(1)" }).join()).toMatch(
      /uploaded file or an https URL/,
    );
  });
});

describe("normaliseForHash", () => {
  it("ignores case, spacing and option order", () => {
    expect(normaliseForHash("What  is\n2+2?", ["4", "3"])).toBe(
      normaliseForHash("what is 2+2?", ["3", " 4 "]),
    );
    expect(normaliseForHash("What is 2+2?", ["4"])).not.toBe(
      normaliseForHash("What is 2+3?", ["4"]),
    );
  });
});

describe("selectionRuleSchema", () => {
  it("defaults and rejects an all-zero difficulty mix", () => {
    expect(selectionRuleSchema.parse({ count: 35 })).toMatchObject({
      topics: [],
      notUsedInLastDays: 0,
      mode: "replace",
    });
    expect(
      selectionRuleSchema.safeParse({ count: 5, difficultyMix: { easy: 0, medium: 0, hard: 0 } })
        .success,
    ).toBe(false);
  });
});

describe("studentQuestionSchema", () => {
  it("rejects any answer field (strict)", () => {
    const base = {
      id: "64b000000000000000000001",
      type: "mcq_single",
      number: 1,
      passage: "",
      passageHi: "",
      stem: "s",
      stemHi: "",
      options: ["a"],
      optionsHi: [],
      hasFigure: false,
      figureUrl: null,
    };
    expect(studentQuestionSchema.safeParse(base).success).toBe(true);
    expect(studentQuestionSchema.safeParse({ ...base, correct: [0] }).success).toBe(false);
  });
});

import { contentFlags } from "@mockprep/core";
import { describe, expect, it } from "vitest";
import { assignSections, matchSection, missingNumbers } from "../src/ingest/sections.js";

const SBI = [
  { name: "English Language", count: 3, aliases: ["English"] },
  { name: "Quantitative Aptitude", count: 2, aliases: ["Quant", "Numerical Ability"] },
  { name: "Reasoning Ability", count: 2, aliases: ["Reasoning"] },
];

describe("section assignment", () => {
  it("matches headings against names and aliases", () => {
    expect(matchSection("ENGLISH LANGUAGE", SBI)).toBe("English Language");
    expect(matchSection("PART B: NUMERICAL ABILITY", SBI)).toBe("Quantitative Aptitude");
    expect(matchSection("Section - Reasoning", SBI)).toBe("Reasoning Ability");
    expect(matchSection("General Awareness", SBI)).toBeNull();
    expect(matchSection(null, SBI)).toBeNull();
  });

  it("uses headings when every question matches", () => {
    const qs = ["ENGLISH", "ENGLISH", "QUANT", "REASONING"].map((section) => ({ section }));
    expect(assignSections(qs, SBI)).toEqual({
      method: "headings",
      sections: [
        "English Language",
        "English Language",
        "Quantitative Aptitude",
        "Reasoning Ability",
      ],
    });
  });

  it("falls back to template order and counts when any heading is unknown", () => {
    const qs = [null, "ENGLISH", "X", null, null, null, null, null].map((section) => ({ section }));
    expect(assignSections(qs, SBI)).toEqual({
      method: "order",
      sections: [
        "English Language",
        "English Language",
        "English Language",
        "Quantitative Aptitude",
        "Quantitative Aptitude",
        "Reasoning Ability",
        "Reasoning Ability",
        // More questions than the template: the rest go to the last section.
        "Reasoning Ability",
      ],
    });
  });

  it("finds missing numbers, also when numbering restarts per section", () => {
    expect(missingNumbers([1, 2, 4, 5, 8])).toEqual([3, 6, 7]);
    expect(missingNumbers([1, 2, 3, 1, 3, 1, 2])).toEqual([2]);
    expect(missingNumbers([2, 3])).toEqual([1]);
  });
});

const base = {
  type: "mcq_single" as const,
  stem: "What is 2 + 2?",
  stemHi: "",
  passage: "",
  options: ["1", "2", "3", "4", "5"],
  correct: [3],
  numAnswer: null,
  answerSource: "key" as const,
  hasFigure: false,
  figureUrl: null,
  confidence: 0.95,
  solution: "",
};

describe("validation flags", () => {
  it("a complete question has none", () => {
    expect(contentFlags(base, 5)).toEqual([]);
  });

  it("flags each problem", () => {
    expect(contentFlags({ ...base, stem: " " }, 5)).toEqual(["empty_stem"]);
    expect(contentFlags({ ...base, options: ["1", "2", "3", "4"] }, 5)).toEqual(["option_count"]);
    expect(contentFlags({ ...base, correct: [] }, 5)).toEqual(["no_answer"]);
    expect(contentFlags({ ...base, answerSource: "ai" }, 5)).toEqual(["ai_answer"]);
    expect(contentFlags({ ...base, hasFigure: true }, 5)).toEqual(["needs_figure"]);
    expect(contentFlags({ ...base, hasFigure: true, figureUrl: "/api/files/x.png" }, 5)).toEqual(
      [],
    );
    expect(contentFlags({ ...base, confidence: 0.69 }, 5)).toEqual(["low_confidence"]);
    expect(contentFlags({ ...base, stem: "Find $x^2 when x = 3" }, 5)).toEqual(["latex"]);
    expect(contentFlags({ ...base, stem: "Cost is \\$5 and $x^2$" }, 5)).toEqual([]);
  });

  it("numeric questions need a value, not options", () => {
    const numeric = { ...base, type: "integer" as const, options: [], correct: [] };
    expect(contentFlags(numeric, 4)).toEqual(["no_answer"]);
    expect(contentFlags({ ...numeric, numAnswer: { min: 9, max: 9 } }, 4)).toEqual([]);
  });
});

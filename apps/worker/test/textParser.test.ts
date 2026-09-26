import { describe, expect, it } from "vitest";
import { applyKey, parseAnswerKey, parseSolutions } from "../src/ingest/keyParser.js";
import {
  answerTokens,
  parseOptionLine,
  parseQuestionPaper,
  stripHeadersFooters,
} from "../src/ingest/textParser.js";
import type { RawQuestion } from "../src/ingest/types.js";
import {
  JEE_QUESTIONS,
  SBI_QUESTIONS,
  SSC_QUESTIONS,
  SSC_SECTIONS,
  type FixtureQuestion,
} from "./fixtures/data.js";
import { fixturePages } from "./helpers.js";

function expectMatches(found: RawQuestion[], expected: FixtureQuestion[]) {
  expect(found.map((q) => q.number)).toEqual(expected.map((q) => q.number));
  expected.forEach((e, i) => {
    const q = found[i] as RawQuestion;
    expect(q.stem, `Q${i + 1} stem`).toBe(e.stem);
    expect(q.options, `Q${i + 1} options`).toEqual(e.options);
    // The passage keeps its "Directions" instruction line, which students see too.
    if (e.passage) expect(q.passage, `Q${i + 1} passage`).toContain(e.passage);
    else expect(q.passage, `Q${i + 1} passage`).toBe("");
    if (Array.isArray(e.answer)) expect(q.correct, `Q${i + 1} answer`).toEqual(e.answer);
    else expect(q.numAnswer, `Q${i + 1} answer`).toEqual(e.answer);
    expect(q.hasFigure, `Q${i + 1} figure`).toBe(e.hasFigure ?? false);
    expect(q.solution, `Q${i + 1} solution`).toBe(e.solution ?? "");
  });
}

const sectionOf = (q: RawQuestion) => q.section?.toLowerCase() ?? "";

describe("text parser on the fixture papers", () => {
  it("SBI: passage, one-per-line options, section headings, figure mention, key", async () => {
    const questions = parseQuestionPaper(await fixturePages("sbi-paper.pdf"), {
      sectionNames: ["English Language", "Quantitative Aptitude", "Reasoning Ability"],
    });
    const key = parseAnswerKey((await fixturePages("sbi-key.pdf")).join("\n"));
    expect(key).toHaveLength(12);
    const result = applyKey(questions, key);
    expect(result).toMatchObject({ answered: 12, matchedBy: "number" });
    expectMatches(questions, SBI_QUESTIONS);
    SBI_QUESTIONS.forEach((e, i) =>
      expect(sectionOf(questions[i] as RawQuestion)).toContain(e.section.toLowerCase()),
    );
    expect(questions.every((q) => q.answerSource === "key")).toBe(true);
  });

  it("SSC: strips headers and footers but keeps repeated options, mixed key formats", async () => {
    const questions = parseQuestionPaper(await fixturePages("ssc-paper.pdf"), {
      sectionNames: SSC_SECTIONS,
    });
    const key = parseAnswerKey((await fixturePages("ssc-key.pdf")).join("\n"));
    expect(key.map((k) => k.number)).toEqual(SSC_QUESTIONS.map((q) => q.number));
    applyKey(questions, key);
    expectMatches(questions, SSC_QUESTIONS);
    SSC_QUESTIONS.forEach((e, i) =>
      expect(sectionOf(questions[i] as RawQuestion)).toContain(e.section.toLowerCase()),
    );
    const all = questions.flatMap((q) => [q.stem, ...q.options]).join(" ");
    expect(all).not.toMatch(/Page \d|example-coaching|SET 12|Maximum marks/);
  });

  it("JEE: numbering restarts per subject, in-paper answers and solutions, numeric answers", async () => {
    const questions = parseQuestionPaper(await fixturePages("jee-paper.pdf"), {
      sectionNames: ["Physics", "Chemistry", "Mathematics"],
    });
    expectMatches(questions, JEE_QUESTIONS);
    expect(questions.map((q) => q.type)).toEqual([
      "mcq_single",
      "mcq_single",
      "integer",
      "mcq_single",
      "mcq_single",
      "integer",
      "mcq_single",
      "numeric",
      "mcq_single",
    ]);
    expect(questions.every((q) => q.answerSource === "document")).toBe(true);
  });
});

describe("text parser units", () => {
  it("parses option lines in several styles", () => {
    expect(parseOptionLine("(a) 12 (b) 15", 0)).toEqual([
      { index: 0, text: "12" },
      { index: 1, text: "15" },
    ]);
    expect(parseOptionLine("C. Newton D. Pascal", 2)).toEqual([
      { index: 2, text: "Newton" },
      { index: 3, text: "Pascal" },
    ]);
    expect(parseOptionLine("(3) 8", 2)).toEqual([{ index: 2, text: "8" }]);
    // Out-of-order marker: not an option line.
    expect(parseOptionLine("(c) 8", 0)).toBeNull();
    expect(parseOptionLine("The value (a) is", 0)).toBeNull();
  });

  it("reads answer tokens", () => {
    expect(answerTokens("(b)")).toEqual(["b"]);
    expect(answerTokens("A, C")).toEqual(["A", "C"]);
    expect(answerTokens("12.5")).toEqual(["12.5"]);
    expect(answerTokens("12.4 to 12.6")).toEqual(["12.4..12.6"]);
  });

  it("keeps Hindi stems and options apart from English", () => {
    const [q] = parseQuestionPaper([
      [
        "1. What is the capital of India?",
        "भारत की राजधानी क्या है?",
        "(a) Mumbai (b) Delhi (c) Kolkata (d) Chennai",
        "(a) मुंबई (b) दिल्ली (c) कोलकाता (d) चेन्नई",
        "Ans: (b)",
      ].join("\n"),
    ]);
    expect(q).toMatchObject({
      stem: "What is the capital of India?",
      stemHi: "भारत की राजधानी क्या है?",
      options: ["Mumbai", "Delhi", "Kolkata", "Chennai"],
      optionsHi: ["मुंबई", "दिल्ली", "कोलकाता", "चेन्नई"],
      correct: [1],
    });
  });

  it("does not strip repeated lines that look like options", () => {
    const pages = [1, 2, 3].map((n) => [`Header`, `${n}. Q`, `(a) 56 (b) 64`, `Page ${n}`]);
    expect(stripHeadersFooters(pages)).toEqual([1, 2, 3].map((n) => [`${n}. Q`, `(a) 56 (b) 64`]));
  });

  it("matches a key by order when numbering restarts", () => {
    const qs = parseQuestionPaper([
      "PHYSICS\n1. P one\n(a) x (b) y\n2. P two\n(a) x (b) y\nCHEMISTRY\n1. C one\n(a) x (b) y",
    ]);
    const res = applyKey(qs, parseAnswerKey("1. A 2. B 1. B"));
    expect(res.matchedBy).toBe("order");
    expect(qs.map((q) => q.correct)).toEqual([[0], [1], [1]]);
  });

  it("parses solutions files", () => {
    const entries = parseSolutions("1. (b) Because v = gt.\n2.\nAns: C\nNewton is the unit.");
    expect(entries).toEqual([
      { number: 1, token: "b", solution: "Because v = gt." },
      { number: 2, token: "C", solution: "Newton is the unit." },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  examTemplateInputSchema,
  examTemplateUpdateSchema,
  templateMaxMarks,
  templateQuestionCount,
  type ExamTemplateInput,
} from "../src/index.js";

const sbiPo: ExamTemplateInput = {
  key: "sbi-po-prelims",
  name: "SBI PO Prelims",
  family: "banking",
  skin: "ibps",
  totalTimeSec: 3600,
  optionCount: 5,
  sectionSwitching: "locked_sequential",
  sections: [
    { name: "English Language", count: 30, timeSec: 1200 },
    { name: "Quantitative Aptitude", count: 35, timeSec: 1200 },
    { name: "Reasoning Ability", count: 35, timeSec: 1200 },
  ],
  marking: { correct: 1, wrong: -0.25 },
};

const issues = (input: unknown) => {
  const result = examTemplateInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

describe("examTemplateInputSchema", () => {
  it("accepts SBI PO Prelims and defaults aliases", () => {
    const parsed = examTemplateInputSchema.parse(sbiPo);
    expect(parsed.sections[0]?.aliases).toEqual([]);
    expect(templateQuestionCount(parsed)).toBe(100);
    expect(templateMaxMarks(parsed)).toBe(100);
  });

  it("requires a time limit on every locked section", () => {
    const input = {
      ...sbiPo,
      sections: [...sbiPo.sections.slice(0, 2), { name: "Reasoning", count: 35 }],
    };
    expect(issues(input)).toContain("sections.2.timeSec: locked sections each need a time limit");
  });

  it("requires section times to add up to the total", () => {
    expect(issues({ ...sbiPo, totalTimeSec: 3000 }).join()).toMatch(/add up to 60 min/);
  });

  it("rejects duplicate section names (case-insensitive)", () => {
    const sections = [
      sbiPo.sections[0],
      { ...sbiPo.sections[1], name: "english language" },
      sbiPo.sections[2],
    ];
    expect(issues({ ...sbiPo, sections }).join()).toMatch(/unique/);
  });

  it("rejects positive negative-marking and bad option counts", () => {
    expect(issues({ ...sbiPo, marking: { correct: 1, wrong: 0.25 } }).length).toBeGreaterThan(0);
    expect(issues({ ...sbiPo, optionCount: 7 }).length).toBeGreaterThan(0);
  });

  it("allows free switching without section timers", () => {
    const ssc = {
      ...sbiPo,
      key: "ssc-cgl-tier1",
      sectionSwitching: "free",
      sections: sbiPo.sections.map(({ name, count }) => ({ name, count })),
    };
    expect(issues(ssc)).toEqual([]);
  });

  it("accepts qualifying papers and per-type marking", () => {
    expect(
      issues({
        ...sbiPo,
        qualifyingPercent: 33,
        markingByType: { numeric: { correct: 4, wrong: 0 } },
      }),
    ).toEqual([]);
  });

  it("does not allow changing the key on update", () => {
    const { key: _key, ...rest } = sbiPo;
    const parsed = examTemplateUpdateSchema.parse({ ...rest, key: "other" });
    expect("key" in parsed).toBe(false);
  });
});

describe("examUpdateSchema", () => {
  it("does not fill defaults on partial updates", async () => {
    const { examUpdateSchema } = await import("../src/index.js");
    expect(examUpdateSchema.parse({ name: "New name" })).toEqual({ name: "New name" });
  });
});

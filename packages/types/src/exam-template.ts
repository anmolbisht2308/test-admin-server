import { z } from "zod";
import { examFamilySchema, isoDateSchema, objectIdSchema, slugSchema } from "./common.js";

export const questionTypeSchema = z.enum(["mcq_single", "mcq_multi", "integer", "numeric"]);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const templateSkinSchema = z.enum(["ibps", "ssc", "upsc", "nta", "generic"]);
export type TemplateSkin = z.infer<typeof templateSkinSchema>;

export const sectionSwitchingSchema = z.enum(["free", "locked_sequential"]);
export type SectionSwitching = z.infer<typeof sectionSwitchingSchema>;

export const markingSchema = z.object({
  /** Marks for a correct answer (> 0). */
  correct: z.number().positive().max(100),
  /** Marks for a wrong answer (<= 0, e.g. -0.25). Unanswered is always 0. */
  wrong: z.number().min(-100).max(0),
});
export type Marking = z.infer<typeof markingSchema>;

export const templateSectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  count: z.number().int().positive().max(500),
  /** Section time limit; required when sections are locked_sequential. */
  timeSec: z
    .number()
    .int()
    .positive()
    .max(6 * 3600)
    .optional(),
  /** Other names this section appears under in papers (used by PDF import). */
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
});
export type TemplateSection = z.infer<typeof templateSectionSchema>;

/** Template fields without cross-field rules (used for snapshots stored on tests). */
export const examTemplateCoreSchema = z.object({
  key: slugSchema,
  name: z.string().trim().min(2).max(120),
  family: examFamilySchema,
  skin: templateSkinSchema,
  totalTimeSec: z
    .number()
    .int()
    .positive()
    .max(6 * 3600),
  optionCount: z.number().int().min(2).max(6),
  sectionSwitching: sectionSwitchingSchema,
  sections: z.array(templateSectionSchema).min(1).max(20),
  marking: markingSchema,
  /** Per-question-type overrides of `marking`. */
  markingByType: z.partialRecord(questionTypeSchema, markingSchema).optional(),
  /**
   * Multi-correct questions give partial credit: each correct option chosen earns
   * correct / (number of correct options); any wrong option chosen earns the wrong marks.
   */
  multiPartial: z.boolean().optional(),
  /** Paper is qualifying: pass mark as % of max marks (e.g. CSAT 33). */
  qualifyingPercent: z.number().min(0).max(100).optional(),
});

const templateFields = examTemplateCoreSchema;
type TemplateFields = z.infer<typeof templateFields>;

function checkTemplate(t: TemplateFields, ctx: z.RefinementCtx) {
  const names = new Set<string>();
  t.sections.forEach((section, index) => {
    const lower = section.name.toLowerCase();
    if (names.has(lower)) {
      ctx.addIssue({
        code: "custom",
        path: ["sections", index, "name"],
        message: "section names must be unique",
      });
    }
    names.add(lower);
  });

  const timed = t.sections.filter((s) => s.timeSec !== undefined);
  if (t.sectionSwitching === "locked_sequential") {
    t.sections.forEach((section, index) => {
      if (section.timeSec === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["sections", index, "timeSec"],
          message: "locked sections each need a time limit",
        });
      }
    });
  }
  if (timed.length === t.sections.length) {
    const sum = timed.reduce((acc, s) => acc + (s.timeSec ?? 0), 0);
    if (sum !== t.totalTimeSec) {
      ctx.addIssue({
        code: "custom",
        path: ["totalTimeSec"],
        message: `section times add up to ${sum / 60} min but total time is ${t.totalTimeSec / 60} min`,
      });
    }
  } else if (timed.length > 0) {
    const sum = timed.reduce((acc, s) => acc + (s.timeSec ?? 0), 0);
    if (sum > t.totalTimeSec) {
      ctx.addIssue({
        code: "custom",
        path: ["totalTimeSec"],
        message: "section times exceed the total time",
      });
    }
  }
}

/** Body for creating a template. */
export const examTemplateInputSchema = templateFields.superRefine(checkTemplate);
export type ExamTemplateInput = z.input<typeof examTemplateInputSchema>;

/** Body for updating a template. `key` is immutable (tests and exams reference it). */
export const examTemplateUpdateSchema = templateFields
  .omit({ key: true })
  .superRefine((t, ctx) => checkTemplate({ ...t, key: "x" }, ctx));
export type ExamTemplateUpdate = z.input<typeof examTemplateUpdateSchema>;

export const examTemplateSchema = templateFields.extend({
  id: objectIdSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type ExamTemplate = z.infer<typeof examTemplateSchema>;

export const templateQuestionCount = (t: Pick<TemplateFields, "sections">) =>
  t.sections.reduce((acc, s) => acc + s.count, 0);

export const templateMaxMarks = (t: Pick<TemplateFields, "sections" | "marking">) =>
  templateQuestionCount(t) * t.marking.correct;

export const examTemplateListResponseSchema = z.object({ templates: z.array(examTemplateSchema) });
export type ExamTemplateListResponse = z.infer<typeof examTemplateListResponseSchema>;

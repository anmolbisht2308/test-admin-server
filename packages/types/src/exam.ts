import { z } from "zod";
import { examFamilySchema, isoDateSchema, objectIdSchema, slugSchema } from "./common.js";
import { examTemplateSchema } from "./exam-template.js";

export const examStatusSchema = z.enum(["draft", "published"]);
export type ExamStatus = z.infer<typeof examStatusSchema>;

// No defaults here: `.partial()` keeps defaults in Zod 4, which would reset fields on PATCH.
const examFields = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(120),
  /** Short label for cards, e.g. "SBI PO". */
  shortName: z.string().trim().min(1).max(40),
  family: examFamilySchema,
  /** Markdown shown on the exam page. */
  description: z.string().max(5000),
  /** Papers in this exam, in order (e.g. UPSC Prelims: GS I, CSAT). */
  templateKeys: z.array(slugSchema).min(1).max(10),
  status: examStatusSchema,
  sortOrder: z.number().int().min(0).max(10_000),
});

export const examInputSchema = examFields.extend({
  description: examFields.shape.description.default(""),
  status: examFields.shape.status.default("draft"),
  sortOrder: examFields.shape.sortOrder.default(100),
});
export type ExamInput = z.input<typeof examInputSchema>;

export const examUpdateSchema = examFields.partial();
export type ExamUpdate = z.input<typeof examUpdateSchema>;

export const examSchema = examFields.extend({
  id: objectIdSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Exam = z.infer<typeof examSchema>;

/** GET /api/exams: published exams, sorted by family then sortOrder. */
export const examListResponseSchema = z.object({ exams: z.array(examSchema) });
export type ExamListResponse = z.infer<typeof examListResponseSchema>;

/** GET /api/exams/:slug: exam with its paper templates in templateKeys order. */
export const examDetailResponseSchema = z.object({
  exam: examSchema,
  templates: z.array(examTemplateSchema),
});
export type ExamDetailResponse = z.infer<typeof examDetailResponseSchema>;

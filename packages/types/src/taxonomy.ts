import { z } from "zod";
import { examFamilySchema, objectIdSchema } from "./common.js";

export const taxonomyLevelSchema = z.enum(["subject", "topic", "subtopic"]);
export type TaxonomyLevel = z.infer<typeof taxonomyLevelSchema>;

export const taxonomyNodeSchema = z.object({
  id: objectIdSchema,
  examFamily: examFamilySchema,
  parentId: objectIdSchema.nullable(),
  /** Derived from depth: root = subject, child = topic, grandchild = subtopic. */
  level: taxonomyLevelSchema,
  name: z.string(),
  /** Materialised path of ancestor ids incl. self: "/<rootId>/<childId>/". */
  path: z.string(),
});
export type TaxonomyNode = z.infer<typeof taxonomyNodeSchema>;

export const taxonomyCreateInputSchema = z.object({
  examFamily: examFamilySchema,
  parentId: objectIdSchema.nullable().default(null),
  name: z.string().trim().min(1).max(120),
});
export type TaxonomyCreateInput = z.input<typeof taxonomyCreateInputSchema>;

export const taxonomyRenameInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type TaxonomyRenameInput = z.infer<typeof taxonomyRenameInputSchema>;

export const taxonomyListResponseSchema = z.object({ nodes: z.array(taxonomyNodeSchema) });
export type TaxonomyListResponse = z.infer<typeof taxonomyListResponseSchema>;

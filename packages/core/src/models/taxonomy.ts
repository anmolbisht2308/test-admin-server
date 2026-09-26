import type { ExamFamily, TaxonomyLevel } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

export interface TaxonomyAttrs {
  examFamily: ExamFamily;
  parentId: Types.ObjectId | null;
  level: TaxonomyLevel;
  name: string;
  /** "/<rootId>/.../<selfId>/" — subtree query: { path: /^\/rootId\// }. */
  path: string;
  createdAt: Date;
  updatedAt: Date;
}

const taxonomySchema = new Schema<TaxonomyAttrs>(
  {
    examFamily: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: "Taxonomy", default: null },
    level: { type: String, enum: ["subject", "topic", "subtopic"], required: true },
    name: { type: String, required: true, trim: true },
    path: { type: String, required: true },
  },
  { timestamps: true },
);

taxonomySchema.index(
  { examFamily: 1, parentId: 1, name: 1 },
  { unique: true, collation: { locale: "en", strength: 2 } },
);
taxonomySchema.index({ path: 1 });

export const TaxonomyModel = model<TaxonomyAttrs>("Taxonomy", taxonomySchema, "taxonomy");

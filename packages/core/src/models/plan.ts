import type { PlanKind } from "@mockprep/types";
import { Schema, model } from "mongoose";

/** Something students can buy: a test series (some exams) or a pass (every exam). */
export interface PlanAttrs {
  name: string;
  description: string;
  kind: PlanKind;
  examKeys: string[];
  pricePaise: number;
  mrpPaise: number | null;
  validityDays: number;
  active: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const planSchema = new Schema<PlanAttrs>(
  {
    name: { type: String, required: true },
    description: { type: String, default: "" },
    kind: { type: String, required: true },
    examKeys: { type: [String], default: [] },
    pricePaise: { type: Number, required: true },
    mrpPaise: { type: Number, default: null },
    validityDays: { type: Number, required: true },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 100 },
  },
  { timestamps: true },
);
planSchema.index({ active: 1, sortOrder: 1 });

export const PlanModel = model<PlanAttrs>("Plan", planSchema, "plans");

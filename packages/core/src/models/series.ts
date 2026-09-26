import { Schema, model, type Types } from "mongoose";

export interface SeriesAttrs {
  title: string;
  examKey: string;
  tests: { testId: Types.ObjectId; position: number; isFree: boolean; releaseAt: Date | null }[];
  createdAt: Date;
  updatedAt: Date;
}

const seriesSchema = new Schema<SeriesAttrs>(
  {
    title: { type: String, required: true },
    examKey: { type: String, required: true },
    tests: [
      new Schema(
        {
          testId: { type: Schema.Types.ObjectId, ref: "Test", required: true },
          position: { type: Number, required: true },
          isFree: { type: Boolean, default: false },
          releaseAt: { type: Date, default: null },
        },
        { _id: false },
      ),
    ],
  },
  { timestamps: true },
);

seriesSchema.index({ examKey: 1, title: 1 });

export const SeriesModel = model<SeriesAttrs>("Series", seriesSchema, "series");

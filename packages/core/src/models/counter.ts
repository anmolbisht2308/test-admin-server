import { Schema, model, type ClientSession } from "mongoose";

/** Gap-free sequences (invoice numbers). Use inside the transaction that creates the document. */
const counterSchema = new Schema<{ _id: string; seq: number }>({
  _id: String,
  seq: { type: Number, default: 0 },
});
export const CounterModel = model("Counter", counterSchema, "counters");

export async function nextSequence(name: string, session?: ClientSession): Promise<number> {
  const doc = await CounterModel.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", ...(session ? { session } : {}) },
  ).lean();
  return doc.seq;
}

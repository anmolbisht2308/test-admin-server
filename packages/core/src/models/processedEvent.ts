import { Schema, model } from "mongoose";

/** Webhook events already handled (Razorpay retries and replays are ignored). */
const processedEventSchema = new Schema<{ _id: string; type: string; processedAt: Date }>({
  _id: String,
  type: String,
  processedAt: { type: Date, default: () => new Date() },
});

export const ProcessedEventModel = model("ProcessedEvent", processedEventSchema, "processedEvents");

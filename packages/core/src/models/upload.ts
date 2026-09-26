import type { UploadStats, UploadStatus } from "@mockprep/types";
import { Schema, model, type Types } from "mongoose";

export interface UploadFile {
  key: string;
  name: string;
  contentType: string;
  url: string;
}

export interface UploadAttrs {
  title: string;
  examKey: string;
  templateKey: string;
  files: { paper: UploadFile; key: UploadFile | null; solutions: UploadFile | null };
  status: UploadStatus;
  progress: number;
  message: string;
  log: { at: Date; level: "info" | "warn" | "error"; message: string }[];
  stats: UploadStats | null;
  testId: Types.ObjectId | null;
  error: string | null;
  /** Incremented on every (re)run; part of the BullMQ job id so reruns are never deduplicated away. */
  runs: number;
  createdBy: Types.ObjectId;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<UploadFile>(
  { key: String, name: String, contentType: String, url: String },
  { _id: false },
);

const uploadSchema = new Schema<UploadAttrs>(
  {
    title: { type: String, required: true },
    examKey: { type: String, required: true },
    templateKey: { type: String, required: true },
    files: {
      paper: { type: fileSchema, required: true },
      key: { type: fileSchema, default: null },
      solutions: { type: fileSchema, default: null },
    },
    status: { type: String, default: "queued" },
    progress: { type: Number, default: 0 },
    message: { type: String, default: "Waiting to start" },
    log: [new Schema({ at: Date, level: String, message: String }, { _id: false })],
    stats: { type: Schema.Types.Mixed, default: null },
    testId: { type: Schema.Types.ObjectId, ref: "Test", default: null },
    error: { type: String, default: null },
    runs: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

uploadSchema.index({ createdAt: -1 });
uploadSchema.index({ status: 1 });

export const UploadModel = model<UploadAttrs>("Upload", uploadSchema, "uploads");

/** Statuses that mean the pipeline has not finished (re-queued when a worker starts). */
export const UNFINISHED_UPLOAD_STATUSES: UploadStatus[] = [
  "queued",
  "extracting",
  "answer_key",
  "validating",
];

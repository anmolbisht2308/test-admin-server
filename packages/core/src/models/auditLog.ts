import { Schema, model, type Types } from "mongoose";

export type AuditAction = "create" | "update" | "delete";

export interface AuditLogAttrs {
  actor: Types.ObjectId;
  entity: string;
  entityId: string;
  action: AuditAction;
  /** create: { after }, delete: { before }, update: { field: { from, to } }. */
  diff: Record<string, unknown>;
  at: Date;
}

const auditLogSchema = new Schema<AuditLogAttrs>(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    entity: { type: String, required: true },
    entityId: { type: String, required: true },
    action: { type: String, enum: ["create", "update", "delete"], required: true },
    diff: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false, minimize: false },
);

auditLogSchema.index({ entity: 1, entityId: 1, at: -1 });
auditLogSchema.index({ actor: 1, at: -1 });

export const AuditLogModel = model<AuditLogAttrs>("AuditLog", auditLogSchema, "auditLogs");

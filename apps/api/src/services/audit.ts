import { Types } from "mongoose";
import { AuditLogModel, type AuditAction } from "../models/auditLog.js";

const IGNORED = new Set(["_id", "id", "__v", "createdAt", "updatedAt"]);

/** Top-level field diff: { field: { from, to } } for fields whose JSON value changed. */
export function diffObjects(before: Record<string, unknown>, after: Record<string, unknown>) {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key)) continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diff[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return diff;
}

export interface AuditEntry {
  actorId: string;
  entity: string;
  entityId: string;
  action: AuditAction;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** Every admin write calls this. */
export async function recordAudit({
  actorId,
  entity,
  entityId,
  action,
  before,
  after,
}: AuditEntry) {
  const diff =
    action === "create"
      ? { after: after ?? {} }
      : action === "delete"
        ? { before: before ?? {} }
        : diffObjects(before ?? {}, after ?? {});
  await AuditLogModel.create({
    actor: new Types.ObjectId(actorId),
    entity,
    entityId,
    action,
    diff,
  });
}

/** Bulk variant: one log per entity, written in one insert. */
export async function recordAuditMany(entries: AuditEntry[]) {
  if (entries.length === 0) return;
  await AuditLogModel.insertMany(
    entries.map(({ actorId, entity, entityId, action, before, after }) => ({
      actor: new Types.ObjectId(actorId),
      entity,
      entityId,
      action,
      diff:
        action === "create"
          ? { after: after ?? {} }
          : action === "delete"
            ? { before: before ?? {} }
            : diffObjects(before ?? {}, after ?? {}),
    })),
  );
}

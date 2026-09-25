import type { Request } from "express";
import type { Types } from "mongoose";
import { randomToken, sha256 } from "../lib/crypto.js";
import type { SessionKind } from "../lib/cookies.js";
import { HttpError } from "../lib/httpError.js";
import { SessionModel } from "../models/session.js";

/** A rotated-out token still works this long, so a lost response or a racing tab is not a logout. */
export const ROTATION_GRACE_MS = 20_000;

export interface SessionConfig {
  studentTtlDays: number;
  adminTtlDays: number;
  studentMaxDevices: number;
}

export interface IssuedSession {
  sessionId: string;
  userId: string;
  /** Opaque refresh token: "<sessionId>.<random>". Only its hash is stored. */
  refreshToken: string;
  expiresAt: Date;
}

const DAY_MS = 86_400_000;
const invalid = () => new HttpError(401, "Session expired. Please sign in again.");

function parseToken(token: string) {
  const [sessionId, secret] = token.split(".");
  if (!sessionId || !secret || !/^[a-f\d]{24}$/i.test(sessionId)) return null;
  return { sessionId };
}

export function createSessionService(config: SessionConfig, now: () => Date = () => new Date()) {
  const ttlMs = (kind: SessionKind) =>
    (kind === "student" ? config.studentTtlDays : config.adminTtlDays) * DAY_MS;

  return {
    /** Starts a session for a device. Students keep at most N devices: least recently used goes. */
    async create(userId: Types.ObjectId, kind: SessionKind, req: Request): Promise<IssuedSession> {
      const at = now();
      if (kind === "student") {
        const active = await SessionModel.find({
          userId,
          kind,
          revokedAt: { $exists: false },
          expiresAt: { $gt: at },
        })
          .sort({ lastUsedAt: 1 })
          .select({ _id: 1 })
          .lean();
        const excess = active.length - config.studentMaxDevices + 1;
        if (excess > 0) {
          await SessionModel.updateMany(
            { _id: { $in: active.slice(0, excess).map((s) => s._id) } },
            { $set: { revokedAt: at, revokedReason: "device_limit" } },
          );
        }
      }

      const session = new SessionModel({
        userId,
        kind,
        tokenHash: "pending",
        userAgent: req.get("user-agent")?.slice(0, 300),
        ip: req.ip,
        lastUsedAt: at,
        expiresAt: new Date(at.getTime() + ttlMs(kind)),
      });
      const refreshToken = `${session.id}.${randomToken()}`;
      session.tokenHash = sha256(refreshToken);
      await session.save();
      return {
        sessionId: session.id,
        userId: userId.toString(),
        refreshToken,
        expiresAt: session.expiresAt,
      };
    },

    /**
     * Exchanges a refresh token for a new one (rotation). Presenting a token that was already
     * rotated out (after the grace window) means it was copied: the session is revoked.
     */
    async rotate(token: string, kind: SessionKind): Promise<IssuedSession> {
      const parsed = parseToken(token);
      if (!parsed) throw invalid();
      const at = now();
      const session = await SessionModel.findById(parsed.sessionId);
      if (!session || session.kind !== kind || session.revokedAt || session.expiresAt <= at) {
        throw invalid();
      }

      const presented = sha256(token);
      const isCurrent = presented === session.tokenHash;
      const inGrace =
        presented === session.previousTokenHash &&
        session.rotatedAt !== undefined &&
        at.getTime() - session.rotatedAt.getTime() <= ROTATION_GRACE_MS;

      if (!isCurrent && !inGrace) {
        session.revokedAt = at;
        session.revokedReason = "reuse_detected";
        await session.save();
        throw invalid();
      }

      const refreshToken = `${session.id}.${randomToken()}`;
      session.previousTokenHash = session.tokenHash;
      session.tokenHash = sha256(refreshToken);
      session.rotatedAt = at;
      session.lastUsedAt = at;
      session.expiresAt = new Date(at.getTime() + ttlMs(kind)); // sliding expiry
      await session.save();
      return {
        sessionId: session.id,
        userId: session.userId.toString(),
        refreshToken,
        expiresAt: session.expiresAt,
      };
    },

    /** Best-effort logout: revokes the session the token belongs to, if the token matches. */
    async revoke(token: string) {
      const parsed = parseToken(token);
      if (!parsed) return;
      const hash = sha256(token);
      await SessionModel.updateOne(
        {
          _id: parsed.sessionId,
          $or: [{ tokenHash: hash }, { previousTokenHash: hash }],
          revokedAt: { $exists: false },
        },
        { $set: { revokedAt: now(), revokedReason: "logout" } },
      );
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

import type { AuthSessionResponse } from "@mockprep/types";
import type { Request, Response } from "express";
import type { AppContext } from "../context.js";
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
  type SessionKind,
} from "../lib/cookies.js";
import { toUserDto } from "../lib/dto.js";
import { HttpError } from "../lib/httpError.js";
import type { UserDoc } from "@mockprep/core";
import { UserModel } from "@mockprep/core";
import type { IssuedSession } from "../services/sessions.js";

async function respond(
  ctx: AppContext,
  res: Response,
  user: UserDoc,
  kind: SessionKind,
  session: IssuedSession,
) {
  setRefreshCookie(res, ctx.env, kind, session.refreshToken, session.expiresAt);
  const body: AuthSessionResponse = {
    accessToken: await ctx.tokens.signAccess({
      userId: user.id,
      role: user.role,
      sessionId: session.sessionId,
    }),
    expiresInSec: ctx.tokens.accessTtlSec,
    user: toUserDto(user),
  };
  res.set("Cache-Control", "no-store").json(body);
}

/** Creates a device session, sets the refresh cookie and sends { accessToken, user }. */
export async function startSession(
  ctx: AppContext,
  req: Request,
  res: Response,
  user: UserDoc,
  kind: SessionKind,
) {
  if (user.disabledAt) throw new HttpError(403, "This account is disabled");
  user.lastLoginAt = new Date();
  await user.save();
  await respond(ctx, res, user, kind, await ctx.sessions.create(user._id, kind, req));
}

export async function refreshSession(
  ctx: AppContext,
  req: Request,
  res: Response,
  kind: SessionKind,
) {
  const token = readRefreshCookie(req, kind);
  if (!token) throw new HttpError(401, "Not signed in");
  try {
    const session = await ctx.sessions.rotate(token, kind);
    const user = await UserModel.findById(session.userId);
    const roleMatches =
      user && (kind === "admin" ? user.role !== "student" : user.role === "student");
    if (!user || user.disabledAt || !roleMatches) {
      await ctx.sessions.revoke(session.refreshToken);
      throw new HttpError(401, "Session expired. Please sign in again.");
    }
    await respond(ctx, res, user, kind, session);
  } catch (error) {
    clearRefreshCookie(res, ctx.env, kind);
    throw error;
  }
}

export async function endSession(ctx: AppContext, req: Request, res: Response, kind: SessionKind) {
  const token = readRefreshCookie(req, kind);
  if (token) await ctx.sessions.revoke(token);
  clearRefreshCookie(res, ctx.env, kind);
  res.status(204).end();
}

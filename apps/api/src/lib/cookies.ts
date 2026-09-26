import type { CookieOptions, Request, Response } from "express";
import type { Env } from "../env.js";

import type { SessionKind } from "@mockprep/core";

export type { SessionKind };

/**
 * Refresh-token cookies. Web and admin reach the api through their own Next.js rewrite
 * (/api/* → api), so these are first-party cookies. Names differ because localhost:3000 and
 * localhost:3001 share cookies in dev (cookies ignore ports).
 */
export const REFRESH_COOKIE: Record<SessionKind, { name: string; path: string }> = {
  student: { name: "mp_rt", path: "/api/auth" },
  admin: { name: "mp_art", path: "/api/admin/auth" },
};

function options(env: Pick<Env, "COOKIE_SECURE">, kind: SessionKind): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "strict",
    path: REFRESH_COOKIE[kind].path,
  };
}

export function setRefreshCookie(
  res: Response,
  env: Pick<Env, "COOKIE_SECURE">,
  kind: SessionKind,
  token: string,
  expiresAt: Date,
) {
  res.cookie(REFRESH_COOKIE[kind].name, token, { ...options(env, kind), expires: expiresAt });
}

export function clearRefreshCookie(
  res: Response,
  env: Pick<Env, "COOKIE_SECURE">,
  kind: SessionKind,
) {
  res.clearCookie(REFRESH_COOKIE[kind].name, options(env, kind));
}

export function readRefreshCookie(req: Request, kind: SessionKind): string | undefined {
  const cookies = req.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[REFRESH_COOKIE[kind].name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

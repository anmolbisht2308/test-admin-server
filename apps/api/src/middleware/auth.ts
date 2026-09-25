import type { Role } from "@mockprep/types";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../lib/httpError.js";
import type { AccessClaims, TokenService } from "../lib/tokens.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AccessClaims;
    }
  }
}

/** Verifies `Authorization: Bearer <access token>` and sets req.auth. */
export function requireAuth(tokens: TokenService): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!token) {
      next(new HttpError(401, "Sign in required"));
      return;
    }
    tokens
      .verifyAccess(token)
      .then((claims) => {
        req.auth = claims;
        next();
      })
      .catch(() => next(new HttpError(401, "Session expired. Please sign in again.")));
  };
}

/** Must run after requireAuth. */
export function requireRole(...roles: readonly Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(new HttpError(401, "Sign in required"));
    } else if (!roles.includes(req.auth.role)) {
      next(new HttpError(403, "You don't have permission to do this"));
    } else {
      next();
    }
  };
}

/** req.auth for handlers behind requireAuth. */
export function getAuth(req: Request): AccessClaims {
  if (!req.auth) throw new HttpError(401, "Sign in required");
  return req.auth;
}

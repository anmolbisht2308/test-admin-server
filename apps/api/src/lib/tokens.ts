import { roleSchema, type Role } from "@mockprep/types";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";

const ISSUER = "mockprep-api";
const AUDIENCE = "mockprep";

export interface AccessClaims {
  userId: string;
  role: Role;
  sessionId: string;
}

const accessPayload = z.object({
  sub: z.string(),
  role: roleSchema,
  sid: z.string(),
  typ: z.literal("access"),
});

const challengePayload = z.object({ sub: z.string(), typ: z.literal("totp_challenge") });

export function createTokenService(secret: string, accessTtlSec: number) {
  const key = new TextEncoder().encode(secret);

  const sign = (claims: Record<string, unknown>, subject: string, ttlSec: number) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ttlSec}s`)
      .sign(key);

  const verify = async (token: string) =>
    (await jwtVerify(token, key, { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] }))
      .payload;

  return {
    accessTtlSec,
    signAccess: (claims: AccessClaims) =>
      sign(
        { role: claims.role, sid: claims.sessionId, typ: "access" },
        claims.userId,
        accessTtlSec,
      ),

    /** Throws when invalid or expired. */
    async verifyAccess(token: string): Promise<AccessClaims> {
      const payload = accessPayload.parse(await verify(token));
      return { userId: payload.sub, role: payload.role, sessionId: payload.sid };
    },

    /** Short-lived token proving the password step passed, exchanged for a session with TOTP. */
    signTotpChallenge: (userId: string) => sign({ typ: "totp_challenge" }, userId, 300),

    async verifyTotpChallenge(token: string): Promise<string> {
      return challengePayload.parse(await verify(token)).sub;
    },
  };
}

export type TokenService = ReturnType<typeof createTokenService>;

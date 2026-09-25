import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { HttpError } from "../lib/httpError.js";

export interface GoogleIdentity {
  sub: string;
  email?: string;
  name?: string;
}

/** Verifies a Google Identity Services ID token (the `credential` from the sign-in button). */
export interface GoogleVerifier {
  verify(idToken: string): Promise<GoogleIdentity>;
}

const claims = z.object({
  sub: z.string(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
});

export function createGoogleVerifier(clientIds: string[]): GoogleVerifier | null {
  if (clientIds.length === 0) return null;
  const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  return {
    async verify(idToken) {
      try {
        const { payload } = await jwtVerify(idToken, jwks, {
          issuer: ["https://accounts.google.com", "accounts.google.com"],
          audience: clientIds,
        });
        const parsed = claims.parse(payload);
        return {
          sub: parsed.sub,
          ...(parsed.email && parsed.email_verified ? { email: parsed.email.toLowerCase() } : {}),
          ...(parsed.name ? { name: parsed.name } : {}),
        };
      } catch (error) {
        throw new HttpError(401, "Google sign-in failed. Please try again.", undefined, error);
      }
    },
  };
}

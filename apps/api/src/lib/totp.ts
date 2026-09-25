import { createHmac, randomBytes } from "node:crypto";

/**
 * RFC 6238 TOTP (SHA-1, 30 s steps, 6 digits) — the variant every authenticator app supports.
 * Implemented on node:crypto to avoid a dependency for ~50 lines.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SEC = 30;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_STEP_SEC);

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buffer).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return code.toString().padStart(digits, "0");
}

export const totpCode = (base32Secret: string, nowMs: number) =>
  hotp(base32Decode(base32Secret), totpStep(nowMs));

/**
 * Returns the matched step (allowing ±1 step of clock drift) or null.
 * Callers must reject steps <= the last used step to prevent replay.
 */
export function verifyTotp(base32Secret: string, code: string, nowMs: number): number | null {
  const secret = base32Decode(base32Secret);
  const current = totpStep(nowMs);
  for (const step of [current, current - 1, current + 1]) {
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "@mockprep/core";
import { base32Decode, base32Encode, hotp, verifyTotp, totpCode } from "../src/lib/totp.js";

// RFC 4226 / 6238 test secret "12345678901234567890".
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("matches the RFC 4226 HOTP vectors", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314"];
    expected.forEach((code, counter) => expect(hotp(RFC_SECRET, counter)).toBe(code));
  });

  it("matches the RFC 6238 SHA-1 vector at T=59s (6-digit tail of 94287082)", () => {
    expect(totpCode(base32Encode(RFC_SECRET), 59_000)).toBe("287082");
  });

  it("round-trips base32", () => {
    expect(base32Decode(base32Encode(RFC_SECRET)).equals(RFC_SECRET)).toBe(true);
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("accepts ±1 step of drift and nothing beyond", () => {
    const secret = base32Encode(RFC_SECRET);
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 90_000), now)).toBeNull();
  });
});

describe("encrypt/decrypt", () => {
  it("round-trips and detects tampering", () => {
    const sealed = encrypt("JBSWY3DPEHPK3PXP", "k".repeat(32));
    expect(decrypt(sealed, "k".repeat(32))).toBe("JBSWY3DPEHPK3PXP");
    expect(() => decrypt(sealed, "z".repeat(32))).toThrow();
  });
});

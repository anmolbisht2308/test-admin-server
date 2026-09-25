import { describe, expect, it } from "vitest";
import { adminPasswordSchema, indianPhoneSchema, onboardingInputSchema } from "../src/index.js";

describe("indianPhoneSchema", () => {
  it.each(["9876543210", "09876543210", "+91 98765 43210", "91-9876543210", "(+91) 98765-43210"])(
    "normalises %s",
    (input) => expect(indianPhoneSchema.parse(input)).toBe("+919876543210"),
  );

  it.each(["12345", "5876543210", "+1 9876543210", "98765432101"])("rejects %s", (input) => {
    expect(indianPhoneSchema.safeParse(input).success).toBe(false);
  });
});

describe("adminPasswordSchema", () => {
  it("enforces length and character classes", () => {
    expect(adminPasswordSchema.safeParse("short").success).toBe(false);
    expect(adminPasswordSchema.safeParse("alllowercase123").success).toBe(false);
    expect(adminPasswordSchema.safeParse("Correct-Horse-9").success).toBe(true);
  });
});

describe("onboardingInputSchema", () => {
  it("needs a name and at least one exam", () => {
    expect(
      onboardingInputSchema.safeParse({ name: "A", targetExamSlugs: [], language: "en" }).success,
    ).toBe(false);
    expect(
      onboardingInputSchema.parse({ name: " Priya ", targetExamSlugs: ["sbi-po"], language: "hi" })
        .name,
    ).toBe("Priya");
  });
});

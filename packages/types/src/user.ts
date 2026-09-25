import { z } from "zod";
import { isoDateSchema, languageSchema, objectIdSchema, slugSchema } from "./common.js";

// Kept local (not imported from auth.ts) to avoid a circular import.
const roleEnum = z.enum(["student", "superadmin", "content", "reviewer", "support", "finance"]);

export const userSchema = z.object({
  id: objectIdSchema,
  role: roleEnum,
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  language: languageSchema,
  targetExamSlugs: z.array(slugSchema),
  onboarded: z.boolean(),
  createdAt: isoDateSchema,
});
export type User = z.infer<typeof userSchema>;

export const onboardingInputSchema = z.object({
  name: z.string().trim().min(2, "enter your name").max(80),
  targetExamSlugs: z.array(slugSchema).min(1, "pick at least one exam").max(10),
  language: languageSchema,
});
export type OnboardingInput = z.infer<typeof onboardingInputSchema>;

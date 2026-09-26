import { adminPasswordSchema, examInputSchema, examTemplateInputSchema } from "@mockprep/types";
import argon2 from "argon2";
import type { Logger } from "pino";
import { ExamModel } from "../models/exam.js";
import { ExamTemplateModel } from "../models/examTemplate.js";
import { UserModel } from "../models/user.js";
import { SEED_EXAMS, SEED_TEMPLATES } from "./seed-data.js";

/** Inserts missing templates/exams. Never overwrites edits made in the admin panel. */
export async function seedCatalogue() {
  for (const raw of SEED_TEMPLATES) {
    const template = examTemplateInputSchema.parse(raw);
    await ExamTemplateModel.updateOne(
      { key: template.key },
      { $setOnInsert: template },
      { upsert: true },
    );
  }
  for (const raw of SEED_EXAMS) {
    const exam = examInputSchema.parse(raw);
    await ExamModel.updateOne({ slug: exam.slug }, { $setOnInsert: exam }, { upsert: true });
  }
}

/** Creates the first superadmin if that email does not exist yet. Never changes a password. */
export async function seedAdmin(emailRaw: string, passwordRaw: string, logger: Logger) {
  const email = emailRaw.toLowerCase();
  const password = adminPasswordSchema.safeParse(passwordRaw);
  if (!password.success) {
    throw new Error(
      `SEED_ADMIN_PASSWORD: ${password.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  if (await UserModel.exists({ email })) {
    logger.info({ email }, "admin already exists; password not changed");
    return;
  }
  await UserModel.create({
    role: "superadmin",
    email,
    name: "Super admin",
    passwordHash: await argon2.hash(password.data),
  });
  logger.info({ email }, "superadmin created; set up 2FA on first sign-in");
}

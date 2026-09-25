import { examInputSchema, examTemplateInputSchema } from "@mockprep/types";
import { ExamModel } from "../models/exam.js";
import { ExamTemplateModel } from "../models/examTemplate.js";
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

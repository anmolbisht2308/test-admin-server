import { questionInputSchema, type QuestionInput } from "@mockprep/types";
import { seedCatalogue } from "../src/scripts/seedCatalogue.js";
import { createQuestion } from "../src/services/questions.js";

let counter = 0;

/** Seeded exams/templates (sbi-po, ssc-cgl, jee-main, …). Call in beforeEach (the db is wiped). */
export const seed = () => seedCatalogue();

/** Creates an approved SBI PO MCQ with unique content unless overridden. */
export async function makeQuestion(overrides: Partial<QuestionInput> = {}) {
  counter += 1;
  const data = questionInputSchema.parse({
    examKey: "sbi-po",
    section: "Quantitative Aptitude",
    type: "mcq_single",
    stem: `Question ${counter}: what is ${counter} + 1?`,
    options: ["1", "2", "3", "4", `${counter + 1}`],
    correct: [4],
    status: "approved",
    ...overrides,
  });
  return createQuestion(data);
}

export async function makeQuestions(n: number, overrides: Partial<QuestionInput> = {}) {
  const docs = [];
  for (let i = 0; i < n; i++) docs.push(await makeQuestion(overrides));
  return docs;
}

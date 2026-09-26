import { createHash } from "node:crypto";
import { normaliseForHash, type QuestionData } from "@mockprep/types";

/** sha1 of the normalised stem + options (Hindi when there is no English), for duplicates. */
export const questionHash = (q: Pick<QuestionData, "stem" | "stemHi" | "options" | "optionsHi">) =>
  createHash("sha1")
    .update(normaliseForHash(q.stem || q.stemHi, q.options.length ? q.options : q.optionsHi))
    .digest("hex");

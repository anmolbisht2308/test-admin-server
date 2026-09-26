import type { TemplateSection } from "@mockprep/types";
import { norm } from "./text.js";
import type { RawQuestion } from "./types.js";

/** Template section whose name or alias matches a heading from the paper, if any. */
export function matchSection(
  heading: string | null,
  sections: Pick<TemplateSection, "name" | "aliases">[],
): string | null {
  if (!heading) return null;
  const h = norm(heading);
  if (!h) return null;
  let best = null as { name: string; score: number; length: number } | null;
  for (const s of sections) {
    for (const candidate of [s.name, ...s.aliases]) {
      const c = norm(candidate);
      if (!c) continue;
      // Exact beats "heading contains the name" ("PART A: GENERAL AWARENESS"), which beats
      // "name contains the heading" ("Reasoning" for "Reasoning Ability").
      const score = h === c ? 3 : h.includes(c) ? 2 : c.includes(h) && h.length >= 4 ? 1 : 0;
      if (score === 0) continue;
      if (!best || score > best.score || (score === best.score && c.length > best.length)) {
        best = { name: s.name, score, length: c.length };
      }
    }
  }
  return best?.name ?? null;
}

/**
 * Template section per question. Uses the paper's headings when every question matches one;
 * otherwise fills the template sections in order by their question counts (extra questions go to
 * the last section).
 */
export function assignSections(
  questions: Pick<RawQuestion, "section">[],
  sections: Pick<TemplateSection, "name" | "aliases" | "count">[],
): { sections: string[]; method: "headings" | "order" } {
  const matched = questions.map((q) => matchSection(q.section, sections));
  if (matched.length > 0 && matched.every((m) => m !== null)) {
    return { sections: matched, method: "headings" };
  }
  const byOrder: string[] = [];
  for (const s of sections) for (let i = 0; i < s.count; i++) byOrder.push(s.name);
  const last = sections[sections.length - 1]?.name ?? "";
  return { sections: questions.map((_, i) => byOrder[i] ?? last), method: "order" };
}

/**
 * Numbers missing from the paper's numbering. Numbering may restart (per section), so each run
 * that starts at or below the previous number is checked on its own.
 */
export function missingNumbers(numbers: (number | null)[]): number[] {
  const missing: number[] = [];
  let prev: number | null = null;
  for (const n of numbers) {
    if (n === null) continue;
    if (prev === null) {
      for (let k = 1; k < n && n <= 10; k++) missing.push(k);
    } else if (n > prev + 1) {
      for (let k = prev + 1; k < n; k++) missing.push(k);
    }
    prev = n;
  }
  return missing;
}

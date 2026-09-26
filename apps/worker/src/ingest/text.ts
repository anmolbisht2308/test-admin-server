/** Text helpers shared by the parsers. */

const DEVANAGARI = /[ऀ-ॿ]/g;
const LETTERS = /[\p{L}]/gu;

/** True when most letters on the line are Devanagari (Hindi). */
export function isHindi(text: string): boolean {
  const letters = text.match(LETTERS)?.length ?? 0;
  const hindi = text.match(DEVANAGARI)?.length ?? 0;
  return letters > 0 && hindi / letters > 0.5;
}

export const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** Appends a line to a paragraph, joining with a space. */
export const append = (base: string, line: string) => (base ? `${base} ${line}` : line);

/** Normalises for comparison: lowercase, letters only, single spaces. */
export const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const OPTION_LETTERS = "ABCDEF";

/** Option index from a marker: a–f / A–F → 0–5, 1–6 → 0–5. */
export function optionIndex(marker: string): number {
  const upper = marker.toUpperCase();
  const letter = OPTION_LETTERS.indexOf(upper);
  if (letter >= 0) return letter;
  const digit = Number(marker);
  return Number.isInteger(digit) && digit >= 1 && digit <= 6 ? digit - 1 : -1;
}

/** Count of `$` not escaped by a backslash. */
export const unescapedDollars = (text: string) => (text.match(/(?<!\\)\$/g) ?? []).length;

const FIGURE_RE =
  /\b(figure|fig\.|diagram|graph|picture|image|pie[- ]?chart|bar[- ]?chart|venn)\b[^.?]*\b(given|below|shown|following|above|provided)\b|\b(given|below|shown|following|above)\b[^.?]*\b(figure|diagram|graph|picture|image)\b|\[(figure|diagram|image)\]/i;

/** The question refers to a picture the text layer cannot carry. */
export const mentionsFigure = (text: string) => FIGURE_RE.test(text);

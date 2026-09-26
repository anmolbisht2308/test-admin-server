/**
 * Renders the sample papers in test/fixtures/data.ts to PDFs (committed to the repo).
 * Run: pnpm --filter @mockprep/worker fixtures
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import {
  JEE_QUESTIONS,
  SBI_QUESTIONS,
  SSC_QUESTIONS,
  type FixtureQuestion,
} from "../test/fixtures/data.js";

const DIR = path.resolve(import.meta.dirname, "../test/fixtures");
const LETTERS = "abcde";

class Writer {
  private page!: PDFPage;
  private y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly header?: (page: number) => string[],
    private readonly footer?: (page: number, total: number) => string[],
  ) {}
  pages = 0;

  newPage() {
    this.page = this.doc.addPage([595, 842]);
    this.pages += 1;
    this.y = 800;
    for (const line of this.header?.(this.pages) ?? []) this.line(line, 9);
    this.y -= 6;
  }

  /** Draws a line, wrapping long text at ~90 characters. */
  line(text: string, size = 11) {
    const words = text.split(" ");
    let current = "";
    const flush = () => {
      this.page.drawText(current, { x: 50, y: this.y, size, font: this.font });
      this.y -= size + 6;
      current = "";
    };
    for (const word of words) {
      if ((current + " " + word).trim().length > 90) flush();
      current = (current + " " + word).trim();
    }
    if (current) flush();
  }

  gap() {
    this.y -= 6;
  }

  finish() {
    const total = this.pages;
    this.doc.getPages().forEach((page, i) => {
      let y = 40;
      for (const line of this.footer?.(i + 1, total) ?? []) {
        page.drawText(line, { x: 50, y, size: 9, font: this.font });
        y -= 12;
      }
    });
  }
}

const inline = (q: FixtureQuestion) => q.options.map((o, i) => `(${LETTERS[i]}) ${o}`).join("   ");

async function doc() {
  const d = await PDFDocument.create();
  return { d, font: await d.embedFont(StandardFonts.Helvetica) };
}

async function sbi() {
  const { d, font } = await doc();
  const w = new Writer(d, font, () => ["SBI PO PRELIMS - PRACTICE PAPER 3"]);
  let section = "";
  for (const q of SBI_QUESTIONS) {
    if (q.section !== section) {
      section = q.section;
      w.newPage();
      w.line(section.toUpperCase(), 13);
      w.gap();
      if (q.passage) {
        w.line(
          "Directions (1-3): Read the passage carefully and answer the questions that follow.",
        );
        w.line(q.passage);
        w.gap();
      }
    }
    w.line(`${q.number}. ${q.stem}`);
    // Question 4 lists options one per line; the rest print them inline.
    if (q.number === 4) q.options.forEach((o, i) => w.line(`(${LETTERS[i]}) ${o}`));
    else w.line(inline(q));
    w.gap();
  }
  w.finish();
  await writeFile(path.join(DIR, "sbi-paper.pdf"), await d.save());

  const key = await doc();
  const k = new Writer(key.d, key.font);
  k.newPage();
  k.line("ANSWER KEY - SBI PO PRELIMS PRACTICE PAPER 3", 13);
  const entries = SBI_QUESTIONS.map(
    (q) => `${q.number}. ${LETTERS[(q.answer as number[])[0] as number]?.toUpperCase()}`,
  );
  for (let i = 0; i < entries.length; i += 4) k.line(entries.slice(i, i + 4).join("     "));
  await writeFile(path.join(DIR, "sbi-key.pdf"), await key.d.save());
}

async function ssc() {
  const { d, font } = await doc();
  const w = new Writer(
    d,
    font,
    () => ["SSC CGL TIER-I MOCK TEST - SET 12", "Time: 60 minutes   Maximum marks: 200"],
    (page, total) => [`Page ${page} of ${total}`, "www.example-coaching.in"],
  );
  let section = "";
  SSC_QUESTIONS.forEach((q, i) => {
    if (i % 10 === 0) w.newPage();
    if (q.section !== section) {
      section = q.section;
      w.line(`PART ${"ABCD"[SSC_QUESTIONS.indexOf(q) / 10]}: ${section.toUpperCase()}`, 12);
    }
    w.line(`${q.number}. ${q.stem}`);
    // Two options per line, like many coaching papers.
    w.line(`(a) ${q.options[0]}        (b) ${q.options[1]}`);
    w.line(`(c) ${q.options[2]}        (d) ${q.options[3]}`);
  });
  w.finish();
  await writeFile(path.join(DIR, "ssc-paper.pdf"), await d.save());

  // Key mixes the formats found in the wild.
  const key = await doc();
  const k = new Writer(key.d, key.font);
  k.newPage();
  k.line("SSC CGL MOCK 12 - ANSWER KEY", 13);
  const fmt = (q: FixtureQuestion) => {
    const idx = (q.answer as number[])[0] as number;
    if (q.number <= 10) return `${q.number}-(${LETTERS[idx]})`;
    if (q.number <= 20) return `${q.number} ${LETTERS[idx]?.toUpperCase()}`;
    if (q.number <= 30) return `Q${q.number} (${LETTERS[idx]?.toUpperCase()})`;
    return `${q.number}. (${idx + 1})`;
  };
  for (let i = 0; i < SSC_QUESTIONS.length; i += 5)
    k.line(
      SSC_QUESTIONS.slice(i, i + 5)
        .map(fmt)
        .join("    "),
    );
  await writeFile(path.join(DIR, "ssc-key.pdf"), await key.d.save());
}

async function jee() {
  const { d, font } = await doc();
  const w = new Writer(d, font, () => ["JEE MAIN PRACTICE TEST"]);
  let section = "";
  for (const q of JEE_QUESTIONS) {
    if (q.section !== section) {
      section = q.section;
      w.newPage();
      w.line(section.toUpperCase(), 13);
      w.gap();
    }
    w.line(`Q.${q.number} ${q.stem}`);
    q.options.forEach((o, i) => w.line(`(${i + 1}) ${o}`));
    const answer = Array.isArray(q.answer) ? `(${(q.answer[0] as number) + 1})` : `${q.answer.min}`;
    w.line(`Ans. ${answer}`);
    if (q.solution) w.line(`Sol. ${q.solution}`);
    w.gap();
  }
  w.finish();
  await writeFile(path.join(DIR, "jee-paper.pdf"), await d.save());
}

/** A "scanned" paper: pages with no text layer (just shapes). */
async function scan() {
  const d = await PDFDocument.create();
  for (let i = 0; i < 2; i++) {
    const page = d.addPage([595, 842]);
    page.drawRectangle({ x: 50, y: 400, width: 300, height: 200, borderWidth: 2 });
  }
  await writeFile(path.join(DIR, "scan.pdf"), await d.save());
}

await sbi();
await ssc();
await jee();
await scan();
process.stdout.write(`fixtures written to ${DIR}\n`);

import { Readable } from "node:stream";
import {
  OPTION_LETTERS,
  isNumericType,
  questionInputSchema,
  questionTypeSchema,
  type ExamFamily,
  type ImportReport,
  type QuestionData,
} from "@mockprep/types";
import ExcelJS from "exceljs";
import { Types } from "mongoose";
import { HttpError } from "../lib/httpError.js";
import { ExamModel } from "@mockprep/core";
import { QuestionModel } from "@mockprep/core";
import { questionHash } from "./questions.js";

export const MAX_IMPORT_ROWS = 2000;
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const optionColumns = OPTION_LETTERS.map((l) => `option${l}`);
const optionHiColumns = OPTION_LETTERS.map((l) => `option${l}Hi`);

/** Spreadsheet columns, in template order. Header matching ignores case, spaces and underscores. */
export const IMPORT_COLUMNS = [
  "examKey",
  "section",
  "number",
  "type",
  "passage",
  "stem",
  ...optionColumns,
  "correct",
  "solution",
  "subject",
  "topic",
  "difficulty",
  "passageHi",
  "stemHi",
  ...optionHiColumns,
  "solutionHi",
  "figureUrl",
  "sourcePage",
] as const;
const REQUIRED_COLUMNS = ["examKey", "section", "stem", "correct"];

const normHeader = (value: string) => value.toLowerCase().replace(/[\s_-]/g, "");
const COLUMN_BY_HEADER = new Map(IMPORT_COLUMNS.map((c) => [normHeader(c), c]));

/** Plain text of any exceljs cell value (rich text, formulas, hyperlinks, numbers, dates). */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if ("richText" in value)
    return value.richText
      .map((part) => part.text)
      .join("")
      .trim();
  if ("formula" in value || "sharedFormula" in value)
    return cellText((value as { result?: ExcelJS.CellValue }).result ?? null);
  if ("text" in value) return String(value.text).trim();
  return "";
}

/** "B", "(b)", "A, C", "a;c" → [1] / [0, 2]. Returns null when unparseable. */
export function parseLetters(value: string): number[] | null {
  const parts = value
    .toUpperCase()
    .replace(/[()\s]/g, "")
    .split(/[,;/&]+|(?<=[A-F])(?=[A-F])/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  const indices = parts.map((p) => OPTION_LETTERS.indexOf(p as (typeof OPTION_LETTERS)[number]));
  return indices.every((i) => i >= 0) ? indices : null;
}

/** "12", "12.5", "12.4-12.6", "12.4 to 12.6", "-3" → { min, max }. */
export function parseNumericAnswer(value: string): { min: number; max: number } | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)(?:\s*(?:to|–|—|-)\s*(-?\d+(?:\.\d+)?))?$/i);
  if (!match?.[1]) return null;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  return { min, max };
}

type Row = Partial<Record<(typeof IMPORT_COLUMNS)[number], string>>;

async function readRows(buffer: Buffer, isCsv: boolean): Promise<Row[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    if (isCsv) await workbook.csv.read(Readable.from(buffer));
    else await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new HttpError(400, "Could not read the file. Upload the .xlsx template or a UTF-8 .csv.");
  }
  const sheet = workbook.getWorksheet("Questions") ?? workbook.worksheets[0];
  if (!sheet) throw new HttpError(400, "The file has no sheets");

  const headerRow = sheet.getRow(1);
  const columns = new Map<number, (typeof IMPORT_COLUMNS)[number]>();
  headerRow.eachCell((cell, col) => {
    const column = COLUMN_BY_HEADER.get(normHeader(cellText(cell.value)));
    if (column) columns.set(col, column);
  });
  const found = new Set(columns.values());
  const missing = REQUIRED_COLUMNS.filter((c) => !found.has(c));
  if (missing.length)
    throw new HttpError(
      400,
      `Missing columns: ${missing.join(", ")}. Download the template to see the format.`,
      { missing },
    );

  const rows: Row[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row: Row = {};
    for (const [col, column] of columns) row[column] = cellText(sheet.getRow(r).getCell(col).value);
    rows.push(row);
  }
  // Drop trailing blank rows.
  while (rows.length && Object.values(rows[rows.length - 1] ?? {}).every((v) => !v)) rows.pop();
  if (rows.length > MAX_IMPORT_ROWS)
    throw new HttpError(400, `Too many rows (max ${MAX_IMPORT_ROWS}). Split the file.`);
  return rows;
}

function collectOptions(row: Row, columns: string[], errors: string[]): string[] {
  const values = columns.map((c) => row[c] ?? "");
  const last = values.map((v) => v !== "").lastIndexOf(true);
  const used = values.slice(0, last + 1);
  used.forEach((v, i) => {
    if (!v) errors.push(`${columns[i]} is empty but a later option is filled`);
  });
  return used;
}

function toInt(value: string | undefined, column: string, errors: string[]): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    errors.push(`${column} must be a positive whole number`);
    return null;
  }
  return n;
}

/** Maps a row to question data or a list of problems. */
function mapRow(
  row: Row,
  exams: Map<string, ExamFamily>,
): { data?: QuestionData; errors: string[] } {
  const errors: string[] = [];
  const typeRaw = (row.type ?? "").toLowerCase().replace(/[\s-]/g, "_") || "mcq_single";
  const type = questionTypeSchema.safeParse(typeRaw);
  if (!type.success)
    errors.push(`type "${row.type}" must be one of ${questionTypeSchema.options.join(", ")}`);
  const examKey = row.examKey?.toLowerCase() ?? "";
  if (examKey && !exams.has(examKey)) errors.push(`examKey "${row.examKey}" is not an exam`);

  const options = collectOptions(row, optionColumns, errors);
  const optionsHi = collectOptions(row, optionHiColumns, errors);

  let correct: number[] = [];
  let numAnswer: { min: number; max: number } | null = null;
  const answer = row.correct ?? "";
  if (type.success && isNumericType(type.data)) {
    numAnswer = answer ? parseNumericAnswer(answer) : null;
    if (answer && !numAnswer)
      errors.push(`correct "${answer}" must be a number or a range like 12.4-12.6`);
  } else {
    const parsed = parseLetters(answer);
    if (parsed === null) errors.push(`correct "${answer}" must be option letters like B or A,C`);
    else correct = parsed;
  }

  const difficulty = (row.difficulty ?? "").toLowerCase() || "medium";
  const number = toInt(row.number, "number", errors);
  const sourcePage = toInt(row.sourcePage, "sourcePage", errors);
  if (errors.length || !type.success) return { errors };

  const result = questionInputSchema.safeParse({
    examKey,
    section: row.section ?? "",
    number,
    type: type.data,
    passage: row.passage ?? "",
    passageHi: row.passageHi ?? "",
    stem: row.stem ?? "",
    stemHi: row.stemHi ?? "",
    options,
    optionsHi,
    correct,
    numAnswer,
    solution: row.solution ?? "",
    solutionHi: row.solutionHi ?? "",
    subject: row.subject ?? "",
    topic: row.topic ?? "",
    difficulty,
    hasFigure: Boolean(row.figureUrl),
    figureUrl: row.figureUrl || null,
    sourcePage,
    answerSource: "key",
    status: "approved",
  });
  if (!result.success) {
    return {
      errors: result.error.issues.map(
        (i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
      ),
    };
  }
  return { data: result.data, errors: [] };
}

/**
 * Validates every row, then (unless dryRun) inserts the valid ones as approved questions.
 * Rows that already exist in the bank (or earlier in the file) are imported with a "duplicate" flag.
 */
export async function importQuestions(
  buffer: Buffer,
  options: { isCsv: boolean; dryRun: boolean },
): Promise<ImportReport> {
  const rows = await readRows(buffer, options.isCsv);
  const exams = new Map(
    (await ExamModel.find().select({ slug: 1, family: 1 }).lean()).map((e) => [e.slug, e.family]),
  );

  const valid: { row: number; data: QuestionData; hash: string }[] = [];
  const rejected: ImportReport["rejected"] = [];
  rows.forEach((row, i) => {
    const rowNumber = i + 2; // spreadsheet row (header is row 1)
    if (Object.values(row).every((v) => !v)) return;
    const { data, errors } = mapRow(row, exams);
    if (data) valid.push({ row: rowNumber, data, hash: questionHash(data) });
    else rejected.push({ row: rowNumber, errors });
  });

  const existing = new Set(
    await QuestionModel.find({ isLatest: true, hash: { $in: valid.map((v) => v.hash) } }).distinct(
      "hash",
    ),
  );
  const seen = new Set<string>();
  let duplicates = 0;
  const docs = valid.map(({ data, hash }) => {
    const duplicate = existing.has(hash) || seen.has(hash);
    if (duplicate) duplicates++;
    seen.add(hash);
    const _id = new Types.ObjectId();
    return {
      ...data,
      _id,
      rootId: _id,
      version: 1,
      isLatest: true,
      examFamily: exams.get(data.examKey) ?? "other",
      hash,
      flags: duplicate ? ["duplicate"] : [],
      taxonomyIds: data.taxonomyIds.map((id) => new Types.ObjectId(id)),
    };
  });
  if (!options.dryRun && docs.length) await QuestionModel.insertMany(docs, { ordered: false });

  return {
    dryRun: options.dryRun,
    total: valid.length + rejected.length,
    imported: options.dryRun ? 0 : docs.length,
    duplicates,
    rejected,
  };
}

/** The downloadable .xlsx template: headers, examples, dropdowns and an instructions sheet. */
export async function buildImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Questions", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = IMPORT_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key.startsWith("option")
      ? 14
      : key === "stem" || key === "passage" || key === "solution"
        ? 40
        : 16,
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({
    examKey: "sbi-po",
    section: "Quantitative Aptitude",
    number: 1,
    type: "mcq_single",
    stem: "If $3x + 5 = 20$, what is $x$?",
    optionA: "3",
    optionB: "4",
    optionC: "5",
    optionD: "6",
    optionE: "7",
    correct: "C",
    solution: "$3x = 15$, so $x = 5$.",
    subject: "Quantitative Aptitude",
    topic: "Linear equations",
    difficulty: "easy",
    stemHi: "यदि $3x + 5 = 20$ है, तो $x$ का मान क्या है?",
    optionAHi: "3",
    optionBHi: "4",
    optionCHi: "5",
    optionDHi: "6",
    optionEHi: "7",
  });
  sheet.addRow({
    examKey: "sbi-po",
    section: "Reasoning Ability",
    number: 2,
    type: "mcq_multi",
    stem: "Which of these are prime numbers?",
    optionA: "2",
    optionB: "4",
    optionC: "7",
    optionD: "9",
    correct: "A,C",
    topic: "Number system",
    difficulty: "medium",
  });
  sheet.addRow({
    examKey: "jee-main",
    section: "Physics",
    number: 21,
    type: "numeric",
    stem: "A body starts from rest with $a = 2\\,m/s^2$. Distance covered in 3 s (in m)?",
    correct: "9",
    solution: "$s = \\tfrac{1}{2}at^2 = 9$",
    topic: "Kinematics",
    difficulty: "easy",
  });
  const lastRow = MAX_IMPORT_ROWS + 1;
  const typeCol = sheet.getColumn("type").letter;
  const diffCol = sheet.getColumn("difficulty").letter;
  for (let r = 2; r <= Math.min(lastRow, 1000); r++) {
    sheet.getCell(`${typeCol}${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${questionTypeSchema.options.join(",")}"`],
    };
    sheet.getCell(`${diffCol}${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"easy,medium,hard"'],
    };
  }

  const help = workbook.addWorksheet("Instructions");
  help.columns = [
    { header: "Column", width: 16 },
    { header: "What to put", width: 100 },
  ];
  help.getRow(1).font = { bold: true };
  const rowsHelp: [string, string][] = [
    ["examKey", "Required. Exam slug from the admin Exams page, e.g. sbi-po, ssc-cgl, jee-main."],
    [
      "section",
      "Required. Section name, e.g. Quantitative Aptitude (should match the exam template).",
    ],
    ["number", "Optional. Question number as printed."],
    ["type", "mcq_single (default), mcq_multi, integer or numeric."],
    ["passage", "Optional shared passage (RC/DI). Repeat it on every row it belongs to."],
    ["stem", "Required. Question text. Markdown; maths in $...$ or $$...$$; tables as Markdown."],
    ["optionA–F", "Options for MCQs. Leave numeric questions' options empty. Don't skip letters."],
    [
      "correct",
      "Required. MCQ: letters (B or A,C). Integer/numeric: a value (12.5) or range (12.4-12.6).",
    ],
    ["difficulty", "easy, medium (default) or hard."],
    [
      "…Hi columns",
      "Optional Hindi versions. Hindi options must match the English ones one-to-one.",
    ],
    ["figureUrl", "Optional https image URL (or upload the image later in the question editor)."],
    [
      "",
      `Rows are imported as approved questions. Invalid rows are listed with reasons and skipped. Max ${MAX_IMPORT_ROWS} rows.`,
    ],
  ];
  rowsHelp.forEach((r) => help.addRow(r));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

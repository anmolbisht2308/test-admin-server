import ExcelJS from "exceljs";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { QuestionModel } from "@mockprep/core";
import {
  IMPORT_COLUMNS,
  XLSX_TYPE,
  parseLetters,
  parseNumericAnswer,
} from "../src/services/questionImport.js";
import { seed } from "./factories.js";
import { accessTokenFor, buildTestApp, useTestDatabase } from "./helpers.js";

useTestDatabase();

let auth: { Authorization: string };
beforeEach(async () => {
  await seed();
  auth = { Authorization: `Bearer ${await accessTokenFor("64b0000000000000000000aa", "content")}` };
});

type Row = Partial<Record<(typeof IMPORT_COLUMNS)[number], string | number>>;
const SECTIONS = ["English Language", "Quantitative Aptitude", "Reasoning Ability"];
const DIFFS = ["easy", "medium", "hard"];

/** 100 SBI PO rows: 95 valid (with maths, a table, Hindi), 5 broken on purpose (rows 21, 41, 61, 81, 101). */
function sbiPoRows(): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= 100; i++) {
    const row: Row = {
      examKey: "sbi-po",
      section: SECTIONS[i % 3],
      number: i,
      type: "mcq_single",
      stem:
        i % 10 === 0
          ? `| Year | Sales |\n| --- | --- |\n| 2024 | ${i} |\n\nWhat were sales in 2024 (Q${i})?`
          : `Q${i}: If $x^2 = ${i * i}$, find $x$ (positive).`,
      optionA: `${i - 2}`,
      optionB: `${i - 1}`,
      optionC: `${i}`,
      optionD: `${i + 1}`,
      optionE: `${i + 2}`,
      correct: "C",
      solution: `$x = ${i}$`,
      topic: i % 3 === 1 ? "Algebra" : "Arithmetic",
      difficulty: DIFFS[i % 3],
      stemHi: i % 7 === 0 ? `प्रश्न ${i}: $x$ का मान ज्ञात करें।` : "",
    };
    rows.push(row);
  }
  rows[19] = { ...rows[19], stem: "" }; // row 21: approved question without text
  rows[39] = { ...rows[39], correct: "G" }; // row 41: letter out of range
  rows[59] = { ...rows[59], examKey: "rrb-po" }; // row 61: unknown exam
  rows[79] = { ...rows[79], optionB: "" }; // row 81: gap in options
  rows[99] = { ...rows[99], type: "numeric", correct: "B" }; // row 101: letter for a numeric question
  return rows;
}

async function xlsx(rows: Row[]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Questions");
  sheet.columns = IMPORT_COLUMNS.map((key) => ({ header: key, key }));
  rows.forEach((r) => sheet.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const upload = (app: ReturnType<typeof buildTestApp>, file: Buffer, qs = "", type = XLSX_TYPE) =>
  request(app)
    .post(`/api/admin/questions/import${qs}`)
    .set(auth)
    .set("Content-Type", type)
    .send(file);

describe("Excel import", () => {
  it("imports a 100-row SBI PO sheet and lists bad rows with reasons", async () => {
    const app = buildTestApp();
    const file = await xlsx(sbiPoRows());

    const dry = await upload(app, file, "?dryRun=1").expect(200);
    expect(dry.body).toMatchObject({ dryRun: true, total: 100, imported: 0 });
    expect(await QuestionModel.countDocuments()).toBe(0);

    const res = await upload(app, file, "?filename=sbi.xlsx").expect(200);
    expect(res.body).toMatchObject({ dryRun: false, total: 100, imported: 95, duplicates: 0 });
    const byRow = Object.fromEntries(
      res.body.rejected.map((r: { row: number; errors: string[] }) => [
        r.row,
        r.errors.join(" | "),
      ]),
    );
    expect(Object.keys(byRow).map(Number)).toEqual([21, 41, 61, 81, 101]);
    expect(byRow[21]).toMatch(/stem: approved questions need a question text/);
    expect(byRow[41]).toMatch(/correct "G" must be option letters/);
    expect(byRow[61]).toMatch(/examKey "rrb-po" is not an exam/);
    expect(byRow[81]).toMatch(/optionB is empty but a later option is filled/);
    expect(byRow[101]).toMatch(/correct "B" must be a number/);

    expect(
      await QuestionModel.countDocuments({
        status: "approved",
        answerSource: "key",
        examFamily: "banking",
      }),
    ).toBe(95);
    const table = await QuestionModel.findOne({ number: 10 }).lean();
    expect(table?.stem).toContain("| Year | Sales |");
    expect(table?.correct).toEqual([2]);
    expect(await QuestionModel.countDocuments({ stemHi: { $ne: "" } })).toBeGreaterThan(10);

    // Importing again flags every row as a duplicate (still imported).
    const again = await upload(app, file).expect(200);
    expect(again.body.duplicates).toBe(95);
  });

  it("reads CSV and the downloadable template's own examples", async () => {
    const app = buildTestApp();
    const csv =
      "examKey,section,type,stem,optionA,optionB,optionC,optionD,correct\nssc-cgl,General Awareness,,Capital of India?,Delhi,Mumbai,Pune,Agra,a\njee-main,Physics,numeric,g in m/s^2?,,,,,9.7-9.9\n";
    const res = await upload(app, Buffer.from(csv), "?filename=q.csv", "text/csv").expect(200);
    expect(res.body).toMatchObject({ imported: 2, rejected: [] });
    expect((await QuestionModel.findOne({ section: "Physics" }).lean())?.numAnswer).toEqual({
      min: 9.7,
      max: 9.9,
    });

    const template = await request(app)
      .get("/api/admin/questions/import/template")
      .set(auth)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(template.headers["content-disposition"]).toMatch(/mockprep-questions-template\.xlsx/);
    const imported = await upload(app, template.body as Buffer).expect(200);
    expect(imported.body).toMatchObject({ imported: 3, rejected: [] });
  });

  it("rejects files without the required columns or unreadable files", async () => {
    const app = buildTestApp();
    const res = await upload(
      app,
      Buffer.from("foo,bar\n1,2\n"),
      "?filename=x.csv",
      "text/csv",
    ).expect(400);
    expect(res.body.details).toEqual({ missing: ["examKey", "section", "stem", "correct"] });
    await upload(app, Buffer.from("not a zip")).expect(400);
  });
});

describe("answer parsing", () => {
  it("parses letters and numeric ranges", () => {
    expect(parseLetters("b")).toEqual([1]);
    expect(parseLetters("(c)")).toEqual([2]);
    expect(parseLetters("A, C")).toEqual([0, 2]);
    expect(parseLetters("AC")).toEqual([0, 2]);
    expect(parseLetters("Z")).toBeNull();
    expect(parseNumericAnswer("12")).toEqual({ min: 12, max: 12 });
    expect(parseNumericAnswer("-3.5")).toEqual({ min: -3.5, max: -3.5 });
    expect(parseNumericAnswer("12.4 to 12.6")).toEqual({ min: 12.4, max: 12.6 });
    expect(parseNumericAnswer("12.4-12.6")).toEqual({ min: 12.4, max: 12.6 });
    expect(parseNumericAnswer("abc")).toBeNull();
  });
});

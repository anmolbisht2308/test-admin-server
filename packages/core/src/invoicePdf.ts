import { GST_PERCENT } from "@mockprep/types";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { InvoiceAttrs } from "./models/invoice.js";

/** The seller block on invoices (from env: SELLER_*). */
export interface SellerInfo {
  name: string;
  address: string;
  gstin: string;
  /** e.g. "Uttarakhand (05)". */
  state: string;
  email: string;
}

export type InvoiceForPdf = Pick<
  InvoiceAttrs,
  | "kind"
  | "number"
  | "date"
  | "description"
  | "amountPaise"
  | "taxablePaise"
  | "cgstPaise"
  | "sgstPaise"
  | "igstPaise"
  | "customer"
> & { originalNumber?: string | null };

/** "Rs. 1,234.50": standard PDF fonts have no ₹ glyph. Paise → rupees only here, for display. */
export function formatRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toLocaleString("en-IN");
  return `${sign}Rs. ${rupees}.${String(abs % 100).padStart(2, "0")}`;
}

const istDate = (d: Date) =>
  d.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

/** Standard fonts are WinAnsi only: replace anything else (e.g. Devanagari names). */
const safe = (text: string) =>
  text
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\x20-\x7E]/g, "?");

/** A one-page GST invoice / credit note (pdf-lib, standard fonts: small and fast). */
export async function renderInvoicePdf(
  inv: InvoiceForPdf,
  seller: SellerInfo,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const title = inv.kind === "invoice" ? "TAX INVOICE" : "CREDIT NOTE";
  doc.setTitle(`${title} ${inv.number}`);
  doc.setProducer("mockprep");
  const page = doc.addPage([595, 842]); // A4
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const grey = rgb(0.4, 0.4, 0.4);

  const text = (p: PDFPage, s: string, x: number, y: number, size = 10, font: PDFFont = regular) =>
    p.drawText(safe(s), { x, y, size, font, color: rgb(0.1, 0.1, 0.1) });
  const right = (s: string, xRight: number, y: number, size = 10, font: PDFFont = regular) =>
    text(page, s, xRight - font.widthOfTextAtSize(safe(s), size), y, size, font);

  let y = 790;
  text(page, seller.name, 50, y, 16, bold);
  right(title, 545, y, 14, bold);
  y -= 18;
  for (const line of seller.address.split(/\n|,\s*(?=\S)/).slice(0, 3)) {
    text(page, line.trim(), 50, y, 9);
    y -= 12;
  }
  text(page, `GSTIN: ${seller.gstin || "Not registered"}`, 50, y, 9);
  y -= 12;
  text(page, `State: ${seller.state}`, 50, y, 9);
  y -= 12;
  if (seller.email) text(page, seller.email, 50, y, 9);

  right(`No. ${inv.number}`, 545, 770, 10, bold);
  right(`Date: ${istDate(inv.date)}`, 545, 756);
  if (inv.originalNumber) right(`Against invoice ${inv.originalNumber}`, 545, 742, 9);

  y = 690;
  page.drawLine({ start: { x: 50, y: y + 8 }, end: { x: 545, y: y + 8 }, color: grey });
  text(page, "Billed to", 50, y - 8, 9, bold);
  y -= 22;
  for (const line of [inv.customer.name, inv.customer.email, inv.customer.phone].filter(Boolean)) {
    text(page, line, 50, y);
    y -= 13;
  }
  text(page, "Place of supply: as per seller state (B2C, online service)", 50, y, 8);

  // Line items
  y = 590;
  page.drawRectangle({ x: 50, y: y - 6, width: 495, height: 20, color: rgb(0.94, 0.95, 0.97) });
  text(page, "Description", 56, y, 9, bold);
  text(page, "SAC", 330, y, 9, bold);
  right("Taxable value", 539, y, 9, bold);
  y -= 24;
  text(page, inv.description.slice(0, 60), 56, y);
  text(page, "999293", 330, y);
  right(formatRupees(inv.taxablePaise), 539, y);

  y -= 40;
  const rows: [string, number][] =
    inv.igstPaise > 0
      ? [[`IGST @ ${GST_PERCENT}%`, inv.igstPaise]]
      : [
          [`CGST @ ${GST_PERCENT / 2}%`, inv.cgstPaise],
          [`SGST @ ${GST_PERCENT / 2}%`, inv.sgstPaise],
        ];
  right("Taxable value", 440, y);
  right(formatRupees(inv.taxablePaise), 539, y);
  for (const [label, value] of rows) {
    y -= 16;
    right(label, 440, y);
    right(formatRupees(value), 539, y);
  }
  y -= 8;
  page.drawLine({ start: { x: 330, y }, end: { x: 545, y }, color: grey });
  y -= 16;
  right(inv.kind === "invoice" ? "Total (incl. GST)" : "Total refunded", 440, y, 11, bold);
  right(formatRupees(inv.amountPaise), 539, y, 11, bold);

  text(page, "This is a computer-generated document and needs no signature.", 50, 60, 8, regular);
  return doc.save();
}

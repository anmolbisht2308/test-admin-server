import { PDFDocument } from "pdf-lib";
import { extractText, getDocumentProxy } from "unpdf";

export const SCAN_MESSAGE = "This PDF is a scan — add GEMINI_API_KEY";

/** Text layer per page (lines separated by "\n"). */
export async function extractPages(pdf: Uint8Array): Promise<string[]> {
  // pdf.js takes ownership of (detaches) the buffer it is given; pass a copy.
  const doc = await getDocumentProxy(pdf.slice());
  const { text } = await extractText(doc, { mergePages: false });
  return text;
}

/** Almost no text layer: fewer than ~40 letters per page on average. */
export function looksScanned(pages: string[]): boolean {
  if (pages.length === 0) return true;
  const letters = pages.join("").match(/\p{L}/gu)?.length ?? 0;
  return letters / pages.length < 40;
}

export async function pageCount(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: true });
  return doc.getPageCount();
}

export interface PdfChunk {
  /** 1-based first page of the chunk in the original PDF. */
  firstPage: number;
  lastPage: number;
  bytes: Uint8Array;
}

/** Splits a PDF into chunks of `size` pages where each chunk repeats the previous chunk's last page. */
export async function splitPdf(pdf: Uint8Array, size: number): Promise<PdfChunk[]> {
  const source = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const total = source.getPageCount();
  if (total <= size) return [{ firstPage: 1, lastPage: total, bytes: pdf }];
  const chunks: PdfChunk[] = [];
  const step = Math.max(1, size - 1);
  for (let start = 0; start < total; start += step) {
    const end = Math.min(total, start + size);
    const out = await PDFDocument.create();
    const pages = await out.copyPages(
      source,
      Array.from({ length: end - start }, (_, i) => start + i),
    );
    pages.forEach((p) => out.addPage(p));
    chunks.push({ firstPage: start + 1, lastPage: end, bytes: await out.save() });
    if (end === total) break;
  }
  return chunks;
}

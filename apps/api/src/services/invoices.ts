import { InvoiceModel, renderInvoicePdf, type SellerInfo } from "@mockprep/core";
import type { Response } from "express";
import type { Types } from "mongoose";
import type { Env } from "../env.js";
import { notFoundError } from "../lib/httpError.js";

export const sellerFromEnv = (env: Env): SellerInfo => ({
  name: env.SELLER_NAME,
  address: env.SELLER_ADDRESS,
  gstin: env.SELLER_GSTIN,
  state: env.SELLER_STATE,
  email: env.SELLER_EMAIL,
});

/** Streams an order's invoice or credit note as a PDF (rendered on demand: a few ms). */
export async function sendInvoicePdf(
  res: Response,
  env: Env,
  orderId: Types.ObjectId,
  kind: "invoice" | "credit_note",
) {
  const invoice = await InvoiceModel.findOne({ orderId, kind }).lean();
  if (!invoice) throw notFoundError(kind === "invoice" ? "Invoice" : "Credit note");
  const original = invoice.invoiceId
    ? await InvoiceModel.findById(invoice.invoiceId).select({ number: 1 }).lean()
    : null;
  const pdf = await renderInvoicePdf(
    { ...invoice, originalNumber: original?.number ?? null },
    sellerFromEnv(env),
  );
  res
    .status(200)
    .set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoice.number.replace(/\//g, "-")}.pdf"`,
      "Cache-Control": "private, no-store",
    })
    .send(Buffer.from(pdf));
}

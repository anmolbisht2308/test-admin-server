import {
  InvoiceModel,
  formatRupees,
  renderInvoicePdf,
  type EmailSender,
  type SellerInfo,
} from "@mockprep/core";
import { invoiceJobDataSchema } from "@mockprep/types";
import type { Job } from "bullmq";
import type { Logger } from "pino";

export interface InvoiceOptions {
  email: EmailSender;
  seller: SellerInfo;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "invoice" queue: emails an invoice / credit note PDF once (emailedAt marks it done). */
export function createInvoiceProcessor({ email, seller }: InvoiceOptions, logger: Logger) {
  return async (job: Job) => {
    const { invoiceId } = invoiceJobDataSchema.parse(job.data);
    const invoice = await InvoiceModel.findById(invoiceId).lean();
    if (!invoice || invoice.emailedAt) return;
    if (!invoice.customer.email) {
      // Phone-only student: the PDF is still downloadable from "My purchases".
      logger.info({ invoiceId }, "no email address: invoice not emailed");
      return;
    }
    const original = invoice.invoiceId
      ? await InvoiceModel.findById(invoice.invoiceId).select({ number: 1 }).lean()
      : null;
    const pdf = await renderInvoicePdf(
      { ...invoice, originalNumber: original?.number ?? null },
      seller,
    );
    const isInvoice = invoice.kind === "invoice";
    const what = isInvoice ? "Invoice" : "Credit note";
    const name = invoice.customer.name || "there";
    const text = isInvoice
      ? `Hi ${name}, thank you for your purchase: ${invoice.description}. Amount paid: ${formatRupees(invoice.amountPaise)} (incl. GST). Your invoice ${invoice.number} is attached.`
      : `Hi ${name}, your refund of ${formatRupees(invoice.amountPaise)} has been processed. Credit note ${invoice.number} is attached. Refunds reach your account in 5–7 working days.`;
    await email.send({
      to: invoice.customer.email,
      subject: `${seller.name}: ${what} ${invoice.number}`,
      text,
      html: `<p>${escapeHtml(text)}</p>`,
      attachments: [{ name: `${invoice.number.replace(/\//g, "-")}.pdf`, content: pdf }],
    });
    await InvoiceModel.updateOne({ _id: invoice._id }, { $set: { emailedAt: new Date() } });
    logger.info({ invoiceId, number: invoice.number }, "invoice emailed");
  };
}

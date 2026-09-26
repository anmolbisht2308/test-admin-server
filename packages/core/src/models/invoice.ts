import { Schema, model, type Types } from "mongoose";

/** GST invoice (paid order) or credit note (refund). Numbers are sequential per financial year. */
export interface InvoiceAttrs {
  kind: "invoice" | "credit_note";
  number: string;
  orderId: Types.ObjectId;
  userId: Types.ObjectId;
  /** Credit notes point at the invoice they cancel. */
  invoiceId: Types.ObjectId | null;
  date: Date;
  description: string;
  amountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  customer: { name: string; email: string; phone: string };
  emailedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const invoiceSchema = new Schema<InvoiceAttrs>(
  {
    kind: { type: String, required: true },
    number: { type: String, required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", default: null },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    amountPaise: Number,
    taxablePaise: Number,
    cgstPaise: Number,
    sgstPaise: Number,
    igstPaise: Number,
    customer: { name: String, email: String, phone: String },
    emailedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
// One invoice and at most one credit note per order.
invoiceSchema.index({ orderId: 1, kind: 1 }, { unique: true });

export const InvoiceModel = model<InvoiceAttrs>("Invoice", invoiceSchema, "invoices");

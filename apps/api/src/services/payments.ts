import {
  OrderModel,
  ProcessedEventModel,
  completeRefund,
  failOrder,
  fulfilOrder,
  inTransaction,
  type PaymentsConfig,
} from "@mockprep/core";
import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { HttpError } from "../lib/httpError.js";
import type { EnqueueInvoice } from "./invoiceQueue.js";
import type { PaymentGateway } from "./paymentGateway.js";

/** The parts of Razorpay webhook payloads we use (the rest is ignored). */
const webhookSchema = z.object({
  event: z.string(),
  created_at: z.number().optional(),
  payload: z
    .object({
      payment: z
        .object({
          entity: z.object({
            id: z.string(),
            order_id: z.string().nullable().optional(),
            amount: z.number().int(),
            status: z.string().optional(),
          }),
        })
        .optional(),
      refund: z
        .object({
          entity: z.object({
            id: z.string(),
            payment_id: z.string(),
            amount: z.number().int(),
          }),
        })
        .optional(),
    })
    .default({}),
});
export type RazorpayWebhook = z.infer<typeof webhookSchema>;

export type WebhookOutcome = "processed" | "duplicate" | "ignored";

const isDuplicateKey = (err: unknown) => (err as { code?: number }).code === 11000;

export function createPaymentsService(deps: {
  gateway: PaymentGateway | null;
  config: PaymentsConfig;
  enqueueInvoice: EnqueueInvoice;
  logger: Logger;
}) {
  const { gateway, config, enqueueInvoice, logger } = deps;

  /** Queues an email; a Redis hiccup must never fail a payment that already went through. */
  async function queueEmail(invoiceId: string | null) {
    if (!invoiceId) return;
    await enqueueInvoice(invoiceId).catch((err: unknown) =>
      logger.error({ err, invoiceId }, "could not queue invoice email"),
    );
  }

  /** Payment succeeded (verify or free order): paid + access + invoice, exactly once. */
  async function fulfil(orderId: string, paymentId: string | null) {
    const result = await inTransaction((session) =>
      fulfilOrder(orderId, { paymentId }, config, session),
    );
    if (result.changed) await queueEmail(result.invoiceId);
    return result;
  }

  /** Refund done at the provider: revoke access + credit note, exactly once. */
  async function refunded(orderId: string, refundId: string | null, reason?: string) {
    const result = await inTransaction((session) =>
      completeRefund(
        orderId,
        { refundId, ...(reason === undefined ? {} : { reason }) },
        config,
        session,
      ),
    );
    if (result.changed) await queueEmail(result.creditNoteId);
    return result;
  }

  /**
   * Razorpay webhook — the source of truth (it arrives even if the student closed the browser).
   * Signature checked on the raw body; the event id is stored in the same transaction as the
   * order change, so a replay (or Razorpay's retries) is a no-op.
   */
  async function handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<WebhookOutcome> {
    if (!gateway) throw new HttpError(503, "Payments are not enabled");
    if (!signature || !gateway.verifyWebhookSignature(rawBody, signature)) {
      throw new HttpError(400, "Invalid webhook signature");
    }
    let json: unknown;
    try {
      json = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid webhook body");
    }
    const event = webhookSchema.parse(json);
    const eventId = eventIdHeader || createHash("sha256").update(rawBody).digest("hex");
    const payment = event.payload.payment?.entity;
    const refund = event.payload.refund?.entity;
    let invoiceId: string | null = null;

    try {
      const outcome = await inTransaction(async (session): Promise<WebhookOutcome> => {
        invoiceId = null;
        await ProcessedEventModel.create([{ _id: eventId, type: event.event }], { session });

        if (event.event === "payment.captured" && payment?.order_id) {
          const order = await OrderModel.findOne({ razorpayOrderId: payment.order_id })
            .session(session)
            .lean();
          if (!order) return "ignored";
          if (payment.amount !== order.amountPaise) {
            // Never grant access for a different amount than the server priced.
            logger.error(
              { orderId: order._id, paid: payment.amount, expected: order.amountPaise },
              "captured amount does not match the order",
            );
            return "ignored";
          }
          const r = await fulfilOrder(order._id, { paymentId: payment.id }, config, session);
          invoiceId = r.invoiceId;
          return r.changed ? "processed" : "ignored";
        }

        if (event.event === "payment.failed" && payment?.order_id) {
          const order = await OrderModel.findOne({ razorpayOrderId: payment.order_id })
            .session(session)
            .lean();
          if (!order) return "ignored";
          return (await failOrder(order._id, session)) ? "processed" : "ignored";
        }

        if (event.event === "refund.processed" && refund) {
          const order = await OrderModel.findOne({ razorpayPaymentId: refund.payment_id })
            .session(session)
            .lean();
          if (!order) return "ignored";
          if (refund.amount < order.amountPaise) {
            // Partial refunds (dashboard) keep access; only a full refund revokes it.
            logger.warn({ orderId: order._id, amount: refund.amount }, "partial refund");
            return "ignored";
          }
          const r = await completeRefund(
            order._id,
            { refundId: refund.id, reason: "Refunded via Razorpay" },
            config,
            session,
          );
          invoiceId = r.creditNoteId;
          return r.changed ? "processed" : "ignored";
        }
        return "ignored";
      });
      await queueEmail(invoiceId);
      return outcome;
    } catch (err) {
      if (isDuplicateKey(err) && (await ProcessedEventModel.exists({ _id: eventId }))) {
        return "duplicate";
      }
      throw err;
    }
  }

  return { gateway, config, fulfil, refunded, handleWebhook };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;

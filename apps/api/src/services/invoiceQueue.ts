import { QUEUE, type InvoiceJobData } from "@mockprep/types";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

/** Queues emailing an invoice or credit note PDF (processed by the worker). */
export type EnqueueInvoice = (invoiceId: string) => Promise<void>;

export function createInvoiceEnqueuer(redis: Redis): EnqueueInvoice {
  let queue: Queue<InvoiceJobData> | undefined;
  return async (invoiceId) => {
    queue ??= new Queue<InvoiceJobData>(QUEUE.invoice, { connection: redis });
    await queue.add(
      "invoice",
      { invoiceId },
      {
        jobId: `invoice-${invoiceId}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
  };
}

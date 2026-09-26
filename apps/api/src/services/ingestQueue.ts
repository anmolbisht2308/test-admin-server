import { QUEUE, ingestJobId, type IngestJobData } from "@mockprep/types";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { EnqueueIngest } from "../routes/admin/uploads.js";

/** Producer for the worker's "ingest" queue. The queue is created on first use. */
export function createIngestEnqueuer(redis: Redis): EnqueueIngest {
  let queue: Queue<IngestJobData> | undefined;
  return async (uploadId, run) => {
    queue ??= new Queue<IngestJobData>(QUEUE.ingest, { connection: redis });
    await queue.add(
      "ingest",
      { uploadId },
      // One attempt: the pipeline records its own failure on the upload; retry is a new run.
      { jobId: ingestJobId(uploadId, run), attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
    );
  };
}

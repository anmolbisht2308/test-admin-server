import { ingestJobDataSchema } from "@mockprep/types";
import type { Job } from "bullmq";
import { runIngest, type IngestDeps } from "../ingest/pipeline.js";

/** Processor for the "ingest" queue: one job = one upload run. */
export function createIngestProcessor(deps: IngestDeps) {
  return async (job: Job) => {
    const { uploadId } = ingestJobDataSchema.parse(job.data);
    await runIngest(uploadId, deps);
  };
}

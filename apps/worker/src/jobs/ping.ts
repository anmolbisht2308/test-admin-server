import { pingJobDataSchema, type PingJobResult } from "@mockprep/types";
import type { Job } from "bullmq";
import type { Logger } from "pino";

/** Liveness job: proves the api → Redis → worker path works end to end. */
export function createPingProcessor(logger: Logger, now: () => number = Date.now) {
  return async (job: Job<unknown>): Promise<PingJobResult> => {
    const data = pingJobDataSchema.parse(job.data);
    const latencyMs = Math.max(0, now() - Date.parse(data.requestedAt));
    logger.info({ jobId: job.id, source: data.source, latencyMs }, "pong");
    return Promise.resolve({ pong: true, latencyMs });
  };
}

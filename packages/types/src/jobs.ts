import { z } from "zod";

/** BullMQ queue names shared by the api (producer) and worker (consumer). */
export const QUEUE = {
  ping: "ping",
  ingest: "ingest",
  /** Scores a submitted attempt. */
  score: "score",
  /** Repeating housekeeping: flush Redis answers to Mongo, auto-submit expired attempts. */
  attempts: "attempts",
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const pingJobDataSchema = z.object({
  requestedAt: z.iso.datetime(),
  source: z.string().min(1),
});
export type PingJobData = z.infer<typeof pingJobDataSchema>;

export const pingJobResultSchema = z.object({
  pong: z.literal(true),
  latencyMs: z.number().int().nonnegative(),
});
export type PingJobResult = z.infer<typeof pingJobResultSchema>;

/** One upload = one ingest job. */
export const ingestJobDataSchema = z.object({ uploadId: z.string().regex(/^[a-f\d]{24}$/i) });
export type IngestJobData = z.infer<typeof ingestJobDataSchema>;

/**
 * Job id for an upload's run: re-queueing the same run (e.g. on worker start) never duplicates it,
 * while a retry (next run) always gets a fresh job.
 */
export const ingestJobId = (uploadId: string, run: number) => `ingest-${uploadId}-${run}`;

export const scoreJobDataSchema = z.object({ attemptId: z.string().regex(/^[a-f\d]{24}$/i) });
export type ScoreJobData = z.infer<typeof scoreJobDataSchema>;

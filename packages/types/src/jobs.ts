import { z } from "zod";

/** BullMQ queue names shared by the api (producer) and worker (consumer). */
export const QUEUE = {
  ping: "ping",
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

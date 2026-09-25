import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
});

export type Env = z.infer<typeof envSchema>;

/** Parse env or throw an Error listing every invalid variable. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(
      `Invalid environment variables:\n${lines.join("\n")}\nSee apps/worker/.env.example.`,
    );
  }
  return result.data;
}

export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

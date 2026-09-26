import { z } from "zod";

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),

  // ----- PDF ingest (off when MONGODB_URI is not set) -----
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// URL")
    .optional(),
  /** Same storage settings as the api: the worker reads the uploaded papers from there. */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  /** local driver: the api's upload directory (relative to this app when run locally). */
  LOCAL_UPLOAD_DIR: z.string().default("../api/uploads"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.url().optional(),
  S3_ENDPOINT: z.url().optional(),
  /** Google AI Studio key. Empty = free text parser (text PDFs only, no scans or image keys). */
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-flash-latest"),
  /** Pages per AI request (chunks overlap by one page). */
  CHUNK_PAGES: z.coerce.number().int().min(2).max(30).default(6),
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

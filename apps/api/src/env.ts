import { readFileSync } from "node:fs";
import { z } from "zod";

const commaList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url()).min(1, "at least one origin is required"));

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// or mongodb+srv:// URI"),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
  CORS_ORIGINS: commaList,
  TRUST_PROXY: z.coerce.number().int().nonnegative().default(0),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  APP_VERSION: z.string().optional(),
  RENDER_GIT_COMMIT: z.string().optional(),
});

export type Env = z.infer<typeof envSchema> & { version: string };

function packageVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Parse env or throw an Error listing every invalid variable. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  // Treat empty strings (e.g. `APP_VERSION=` in .env) as unset.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(
      `Invalid environment variables:\n${lines.join("\n")}\nSee apps/api/.env.example.`,
    );
  }
  const data = result.data;
  const version = data.APP_VERSION ?? data.RENDER_GIT_COMMIT?.slice(0, 7) ?? packageVersion();
  return { ...data, version };
}

/** Load env for the running process; exits with a clear message when invalid. */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
}

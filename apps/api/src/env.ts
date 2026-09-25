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

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const optionalCommaList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
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

    // ----- auth -----
    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    /** Encrypts admin TOTP secrets at rest (any string >= 32 chars; hashed to an AES-256 key). */
    TOTP_ENCRYPTION_KEY: z.string().min(32, "must be at least 32 characters"),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(900),
    STUDENT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(30),
    ADMIN_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).default(7),
    STUDENT_MAX_DEVICES: z.coerce.number().int().min(1).default(2),
    /** Defaults to true in production. Set false only for local http. */
    COOKIE_SECURE: bool.optional(),
    ADMIN_TOTP_ISSUER: z.string().default("mockprep"),
    OTP_PROVIDER: z.enum(["console", "msg91"]).default("console"),
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_TEMPLATE_ID: z.string().optional(),
    /** OAuth client ids accepted as the Google ID token audience. Empty = Google sign-in off. */
    GOOGLE_CLIENT_IDS: optionalCommaList,
  })
  .superRefine((env, ctx) => {
    if (env.OTP_PROVIDER === "msg91") {
      for (const key of ["MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID"] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when OTP_PROVIDER=msg91",
          });
      }
    }
  });

export type Env = Omit<z.infer<typeof envSchema>, "COOKIE_SECURE"> & {
  COOKIE_SECURE: boolean;
  version: string;
};

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
  return { ...data, COOKIE_SECURE: data.COOKIE_SECURE ?? data.NODE_ENV === "production", version };
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

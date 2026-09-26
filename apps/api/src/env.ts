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

    // ----- email (sign-in codes now; invoices/notifications later) -----
    /** console = emails only in the api log (dev). brevo = real email (free tier). */
    EMAIL_PROVIDER: z.enum(["console", "brevo"]).default("console"),
    BREVO_API_KEY: z.string().optional(),
    /** Verified sender address in Brevo, e.g. no-reply@yourdomain.com or your Gmail. */
    EMAIL_FROM: z.email().optional(),
    EMAIL_FROM_NAME: z.string().default("mockprep"),

    // ----- file storage (question figures) -----
    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    /** local driver: directory for uploaded files (served at /api/files/*). */
    LOCAL_UPLOAD_DIR: z.string().default("./uploads"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    /** Public base URL for files (bucket URL or CloudFront), no trailing slash. */
    S3_PUBLIC_BASE_URL: z.url().optional(),
    /** S3-compatible endpoint, e.g. Cloudflare R2: https://<account-id>.r2.cloudflarestorage.com */
    S3_ENDPOINT: z.url().optional(),

    // ----- PDF → test pipeline (the worker reads the same variables) -----
    /** Google AI Studio key (free tier). Empty = the free text parser (no scans / image keys). */
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-flash-latest"),
    /** Pages per AI request; chunks overlap by one page. */
    CHUNK_PAGES: z.coerce.number().int().min(2).max(30).default(6),

    // ----- payments (Razorpay) -----
    /** none = checkout off; fake = local stand-in (never in production); razorpay = real. */
    PAYMENTS_PROVIDER: z.enum(["none", "fake", "razorpay"]).optional(),
    /** Public key id (test keys start rzp_test_). */
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    /** Secret set on the webhook in the Razorpay dashboard. */
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    /** Invoice numbers: <prefix>/<FY>/000001, credit notes <prefix>/CN/<FY>/000001. */
    INVOICE_PREFIX: z
      .string()
      .regex(/^[A-Z0-9]{1,8}$/)
      .default("MP"),
    SELLER_NAME: z.string().default("mockprep"),
    SELLER_ADDRESS: z.string().default(""),
    /** Empty until GST registration (invoices then say "Not registered"). */
    SELLER_GSTIN: z.string().default(""),
    SELLER_STATE: z.string().default(""),
    SELLER_EMAIL: z.string().default(""),

    // ----- free-hosting switches (single Render free web service) -----
    /** Run the BullMQ workers inside this process instead of a separate worker service. */
    RUN_WORKER_IN_API: bool.default(false),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
    /** Seed templates/exams/first admin at startup (for hosts without a pre-deploy step). */
    SEED_ON_START: bool.default(false),
    SEED_ADMIN_EMAIL: z.email().optional(),
    SEED_ADMIN_PASSWORD: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.EMAIL_PROVIDER === "brevo") {
      for (const key of ["BREVO_API_KEY", "EMAIL_FROM"] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when EMAIL_PROVIDER=brevo",
          });
      }
    }
    if (env.STORAGE_DRIVER === "s3") {
      for (const key of ["S3_BUCKET", "S3_REGION", "S3_PUBLIC_BASE_URL"] as const) {
        if (!env[key])
          ctx.addIssue({ code: "custom", path: [key], message: "required when STORAGE_DRIVER=s3" });
      }
    }
    if (env.PAYMENTS_PROVIDER === "razorpay") {
      for (const key of [
        "RAZORPAY_KEY_ID",
        "RAZORPAY_KEY_SECRET",
        "RAZORPAY_WEBHOOK_SECRET",
      ] as const) {
        if (!env[key])
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "required when PAYMENTS_PROVIDER=razorpay",
          });
      }
    }
    if (env.PAYMENTS_PROVIDER === "fake" && env.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENTS_PROVIDER"],
        message: "fake payments are not allowed in production",
      });
    }
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

export type Env = Omit<z.infer<typeof envSchema>, "COOKIE_SECURE" | "PAYMENTS_PROVIDER"> & {
  COOKIE_SECURE: boolean;
  PAYMENTS_PROVIDER: "none" | "fake" | "razorpay";
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
  return {
    ...data,
    COOKIE_SECURE: data.COOKIE_SECURE ?? data.NODE_ENV === "production",
    PAYMENTS_PROVIDER: data.PAYMENTS_PROVIDER ?? (data.NODE_ENV === "production" ? "none" : "fake"),
    version,
  };
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

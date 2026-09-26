/**
 * Seeds exam templates + exams (upsert by key/slug, so it is safe to re-run) and, when
 * SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD are set, a superadmin (created only if missing).
 * Run: pnpm --filter @mockprep/api seed
 */
import mongoose from "mongoose";
import { z } from "zod";
import { connectMongo } from "../db.js";
import { createLogger } from "../logger.js";
import { SEED_EXAMS, SEED_TEMPLATES } from "./seed-data.js";
import { seedAdmin, seedCatalogue } from "./seedCatalogue.js";

const env = z
  .object({
    MONGODB_URI: z.string().min(1),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    SEED_ADMIN_EMAIL: z.email().optional().or(z.literal("")),
    SEED_ADMIN_PASSWORD: z.string().optional(),
  })
  .parse(process.env);

const logger = createLogger({ LOG_LEVEL: env.LOG_LEVEL, NODE_ENV: "production" });

async function main() {
  await connectMongo(env.MONGODB_URI, logger, { maxAttempts: 5 });
  await mongoose.connection.syncIndexes();
  await seedCatalogue();
  logger.info(
    { templates: SEED_TEMPLATES.length, exams: SEED_EXAMS.length },
    "catalogue seeded (existing entries untouched)",
  );

  if (env.SEED_ADMIN_EMAIL && env.SEED_ADMIN_PASSWORD) {
    await seedAdmin(env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD, logger);
  }
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "seed failed");
  await mongoose.disconnect();
  process.exit(1);
});

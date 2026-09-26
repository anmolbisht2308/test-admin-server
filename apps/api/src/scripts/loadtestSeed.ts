/**
 * Load-test fixtures (never run against production): a published 100-question SBI PO test and
 * N students, each with an attempt in progress and an access token. Writes loadtest/data.json
 * for loadtest/save-answers.js (k6).
 *
 *   MONGODB_URI=… REDIS_URL=… JWT_SECRET=… LOADTEST_STUDENTS=1000 pnpm --filter @mockprep/api loadtest:seed
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AttemptModel,
  ExamTemplateModel,
  QuestionModel,
  TestModel,
  UserModel,
  connectMongo,
  initialTiming,
  metaFor,
  questionHash,
  toTemplateSnapshot,
  writeMeta,
} from "@mockprep/core";
import { Redis } from "ioredis";
import mongoose, { Types } from "mongoose";
import { pino } from "pino";
import { createTokenService } from "../lib/tokens.js";
import { seedCatalogue } from "./seedCatalogue.js";

const logger = pino({ level: "info" });
const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.NODE_ENV === "production")
  throw new Error("Refusing to seed load-test data in production");
const students = Number(env("LOADTEST_STUDENTS", "1000"));
const out = path.resolve(
  env("LOADTEST_OUT", path.join(import.meta.dirname, "../../../../loadtest/data.json")),
);

await connectMongo(env("MONGODB_URI"), logger, { maxAttempts: 3 });
const redis = new Redis(env("REDIS_URL"));
const tokens = createTokenService(env("JWT_SECRET"), 4 * 3600);
await seedCatalogue();

const template = await ExamTemplateModel.findOne({ key: "sbi-po-prelims" }).lean();
if (!template) throw new Error("sbi-po-prelims template missing");
const snapshot = toTemplateSnapshot(template);

const questionDocs = snapshot.sections.flatMap((s) =>
  Array.from({ length: s.count }, (_, i) => {
    const _id = new Types.ObjectId();
    const stem = `Load test ${s.name} question ${i + 1} (${_id.toString()})`;
    const options = ["A", "B", "C", "D", "E"].map((o) => `${o} ${i}`);
    return {
      _id,
      rootId: _id,
      examKey: "sbi-po",
      examFamily: "banking",
      section: s.name,
      type: "mcq_single",
      stem,
      options,
      correct: [i % 5],
      status: "approved",
      hash: questionHash({ stem, stemHi: "", options, optionsHi: [] }),
    };
  }),
);
await QuestionModel.insertMany(questionDocs);
let cursor = 0;
const test = await TestModel.create({
  title: `Load test ${new Date().toISOString()}`,
  examKey: "sbi-po",
  type: "full",
  isFree: true,
  status: "published",
  publishedAt: new Date(),
  templateSnapshot: snapshot,
  sections: snapshot.sections.map((s) => {
    const ids = questionDocs.slice(cursor, cursor + s.count).map((q) => q._id);
    cursor += s.count;
    return { name: s.name, ...(s.timeSec ? { timeSec: s.timeSec } : {}), questionIds: ids };
  }),
});

const rows = [];
for (let i = 0; i < students; i++) {
  const user = await UserModel.create({
    role: "student",
    phone: `+9170${String(i).padStart(8, "0")}`,
    name: `Load ${i}`,
  });
  const now = Date.now();
  const timing = initialTiming(test, now);
  const attempt = await AttemptModel.create({
    userId: user._id,
    testId: test._id,
    startedAt: new Date(now),
    deadline: new Date(timing.deadline),
    sectionIndex: 0,
    sectionDeadline: timing.sectionDeadline === null ? null : new Date(timing.sectionDeadline),
  });
  await writeMeta(redis, attempt.id, metaFor(attempt, test));
  rows.push({
    attemptId: attempt.id,
    token: await tokens.signAccess({
      userId: user.id,
      role: "student",
      sessionId: new Types.ObjectId().toString(),
    }),
  });
}

// Section 1 is the one open in a locked test: save answers there.
const openQuestions = test.sections[0]?.questionIds.map(String) ?? [];
await writeFile(
  out,
  JSON.stringify({ testId: test.id, questionIds: openQuestions, students: rows }),
);
logger.info({ out, students, testId: test.id }, "load-test data written");
await mongoose.disconnect();
redis.disconnect();

import { STATS_MIN_ATTEMPTS, SUSPECT_ACCURACY } from "@mockprep/types";
import { Types } from "mongoose";
import { AttemptModel } from "./models/attempt.js";
import { QuestionModel } from "./models/question.js";
import { QuestionStatsModel } from "./models/questionStats.js";

interface Acc {
  attempts: number;
  correct: number;
  skipped: number;
  timeMs: number;
  split: number[];
  upper: { correct: number; total: number };
  lower: { correct: number; total: number };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Per-question statistics over every ranked (first, non-practice) scored attempt: attempts,
 * accuracy, average time, option split and discrimination (accuracy of each test's top 27 %
 * minus its bottom 27 %). Flags "suspect_key" when accuracy < 5 % or a wrong option beats the
 * key, with enough attempts. Run nightly by the worker.
 */
export async function computeQuestionStats(now = new Date()) {
  const acc = new Map<string, Acc>();
  const get = (id: string) => {
    let a = acc.get(id);
    if (!a) {
      a = {
        attempts: 0,
        correct: 0,
        skipped: 0,
        timeMs: 0,
        split: [],
        upper: { correct: 0, total: 0 },
        lower: { correct: 0, total: 0 },
      };
      acc.set(id, a);
    }
    return a;
  };

  const testIds = await AttemptModel.distinct("testId", {
    status: "scored",
    firstAttempt: true,
    practice: false,
  });
  for (const testId of testIds) {
    const attempts = await AttemptModel.find({
      testId,
      status: "scored",
      firstAttempt: true,
      practice: false,
    })
      .select({ answers: 1, outcomes: 1, "result.score": 1 })
      .sort({ "result.score": -1 })
      .lean();
    const group = Math.floor(attempts.length * 0.27);
    attempts.forEach((attempt, index) => {
      const band = index < group ? "upper" : index >= attempts.length - group ? "lower" : null;
      const responses = new Map(attempt.answers.map((x) => [x.questionId.toString(), x.response]));
      for (const o of attempt.outcomes) {
        const a = get(o.questionId.toString());
        const right = o.outcome === "correct";
        if (o.outcome === "skipped") {
          a.skipped += 1;
        } else {
          a.attempts += 1;
          a.timeMs += o.timeMs;
          if (right) a.correct += 1;
          const response = responses.get(o.questionId.toString());
          if (Array.isArray(response)) {
            for (const i of response) a.split[i] = (a.split[i] ?? 0) + 1;
          }
        }
        if (band) {
          a[band].total += 1;
          if (right) a[band].correct += 1;
        }
      }
    });
  }

  const ids = [...acc.keys()].map((id) => new Types.ObjectId(id));
  const questions = await QuestionModel.find({ _id: { $in: ids } })
    .select({ type: 1, correct: 1, options: 1, flags: 1 })
    .lean();
  let flagged = 0;
  const statsOps = [];
  const flagOps = [];
  for (const q of questions) {
    const a = acc.get(q._id.toString());
    if (!a) continue;
    const split = q.options.map((_, i) => a.split[i] ?? 0);
    const accuracy = a.attempts ? round2((a.correct / a.attempts) * 100) : 0;
    const discrimination =
      a.upper.total >= 5 && a.lower.total >= 5
        ? round2(a.upper.correct / a.upper.total - a.lower.correct / a.lower.total)
        : null;
    statsOps.push({
      updateOne: {
        filter: { questionId: q._id },
        update: {
          $set: {
            attempts: a.attempts,
            correct: a.correct,
            accuracy,
            avgTimeMs: a.attempts ? Math.round(a.timeMs / a.attempts) : 0,
            optionSplit: split,
            skipped: a.skipped,
            discrimination,
            computedAt: now,
          },
        },
        upsert: true,
      },
    });
    const keyChosen =
      q.type === "mcq_single" ? Math.max(0, ...q.correct.map((c) => split[c] ?? 0)) : 0;
    const distractorBeatsKey =
      q.type === "mcq_single" &&
      split.some((count, i) => !q.correct.includes(i) && count > keyChosen);
    const suspect =
      a.attempts >= STATS_MIN_ATTEMPTS && (accuracy < SUSPECT_ACCURACY || distractorBeatsKey);
    const has = q.flags.includes("suspect_key");
    if (suspect !== has) {
      if (suspect) flagged += 1;
      flagOps.push({
        updateOne: {
          filter: { _id: q._id },
          update: suspect
            ? { $addToSet: { flags: "suspect_key" } }
            : { $pull: { flags: "suspect_key" } },
        },
      });
    }
  }
  if (statsOps.length) await QuestionStatsModel.bulkWrite(statsOps);
  if (flagOps.length) await QuestionModel.bulkWrite(flagOps);
  return { questions: statsOps.length, flagged };
}

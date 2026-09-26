import type {
  AttemptAnalysis,
  AttemptRank,
  AttemptResult,
  Benchmark,
  QuestionType,
  TopicAnalysis,
} from "@mockprep/types";
import { Types } from "mongoose";
import { AttemptModel } from "./models/attempt.js";
import type { QuestionOutcome } from "./scoring.js";

const round2 = (n: number) => Math.round(n * 100) / 100;
const MIN_TOPIC_QUESTIONS = 3;

export interface AnalysisInput {
  attemptId: string;
  title: string;
  practice: boolean;
  result: AttemptResult;
  outcomes: { questionId: string; outcome: QuestionOutcome; marks: number; timeMs: number }[];
  /** Test sections in order (question numbering restarts per section). */
  sections: { name: string; questionIds: string[] }[];
  questions: Map<string, { topic: string; subject: string; type: QuestionType }>;
  cutoffs: { overall: number | null; sections: Record<string, number> };
  rank: AttemptRank | null;
  topper: Benchmark | null;
  average: Benchmark | null;
}

export const benchmarkFrom = (r: AttemptResult): Benchmark => ({
  score: r.score,
  accuracy: r.accuracy,
  timeSec: r.timeTakenSec,
  sections: r.sections.map((s) => ({ name: s.name, score: s.score })),
});

/** Sentence of advice from the numbers: cut-off gap, negative marking, weak topic, skips. */
export function adviceFor(
  a: Pick<AttemptAnalysis, "sections" | "topics" | "weak" | "cutoff" | "score" | "questions">,
): string {
  if (a.cutoff.overall !== null && a.cutoff.cleared === false) {
    const gap = round2(a.cutoff.overall - a.score);
    return `You are ${gap} mark${gap === 1 ? "" : "s"} short of the expected cut-off (${a.cutoff.overall}).`;
  }
  const worstNegative = [...a.sections].sort((x, y) => y.negativeMarks - x.negativeMarks)[0];
  if (worstNegative && worstNegative.negativeMarks >= 2) {
    return `You lost ${round2(worstNegative.negativeMarks)} marks to negative marking in ${worstNegative.name}: attempt only the questions you are sure of there.`;
  }
  const weak = a.topics.find((t) => t.topic === a.weak[0]);
  if (weak) {
    return `Your weakest topic is ${weak.topic} (${weak.correct} of ${weak.total} right): revise it before the next mock.`;
  }
  const skipped = a.questions.filter((q) => q.outcome === "skipped").length;
  if (a.questions.length > 0 && skipped / a.questions.length > 0.4) {
    return `You left ${skipped} questions unattempted: work on speed so you reach every question.`;
  }
  const attempted = a.questions.length - skipped;
  const correct = a.questions.filter((q) => q.outcome === "correct").length;
  const accuracy = attempted ? Math.round((correct / attempted) * 100) : 0;
  return `Good work: ${accuracy}% accuracy. Keep taking mocks to push your score up.`;
}

export function buildAnalysis(input: AnalysisInput): AttemptAnalysis {
  const outcomeOf = new Map(input.outcomes.map((o) => [o.questionId, o]));
  const questions: AttemptAnalysis["questions"] = [];
  const topicMap = new Map<string, TopicAnalysis>();

  for (const section of input.sections) {
    section.questionIds.forEach((qid, i) => {
      const o = outcomeOf.get(qid);
      if (!o) return; // left out of this attempt (e.g. reported)
      questions.push({
        questionId: qid,
        number: i + 1,
        section: section.name,
        outcome: o.outcome,
        marks: o.marks,
        timeMs: o.timeMs,
      });
      const q = input.questions.get(qid);
      const topic = q?.topic.trim() || q?.subject.trim() || section.name;
      const key = `${section.name}\u0000${topic}`;
      const t = topicMap.get(key) ?? {
        topic,
        section: section.name,
        total: 0,
        correct: 0,
        wrong: 0,
        skipped: 0,
        accuracy: 0,
      };
      t.total += 1;
      if (o.outcome === "correct") t.correct += 1;
      else if (o.outcome === "skipped") t.skipped += 1;
      else t.wrong += 1; // wrong and partial both count against the topic
      topicMap.set(key, t);
    });
  }
  const topics = [...topicMap.values()].map((t) => ({
    ...t,
    accuracy: round2((t.correct / t.total) * 100),
  }));
  const eligible = topics.filter((t) => t.total >= MIN_TOPIC_QUESTIONS);
  const weak = eligible
    .filter((t) => t.accuracy < 50)
    .sort((a, b) => a.accuracy - b.accuracy)
    .map((t) => t.topic);
  const strong = eligible
    .filter((t) => t.accuracy >= 75)
    .sort((a, b) => b.accuracy - a.accuracy)
    .map((t) => t.topic);

  const sections = input.result.sections.map((s) => {
    const inSection = questions.filter((q) => q.section === s.name);
    const attempted = s.correct + s.wrong + s.partial;
    return {
      ...s,
      accuracy: attempted ? round2((s.correct / attempted) * 100) : 0,
      negativeMarks: round2(-inSection.filter((q) => q.marks < 0).reduce((a, q) => a + q.marks, 0)),
      cutoff: input.cutoffs.sections[s.name] ?? null,
    };
  });

  const overall = input.cutoffs.overall;
  const sectionCutsMet = sections.every((s) => s.cutoff === null || s.score >= s.cutoff);
  const cutoff = {
    overall,
    cleared:
      overall === null && sections.every((s) => s.cutoff === null)
        ? null
        : (overall === null || input.result.score >= overall) && sectionCutsMet,
  };

  const base = {
    attemptId: input.attemptId,
    title: input.title,
    score: input.result.score,
    maxScore: input.result.maxScore,
    rank: input.rank,
    sections,
    topics,
    strong: strong.slice(0, 5),
    weak: weak.slice(0, 5),
    you: benchmarkFrom(input.result),
    topper: input.topper,
    average: input.average,
    cutoff,
    questions,
    practice: input.practice,
  };
  return { ...base, advice: adviceFor(base) };
}

/** Topper and average of a test's ranked (first, non-practice) attempts. */
export async function testBenchmarks(
  testId: string,
): Promise<{ topper: Benchmark | null; average: Benchmark | null; count: number }> {
  const match = {
    testId: new Types.ObjectId(testId),
    status: "scored" as const,
    firstAttempt: true,
    practice: false,
  };
  const [top] = await AttemptModel.find(match)
    .sort({ "result.score": -1, "result.timeTakenSec": 1 })
    .limit(1)
    .select({ result: 1 })
    .lean();
  if (!top?.result) return { topper: null, average: null, count: 0 };
  const [avg] = await AttemptModel.aggregate<{
    count: number;
    score: number;
    accuracy: number;
    timeSec: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        score: { $avg: "$result.score" },
        accuracy: { $avg: "$result.accuracy" },
        timeSec: { $avg: "$result.timeTakenSec" },
      },
    },
  ]);
  const sectionAvgs = await AttemptModel.aggregate<{ _id: string; score: number }>([
    { $match: match },
    { $unwind: "$result.sections" },
    { $group: { _id: "$result.sections.name", score: { $avg: "$result.sections.score" } } },
  ]);
  const byName = new Map(sectionAvgs.map((s) => [s._id, s.score]));
  return {
    count: avg?.count ?? 0,
    topper: benchmarkFrom(top.result),
    average: avg
      ? {
          score: round2(avg.score),
          accuracy: round2(avg.accuracy),
          timeSec: Math.round(avg.timeSec),
          sections: top.result.sections.map((s) => ({
            name: s.name,
            score: round2(byName.get(s.name) ?? 0),
          })),
        }
      : null,
  };
}

/** % of a test's ranked attempts that got each question right. */
export async function correctPercentByQuestion(testId: string): Promise<Map<string, number>> {
  const rows = await AttemptModel.aggregate<{
    _id: Types.ObjectId;
    total: number;
    correct: number;
  }>([
    {
      $match: {
        testId: new Types.ObjectId(testId),
        status: "scored",
        firstAttempt: true,
        practice: false,
      },
    },
    { $unwind: "$outcomes" },
    {
      $group: {
        _id: "$outcomes.questionId",
        total: { $sum: 1 },
        correct: { $sum: { $cond: [{ $eq: ["$outcomes.outcome", "correct"] }, 1, 0] } },
      },
    },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), round2((r.correct / r.total) * 100)]));
}

import type { AttemptRank } from "@mockprep/types";
import type { Redis } from "ioredis";
import { Types } from "mongoose";
import { AttemptModel } from "./models/attempt.js";

/*
 * Rank of each test's FIRST attempts (re-attempts and practice are not ranked) in a Redis sorted
 * set `rank:{testId}` (member = attemptId, score = marks). Rebuilt from Mongo when missing.
 */
const rankKey = (testId: string) => `rank:${testId}`;

const rankedFilter = (testId: string) => ({
  testId: new Types.ObjectId(testId),
  status: "scored" as const,
  firstAttempt: true,
  practice: false,
});

export async function addToRanks(redis: Redis, testId: string, attemptId: string, score: number) {
  await redis.zadd(rankKey(testId), score, attemptId);
}

/** Recreates a test's rank set from the scored first attempts in Mongo. */
export async function rebuildRanks(redis: Redis, testId: string): Promise<number> {
  const attempts = await AttemptModel.find(rankedFilter(testId))
    .select({ "result.score": 1 })
    .lean();
  const multi = redis.multi().del(rankKey(testId));
  const members = attempts.flatMap((a) => [a.result?.score ?? 0, a._id.toString()]);
  if (members.length) multi.zadd(rankKey(testId), ...members);
  await multi.exec();
  return attempts.length;
}

/**
 * Rank = 1 + number of first attempts with a higher score (ties share a rank).
 * Percentile = % of first attempts that scored below.
 */
export async function getRank(
  redis: Redis,
  testId: string,
  attemptId: string,
): Promise<AttemptRank | null> {
  let score = await redis.zscore(rankKey(testId), attemptId);
  if (score === null) {
    // Missing set (evicted / Redis restarted) or this attempt not in it: rebuild once.
    const exists = await AttemptModel.exists({ _id: attemptId, ...rankedFilter(testId) });
    if (!exists) return null;
    await rebuildRanks(redis, testId);
    score = await redis.zscore(rankKey(testId), attemptId);
    if (score === null) return null;
  }
  const [total, higher, lower] = await Promise.all([
    redis.zcard(rankKey(testId)),
    redis.zcount(rankKey(testId), `(${score}`, "+inf"),
    redis.zcount(rankKey(testId), "-inf", `(${score}`),
  ]);
  return {
    rank: higher + 1,
    total,
    percentile: total > 0 ? Math.round((lower / total) * 10000) / 100 : 0,
  };
}

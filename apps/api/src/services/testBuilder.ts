import {
  hasAnswer,
  isNumericType,
  selectionRuleSchema,
  type Difficulty,
  type FillReport,
  type TestChecks,
} from "@mockprep/types";
import { Types, type QueryFilter } from "mongoose";
import type { z } from "zod";
import { QuestionModel, type QuestionAttrs } from "@mockprep/core";
import { TaxonomyModel } from "@mockprep/core";
import { TestModel, type TestAttrs } from "@mockprep/core";

type QuestionDoc = QuestionAttrs & { _id: Types.ObjectId };
type Rule = z.output<typeof selectionRuleSchema>;
const DAY_MS = 86_400_000;
const DIFFICULTIES: Difficulty[] = ["easy", "medium", "hard"];

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const allQuestionIds = (test: Pick<TestAttrs, "sections">) =>
  test.sections.flatMap((s) => s.questionIds);

export async function loadQuestions(ids: Types.ObjectId[]): Promise<Map<string, QuestionDoc>> {
  const docs = await QuestionModel.find({ _id: { $in: ids } }).lean();
  return new Map(docs.map((d) => [d._id.toString(), d]));
}

/** Live builder checks; publishing requires `ok`. */
export function computeChecks(
  test: Pick<TestAttrs, "sections" | "templateSnapshot">,
  questions: Map<string, QuestionDoc>,
): TestChecks {
  const template = test.templateSnapshot;
  const sections = test.sections.map((s, i) => ({
    name: s.name,
    expected: template.sections[i]?.count ?? 0,
    actual: s.questionIds.length,
  }));
  const ids = allQuestionIds(test).map(String);
  const missing: string[] = [];
  const missingAnswers: string[] = [];
  const drafts: string[] = [];
  const optionCountMismatch: string[] = [];
  // Same content (hash), versions of one question (rootId) or the same id twice are duplicates.
  const byKey = new Map<string, string[]>();
  const addToGroup = (key: string, id: string) => byKey.set(key, [...(byKey.get(key) ?? []), id]);

  ids.forEach((id) => {
    const q = questions.get(id);
    if (!q) {
      missing.push(id);
      return;
    }
    if (!hasAnswer(q)) missingAnswers.push(id);
    if (q.status !== "approved") drafts.push(id);
    if (!isNumericType(q.type) && q.options.length !== template.optionCount)
      optionCountMismatch.push(id);
    addToGroup(`hash:${q.hash}`, id);
    addToGroup(`root:${q.rootId.toString()}`, id);
  });

  const duplicates = mergeGroups([...byKey.values()].filter((g) => g.length > 1));
  const expected = sections.reduce((acc, s) => acc + s.expected, 0);
  const ok =
    sections.every((s) => s.expected === s.actual) &&
    missing.length === 0 &&
    missingAnswers.length === 0 &&
    drafts.length === 0 &&
    duplicates.length === 0 &&
    optionCountMismatch.length === 0;
  return {
    ok,
    questionCount: { expected, actual: ids.length },
    sections,
    missingAnswers,
    drafts,
    duplicates,
    optionCountMismatch,
    missing,
  };
}

/** Union-find merge of overlapping id groups; a group of one id repeated is reported as [id, id]. */
function mergeGroups(groups: string[][]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  for (const group of groups)
    for (const id of group) parent.set(find(id), find(group[0] as string));
  const merged = new Map<string, Set<string>>();
  for (const group of groups)
    for (const id of group) merged.set(find(id), (merged.get(find(id)) ?? new Set()).add(id));
  return [...merged.values()].map((set) => (set.size === 1 ? [...set, ...set] : [...set]));
}

/** Largest-remainder split of `count` by the mix shares. */
export function splitByMix(
  count: number,
  mix: Record<Difficulty, number>,
): Record<Difficulty, number> {
  const total = DIFFICULTIES.reduce((acc, d) => acc + mix[d], 0);
  const exact = DIFFICULTIES.map((d) => ({ d, value: (count * mix[d]) / total }));
  const result = Object.fromEntries(exact.map(({ d, value }) => [d, Math.floor(value)])) as Record<
    Difficulty,
    number
  >;
  let remaining = count - DIFFICULTIES.reduce((acc, d) => acc + result[d], 0);
  for (const { d } of [...exact].sort((a, b) => (b.value % 1) - (a.value % 1))) {
    if (remaining-- <= 0) break;
    result[d] += 1;
  }
  return result;
}

/** Root ids of questions in tests published within the last `days` days. */
async function recentlyUsedRoots(days: number, now: Date): Promise<Types.ObjectId[]> {
  if (days <= 0) return [];
  const tests = await TestModel.find({
    status: "published",
    publishedAt: { $gte: new Date(now.getTime() - days * DAY_MS) },
  })
    .select({ "sections.questionIds": 1 })
    .lean();
  const ids = tests.flatMap(allQuestionIds);
  return ids.length ? QuestionModel.find({ _id: { $in: ids } }).distinct("rootId") : [];
}

async function sample(filter: QueryFilter<QuestionAttrs>, size: number): Promise<QuestionDoc[]> {
  if (size <= 0) return [];
  // Over-sample, then drop same-hash copies (different documents with identical content).
  return QuestionModel.aggregate<QuestionDoc>([
    { $match: filter },
    { $sample: { size: size * 2 + 5 } },
  ]);
}

/**
 * Fills one section from the bank by rule. Only approved, latest-version questions from the
 * template's family whose section matches the section name or one of its aliases. Never picks a
 * question (or a copy/version of one) that is already in the test.
 */
export async function fillSection(
  test: TestAttrs & { _id: Types.ObjectId },
  index: number,
  rawRule: z.input<typeof selectionRuleSchema>,
  now = new Date(),
): Promise<FillReport> {
  const rule: Rule = selectionRuleSchema.parse(rawRule);
  const section = test.sections[index];
  const templateSection = test.templateSnapshot.sections[index];
  if (!section || !templateSection) throw new Error(`section ${index} does not exist`);
  if (rule.mode === "replace") section.questionIds = [];

  const inTest = await loadQuestions(allQuestionIds(test));
  const excludedRoots = new Set([...inTest.values()].map((q) => q.rootId.toString()));
  const excludedHashes = new Set([...inTest.values()].map((q) => q.hash));
  for (const root of await recentlyUsedRoots(rule.notUsedInLastDays, now))
    excludedRoots.add(root.toString());

  const names = [templateSection.name, ...templateSection.aliases].map(
    (n) => new RegExp(`^${escapeRegex(n)}$`, "i"),
  );
  const base: QueryFilter<QuestionAttrs> = {
    isLatest: true,
    status: "approved",
    examFamily: test.templateSnapshot.family,
    section: { $in: names },
    rootId: { $nin: [...excludedRoots].map((id) => new Types.ObjectId(id)) },
    hash: { $nin: [...excludedHashes] },
  };
  if (rule.topics.length)
    base.topic = { $in: rule.topics.map((t) => new RegExp(`^${escapeRegex(t)}$`, "i")) };
  if (rule.taxonomyIds.length) {
    const nodes = await TaxonomyModel.find({
      $or: rule.taxonomyIds.map((id) => ({ path: { $regex: `/${id}/` } })),
    })
      .select({ _id: 1 })
      .lean();
    base.taxonomyIds = { $in: nodes.map((n) => n._id) };
  }

  const picked: QuestionDoc[] = [];
  const take = (candidates: QuestionDoc[], limit: number) => {
    let added = 0;
    for (const q of candidates) {
      if (added >= limit) break;
      if (excludedHashes.has(q.hash) || excludedRoots.has(q.rootId.toString())) continue;
      picked.push(q);
      excludedHashes.add(q.hash);
      excludedRoots.add(q.rootId.toString());
      added++;
    }
  };

  const targets = rule.difficultyMix ? splitByMix(rule.count, rule.difficultyMix) : null;
  if (targets) {
    for (const d of DIFFICULTIES)
      take(await sample({ ...base, difficulty: d }, targets[d]), targets[d]);
  }
  // Top up from any difficulty if a bucket ran short (or when there is no mix).
  const remaining = rule.count - picked.length;
  if (remaining > 0)
    take(await sample({ ...base, _id: { $nin: picked.map((q) => q._id) } }, remaining), remaining);

  section.questionIds.push(...picked.map((q) => q._id));
  return {
    index,
    name: section.name,
    requested: rule.count,
    added: picked.length,
    shortfall: rule.count - picked.length,
  };
}

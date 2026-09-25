import type {
  Exam,
  ExamTemplate,
  Question,
  Series,
  TaxonomyNode,
  Test,
  User,
} from "@mockprep/types";
import type { Types } from "mongoose";
import type { ExamAttrs } from "../models/exam.js";
import type { ExamTemplateAttrs } from "../models/examTemplate.js";
import type { QuestionAttrs } from "../models/question.js";
import type { SeriesAttrs } from "../models/series.js";
import type { TaxonomyAttrs } from "../models/taxonomy.js";
import type { TestAttrs } from "../models/test.js";
import type { UserAttrs } from "../models/user.js";

type WithId<T> = T & { _id: Types.ObjectId };

/** Converts documents (hydrated or lean) to the API shapes in @mockprep/types. */
export const toUserDto = (u: WithId<UserAttrs>): User => ({
  id: u._id.toString(),
  role: u.role,
  name: u.name ?? null,
  phone: u.phone ?? null,
  email: u.email ?? null,
  language: u.language,
  targetExamSlugs: [...u.targetExamSlugs],
  onboarded: u.onboardedAt !== undefined && u.onboardedAt !== null,
  createdAt: u.createdAt.toISOString(),
});

export const toTemplateDto = (t: WithId<ExamTemplateAttrs>): ExamTemplate => ({
  id: t._id.toString(),
  key: t.key,
  name: t.name,
  family: t.family,
  skin: t.skin,
  totalTimeSec: t.totalTimeSec,
  optionCount: t.optionCount,
  sectionSwitching: t.sectionSwitching,
  sections: t.sections.map((s) => ({
    name: s.name,
    count: s.count,
    ...(s.timeSec === undefined || s.timeSec === null ? {} : { timeSec: s.timeSec }),
    aliases: [...s.aliases],
  })),
  marking: { correct: t.marking.correct, wrong: t.marking.wrong },
  ...(t.markingByType ? { markingByType: t.markingByType } : {}),
  ...(t.qualifyingPercent === undefined || t.qualifyingPercent === null
    ? {}
    : { qualifyingPercent: t.qualifyingPercent }),
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const toExamDto = (e: WithId<ExamAttrs>): Exam => ({
  id: e._id.toString(),
  slug: e.slug,
  name: e.name,
  shortName: e.shortName,
  family: e.family,
  description: e.description,
  templateKeys: [...e.templateKeys],
  status: e.status,
  sortOrder: e.sortOrder,
  createdAt: e.createdAt.toISOString(),
  updatedAt: e.updatedAt.toISOString(),
});

export const toTaxonomyDto = (n: WithId<TaxonomyAttrs>): TaxonomyNode => ({
  id: n._id.toString(),
  examFamily: n.examFamily,
  parentId: n.parentId ? n.parentId.toString() : null,
  level: n.level,
  name: n.name,
  path: n.path,
});

export const toQuestionDto = (q: WithId<QuestionAttrs>): Question => ({
  id: q._id.toString(),
  rootId: q.rootId.toString(),
  version: q.version,
  isLatest: q.isLatest,
  examKey: q.examKey,
  examFamily: q.examFamily,
  section: q.section,
  number: q.number ?? null,
  order: q.order,
  type: q.type,
  passage: q.passage,
  passageHi: q.passageHi,
  stem: q.stem,
  options: [...q.options],
  stemHi: q.stemHi,
  optionsHi: [...q.optionsHi],
  correct: [...q.correct],
  numAnswer: q.numAnswer ? { min: q.numAnswer.min, max: q.numAnswer.max } : null,
  answerSource: q.answerSource,
  solution: q.solution,
  solutionHi: q.solutionHi,
  subject: q.subject,
  topic: q.topic,
  taxonomyIds: q.taxonomyIds.map(String),
  difficulty: q.difficulty,
  hasFigure: q.hasFigure,
  figureUrl: q.figureUrl ?? null,
  sourcePage: q.sourcePage ?? null,
  confidence: q.confidence,
  flags: [...q.flags],
  status: q.status,
  hash: q.hash,
  uploadId: q.uploadId ? q.uploadId.toString() : null,
  createdAt: q.createdAt.toISOString(),
  updatedAt: q.updatedAt.toISOString(),
});

export const toTestDto = (t: WithId<TestAttrs>): Test => ({
  id: t._id.toString(),
  title: t.title,
  examKey: t.examKey,
  type: t.type,
  templateSnapshot: t.templateSnapshot,
  sections: t.sections.map((s) => ({
    name: s.name,
    ...(s.timeSec === undefined || s.timeSec === null ? {} : { timeSec: s.timeSec }),
    questionIds: s.questionIds.map(String),
  })),
  testFlags: [...t.testFlags],
  status: t.status,
  isFree: t.isFree,
  publishAt: t.publishAt ? t.publishAt.toISOString() : null,
  publishedAt: t.publishedAt ? t.publishedAt.toISOString() : null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const toSeriesDto = (s: WithId<SeriesAttrs>): Series => ({
  id: s._id.toString(),
  title: s.title,
  examKey: s.examKey,
  tests: s.tests.map((t) => ({
    testId: t.testId.toString(),
    position: t.position,
    isFree: t.isFree,
    releaseAt: t.releaseAt ? t.releaseAt.toISOString() : null,
  })),
  createdAt: s.createdAt.toISOString(),
  updatedAt: s.updatedAt.toISOString(),
});

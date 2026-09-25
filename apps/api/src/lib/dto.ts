import type { Exam, ExamTemplate, TaxonomyNode, User } from "@mockprep/types";
import type { Types } from "mongoose";
import type { ExamAttrs } from "../models/exam.js";
import type { ExamTemplateAttrs } from "../models/examTemplate.js";
import type { TaxonomyAttrs } from "../models/taxonomy.js";
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

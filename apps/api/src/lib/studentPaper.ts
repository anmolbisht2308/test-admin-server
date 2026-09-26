import type { StudentPaper, StudentQuestion } from "@mockprep/types";
import type { Types } from "mongoose";
import type { QuestionAttrs } from "@mockprep/core";
import type { TestAttrs } from "@mockprep/core";

/**
 * THE serializer for anything a student sees before submitting. It copies fields explicitly
 * (an allow-list), so answers, solutions, answer sources, flags and confidence can never leak,
 * even when new fields are added to questions.
 */
export function toStudentQuestion(q: QuestionAttrs & { _id: Types.ObjectId }): StudentQuestion {
  return {
    id: q._id.toString(),
    type: q.type,
    number: q.number ?? null,
    passage: q.passage,
    passageHi: q.passageHi,
    stem: q.stem,
    stemHi: q.stemHi,
    options: [...q.options],
    optionsHi: [...q.optionsHi],
    hasFigure: q.hasFigure,
    figureUrl: q.figureUrl ?? null,
  };
}

export function toStudentPaper(
  test: TestAttrs & { _id: Types.ObjectId },
  questionsById: Map<string, QuestionAttrs & { _id: Types.ObjectId }>,
): StudentPaper {
  const t = test.templateSnapshot;
  return {
    testId: test._id.toString(),
    title: test.title,
    template: {
      skin: t.skin,
      totalTimeSec: t.totalTimeSec,
      optionCount: t.optionCount,
      sectionSwitching: t.sectionSwitching,
      marking: t.marking,
      ...(t.markingByType ? { markingByType: t.markingByType } : {}),
      ...(t.qualifyingPercent === undefined || t.qualifyingPercent === null
        ? {}
        : { qualifyingPercent: t.qualifyingPercent }),
    },
    sections: test.sections.map((s) => ({
      name: s.name,
      ...(s.timeSec === undefined || s.timeSec === null ? {} : { timeSec: s.timeSec }),
      questions: s.questionIds.flatMap((id) => {
        const q = questionsById.get(id.toString());
        return q ? [toStudentQuestion(q)] : [];
      }),
    })),
  };
}

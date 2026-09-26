/**
 * Sample papers used by the ingest tests. `scripts/make-fixtures.ts` renders them to PDFs in
 * this folder; the tests parse those PDFs and compare against these expectations.
 */
export interface FixtureQuestion {
  number: number;
  section: string;
  stem: string;
  options: string[];
  /** 0-based option indices, or a numeric answer. */
  answer: number[] | { min: number; max: number };
  passage?: string;
  hasFigure?: boolean;
  solution?: string;
}

// ---------------------------------------------------------------- SBI PO style
const SBI_PASSAGE =
  "The monsoon reached Kerala on time this year. Farmers welcomed the rain and began sowing kharif crops across the state.";

export const SBI_QUESTIONS: FixtureQuestion[] = [
  {
    number: 1,
    section: "English Language",
    passage: SBI_PASSAGE,
    stem: "When did the monsoon reach Kerala?",
    options: ["Early", "On time", "Late", "Never", "Twice"],
    answer: [1],
  },
  {
    number: 2,
    section: "English Language",
    passage: SBI_PASSAGE,
    stem: "What did farmers begin sowing?",
    options: ["Rabi crops", "Kharif crops", "Wheat", "Tea", "Coffee"],
    answer: [1],
  },
  {
    number: 3,
    section: "English Language",
    passage: SBI_PASSAGE,
    stem: "The word 'welcomed' is closest in meaning to:",
    options: ["Rejected", "Ignored", "Greeted", "Feared", "Doubted"],
    answer: [2],
  },
  {
    number: 4,
    section: "English Language",
    stem: "Choose the correctly spelt word.",
    options: ["Recieve", "Receive", "Receeve", "Riceive", "Receve"],
    answer: [1],
  },
  {
    number: 5,
    section: "Quantitative Aptitude",
    stem: "What is 15% of 240?",
    options: ["32", "34", "36", "38", "40"],
    answer: [2],
  },
  {
    number: 6,
    section: "Quantitative Aptitude",
    stem: "If x + 7 = 19, find x.",
    options: ["10", "11", "12", "13", "14"],
    answer: [2],
  },
  {
    number: 7,
    section: "Quantitative Aptitude",
    stem: "A train covers 300 km in 5 hours. Its speed in km/h is:",
    options: ["50", "55", "60", "65", "70"],
    answer: [2],
  },
  {
    number: 8,
    section: "Quantitative Aptitude",
    hasFigure: true,
    stem: "Study the figure given below and find the area of the shaded region (in sq cm).",
    options: ["14", "21", "28", "35", "42"],
    answer: [1],
  },
  {
    number: 9,
    section: "Reasoning Ability",
    stem: "Find the odd one out.",
    options: ["Apple", "Mango", "Carrot", "Banana", "Grape"],
    answer: [2],
  },
  {
    number: 10,
    section: "Reasoning Ability",
    stem: "What comes next: 2, 4, 8, 16, ?",
    options: ["18", "24", "30", "32", "36"],
    answer: [3],
  },
  {
    number: 11,
    section: "Reasoning Ability",
    stem: "If CAT is coded as DBU, how is DOG coded?",
    options: ["EPH", "EPG", "DPH", "EOH", "FPH"],
    answer: [0],
  },
  {
    number: 12,
    section: "Reasoning Ability",
    stem: 'Pointing to a man, Riya said, "He is the son of my mother\'s only son." How is the man related to Riya?',
    options: ["Brother", "Son", "Nephew", "Cousin", "Father"],
    answer: [2],
  },
];

// ---------------------------------------------------------------- SSC CGL style
export const SSC_SECTIONS = [
  "General Intelligence and Reasoning",
  "General Awareness",
  "Quantitative Aptitude",
  "English Comprehension",
];

/** 40 questions, 10 per page. The last question on every page has the same options (a header/footer trap). */
export const SSC_QUESTIONS: FixtureQuestion[] = Array.from({ length: 40 }, (_, i) => {
  const number = i + 1;
  const section = SSC_SECTIONS[Math.floor(i / 10)] as string;
  const last = number % 10 === 0;
  const options = last
    ? ["56", "64", "72", "80"]
    : [`${number * 3}`, `${number * 3 + 1}`, `${number * 3 + 2}`, `${number * 3 + 3}`];
  const stem = last
    ? `Which number completes the pattern in set ${number}: 8, 16, 24, 32, 40, 48, ?`
    : `In practice set ${number}, what is ${number} multiplied by 3, plus ${number % 4}?`;
  const answer = last ? [0] : [number % 4];
  return { number, section, stem, options, answer };
});

// ---------------------------------------------------------------- JEE Main style
export const JEE_QUESTIONS: FixtureQuestion[] = [
  {
    number: 1,
    section: "Physics",
    stem: "A ball is dropped from rest. Its speed after 2 s (g = 10 m/s^2) is:",
    options: ["10 m/s", "20 m/s", "30 m/s", "40 m/s"],
    answer: [1],
    solution: "v = gt = 20 m/s.",
  },
  {
    number: 2,
    section: "Physics",
    stem: "The SI unit of force is:",
    options: ["Joule", "Watt", "Newton", "Pascal"],
    answer: [2],
  },
  {
    number: 3,
    section: "Physics",
    stem: "A body of mass 2 kg moves at 3 m/s. Its kinetic energy in joules is (integer answer):",
    options: [],
    answer: { min: 9, max: 9 },
  },
  {
    number: 1,
    section: "Chemistry",
    stem: "The atomic number of carbon is:",
    options: ["4", "6", "8", "12"],
    answer: [1],
  },
  {
    number: 2,
    section: "Chemistry",
    stem: "Which gas is produced when zinc reacts with dilute HCl?",
    options: ["Oxygen", "Hydrogen", "Chlorine", "Nitrogen"],
    answer: [1],
  },
  {
    number: 3,
    section: "Chemistry",
    stem: "The pH of pure water at 25 C is (integer answer):",
    options: [],
    answer: { min: 7, max: 7 },
  },
  {
    number: 1,
    section: "Mathematics",
    stem: "The value of sin 90 degrees is:",
    options: ["0", "1/2", "1", "-1"],
    answer: [2],
  },
  {
    number: 2,
    section: "Mathematics",
    stem: "If 2x = 5, the value of x is (numeric answer):",
    options: [],
    answer: { min: 2.5, max: 2.5 },
    solution: "x = 5/2 = 2.5",
  },
  {
    number: 3,
    section: "Mathematics",
    stem: "The number of subsets of a set with 3 elements is:",
    options: ["3", "6", "8", "9"],
    answer: [2],
  },
];

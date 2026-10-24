/**
 * Multiple-choice suites: MMLU-Pro (TIGER-Lab, MIT) and MMLU (Hendrycks et al., MIT).
 *
 * The questions are asked zero-shot with one standard instruction, so every machine gets the same
 * text. That is not the 5-shot chain-of-thought setup of some published leaderboards, so a score
 * here is for comparing your machines with each other, not with a leaderboard to the decimal.
 */

import { oneRule, spread } from "./suite.ts";
import type { Question } from "./suite.ts";

const LETTERS = "ABCDEFGHIJ";

export interface McRow {
  id: string | number;
  category: string;
  question: string;
  options: string[];
  /** Index into options. */
  answer: number;
}

/** MMLU-Pro rows as the dataset publishes them. */
export function mmluProRow(raw: unknown): McRow | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.question !== "string" || !Array.isArray(r.options) || !r.options.every((o) => typeof o === "string")) return null;
  const idx = typeof r.answer_index === "number" ? r.answer_index : typeof r.answer === "string" ? LETTERS.indexOf(r.answer) : -1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= r.options.length || r.options.length > 10) return null;
  return { id: typeof r.question_id === "number" ? r.question_id : String(r.question_id ?? ""), category: String(r.category ?? "unknown"), question: r.question, options: r.options as string[], answer: idx };
}

/** MMLU rows as the dataset publishes them: `answer` is the position of the right choice, 0 to 3. */
export function mmluRow(raw: unknown, position: number): McRow | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.question !== "string" || !Array.isArray(r.choices) || r.choices.length !== 4 || !r.choices.every((o) => typeof o === "string")) return null;
  const idx = typeof r.answer === "number" ? r.answer : typeof r.answer === "string" ? "ABCD".indexOf(r.answer) : -1;
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) return null;
  return { id: position, category: String(r.subject ?? "unknown"), question: r.question, options: r.choices as string[], answer: idx };
}

export function mcPrompt(row: McRow): string {
  const subject = row.category.replace(/_/g, " ");
  const options = row.options.map((o, i) => `${LETTERS[i]}. ${o}`).join("\n");
  return (
    `The following is a multiple choice question about ${subject}. Think it through if you need to, ` +
    `then end your reply with a line of the form "The answer is (X)", where X is the letter of the correct option.\n\n` +
    `Question: ${row.question}\nOptions:\n${options}`
  );
}

/** The letter the model settled on, read the way MMLU-Pro's own scorer reads it. */
export function pickLetter(response: string, count: number): { strict: string | null; loose: string | null } {
  const max = LETTERS[count - 1]!;
  const range = `[A-${max}]`;
  const last = (re: RegExp): string | null => {
    const all = [...response.matchAll(re)];
    return all.length > 0 ? all[all.length - 1]![1]!.toUpperCase() : null;
  };
  const strict = last(new RegExp(`answer is:?\\s*\\*{0,2}\\(?(${range})\\)?`, "gi"));
  if (strict) return { strict, loose: strict };
  const loose =
    last(new RegExp(`answer:?\\s*\\*{0,2}\\(?(${range})\\)?(?![a-z])`, "gi")) ??
    last(new RegExp(`(?:^|[^A-Za-z])(${range})(?![A-Za-z])(?=[^A-Za-z]*$)`, "g"));
  return { strict: null, loose };
}

export function mcQuestions(rows: McRow[], limit: number | null): Question[] {
  return spread(rows, limit).map((row) => ({
    key: row.id,
    prompt: mcPrompt(row),
    check: (response) => {
      const got = pickLetter(response, row.options.length);
      const right = LETTERS[row.answer]!;
      return oneRule(row.id, row.category, got.strict === right, got.loose === right, response.trim() === "");
    },
  }));
}

/**
 * Maths suites: GSM8K (OpenAI, MIT) and MATH-500 (the 500-problem test split from OpenAI's
 * "Let's Verify Step by Step", drawn from Hendrycks et al.'s MATH).
 *
 * Both are scored on the final answer only. GSM8K answers are numbers and are compared as numbers.
 * MATH-500 answers can be expressions, and with no algebra library here they are compared as
 * normalised text, then as numbers when both parse. A correct answer written in an unusual form can
 * therefore be marked wrong, which is why the loose score exists and why the README says so.
 */

import { oneRule, spread } from "./suite.ts";
import type { Question } from "./suite.ts";

// ---- GSM8K -----------------------------------------------------------------------------------

export interface Gsm8kRow {
  question: string;
  /** The number after "####" in the published worked answer. */
  answer: number;
}

export function gsm8kRow(raw: unknown): Gsm8kRow | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.question !== "string" || typeof r.answer !== "string") return null;
  const tail = r.answer.split("####").pop()?.trim().replace(/,/g, "");
  const n = tail === undefined ? NaN : Number(tail);
  return Number.isFinite(n) ? { question: r.question, answer: n } : null;
}

export function gsm8kPrompt(row: Gsm8kRow): string {
  return (
    `Solve the problem. Work it out step by step, then end your reply with a line of the form ` +
    `"The answer is N", where N is just the final number with no units.\n\nQuestion: ${row.question}`
  );
}

function lastNumber(text: string, re: RegExp): number | null {
  const all = [...text.matchAll(re)];
  if (all.length === 0) return null;
  const n = Number(all[all.length - 1]![1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function readGsm8k(response: string): { strict: number | null; loose: number | null } {
  const strict = lastNumber(response, /answer is:?\s*\$?\\?\(?\s*\**\s*\$?(-?\d[\d,]*\.?\d*)/gi);
  if (strict !== null) return { strict, loose: strict };
  return { strict: null, loose: lastNumber(response, /(-?\d[\d,]*\.?\d*)/g) };
}

export function gsm8kQuestions(rows: Gsm8kRow[], limit: number | null): Question[] {
  return spread(rows.map((row, i) => ({ row, i })), limit).map(({ row, i }) => ({
    key: i,
    prompt: gsm8kPrompt(row),
    check: (response) => {
      const got = readGsm8k(response);
      const same = (x: number | null) => x !== null && Math.abs(x - row.answer) < 1e-6;
      return oneRule(i, "gsm8k", same(got.strict), same(got.loose), response.trim() === "");
    },
  }));
}

// ---- MATH-500 --------------------------------------------------------------------------------

export interface MathRow {
  id: string;
  subject: string;
  level: number;
  problem: string;
  answer: string;
}

export function mathRow(raw: unknown): MathRow | null {
  const r = raw as Record<string, unknown>;
  if (typeof r?.problem !== "string" || typeof r.answer !== "string" || r.answer.trim() === "") return null;
  return { id: String(r.unique_id ?? ""), subject: String(r.subject ?? "unknown"), level: Number(r.level ?? 0), problem: r.problem, answer: r.answer };
}

export function mathPrompt(row: MathRow): string {
  return `Solve the problem. Show your reasoning, then give the final answer inside \\boxed{}, for example \\boxed{12}.\n\nProblem: ${row.problem}`;
}

/** The text inside the last \boxed{...}, with its braces matched. */
export function lastBoxed(text: string): string | null {
  const at = text.lastIndexOf("\\boxed");
  if (at < 0) return null;
  const open = text.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Writes the same answer one way: no spaces, dfrac as frac, units and degree signs dropped. */
export function normalizeAnswer(s: string): string {
  let t = s.trim();
  t = t.replace(/\\text\{([^{}]*)\}/g, "$1").replace(/\\mbox\{([^{}]*)\}/g, "$1");
  t = t.replace(/\\(left|right|!|,|;|:|\s)/g, "").replace(/\\(dfrac|tfrac)/g, "\\frac");
  t = t.replace(/\^\{?\\circ\}?/g, "").replace(/\\%|%/g, "").replace(/\\\$|\$/g, "");
  t = t.replace(/\\frac(\d)(\d)/g, "\\frac{$1}{$2}");
  t = t.replace(/^[a-zA-Z]\s*=\s*/, "").replace(/\s+/g, "").replace(/\.$/, "");
  t = t.replace(/(\d),(\d{3})(?!\d)/g, "$1$2");
  return t.toLowerCase();
}

function asNumber(s: string): number | null {
  const t = normalizeAnswer(s);
  const frac = /^(-?)\\frac\{(-?\d+(?:\.\d+)?)\}\{(-?\d+(?:\.\d+)?)\}$/.exec(t);
  if (frac) return (frac[1] ? -1 : 1) * (Number(frac[2]) / Number(frac[3]));
  const slash = /^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/.exec(t);
  if (slash) return Number(slash[1]) / Number(slash[2]);
  return /^-?\d+(?:\.\d+)?$/.test(t) ? Number(t) : null;
}

export function sameAnswer(got: string, want: string): { strict: boolean; loose: boolean } {
  const strict = normalizeAnswer(got) === normalizeAnswer(want);
  if (strict) return { strict: true, loose: true };
  const a = asNumber(got);
  const b = asNumber(want);
  return { strict: false, loose: a !== null && b !== null && Math.abs(a - b) < 1e-9 };
}

export function mathQuestions(rows: MathRow[], limit: number | null): Question[] {
  return spread(rows, limit).map((row, i) => ({
    key: row.id || i,
    prompt: mathPrompt(row),
    check: (response) => {
      const boxed = lastBoxed(response);
      const r = boxed === null ? { strict: false, loose: false } : sameAnswer(boxed, row.answer);
      return oneRule(row.id || i, row.subject, r.strict, r.loose, response.trim() === "");
    },
  }));
}

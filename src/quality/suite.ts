/** What every quality test (a "suite") looks like to the runner: a list of questions that score themselves. */

import type { PromptResult } from "./ifeval.ts";

export interface Question {
  key: number | string;
  prompt: string;
  /** Scores the machine's answer. Strict is the answer as written; loose forgives its format. */
  check: (response: string) => PromptResult;
}

export interface SuiteInfo {
  id: string;
  name: string;
  /** Where the questions come from. */
  source: string;
  paper?: string;
  license: string;
  /** Questions in the full published set, or null when they are generated here. */
  of: number | null;
  /** True when loose scoring means something different from strict. */
  hasLoose: boolean;
}

/** Builds one result for a question with one kind of rule, so the per-kind table has a row for it. */
export function oneRule(key: number | string, rule: string, strict: boolean, loose: boolean, empty: boolean): PromptResult {
  return { key, strict, loose: loose || strict, rules: [{ id: rule, strict, loose: loose || strict }], empty };
}

/** `limit` questions spread evenly through the list, or all of them. */
export function spread<T>(items: T[], limit: number | null): T[] {
  if (limit === null || limit >= items.length) return items;
  const out: T[] = [];
  for (let i = 0; i < limit; i++) out.push(items[Math.floor((i * items.length) / limit)]!);
  return out;
}

/**
 * The quality tests this tool knows, and where each one's questions come from.
 *
 * IFEval, MMLU-Pro, MMLU, GSM8K and MATH-500 are published datasets: `bun run quality:fetch <id>`
 * downloads each one unchanged into quality/<id>/ and checks it. The long-context test is made here.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import type { PresetId } from "../types.ts";
import { IFEVAL_COUNT, parseIfEval, pickQuestions } from "./data.ts";
import { checkResponse } from "./ifeval.ts";
import { DEFAULT_LONGCTX_SIZES, LONGCTX_SIZES, longContextQuestions } from "./longctx.ts";
import { gsm8kQuestions, gsm8kRow, mathQuestions, mathRow } from "./math.ts";
import type { Gsm8kRow, MathRow } from "./math.ts";
import { mcQuestions, mmluProRow, mmluRow } from "./mc.ts";
import type { McRow } from "./mc.ts";
import type { Question, SuiteInfo } from "./suite.ts";

export type SuiteId = "ifeval" | "mmlu-pro" | "mmlu" | "gsm8k" | "math500" | "longctx";

/** Where a published suite's rows are downloaded from: the Hugging Face dataset viewer's row service. */
export interface HfSource {
  dataset: string;
  config: string;
  split: string;
}

export interface Suite extends SuiteInfo {
  id: SuiteId;
  /** Null for ifeval (its own downloader) and for the generated suite. */
  hf: HfSource | null;
  /** True when the questions are written here from a seed. */
  generated: boolean;
  /** One line for the README and the help text. */
  measures: string;
}

export const SUITES: Record<SuiteId, Suite> = {
  ifeval: {
    id: "ifeval", name: "IFEval", measures: "following instructions that code can check",
    source: "https://github.com/google-research/google-research/tree/master/instruction_following_eval",
    paper: "https://arxiv.org/abs/2311.07911", license: "Apache-2.0", of: IFEVAL_COUNT, hasLoose: true, hf: null, generated: false,
  },
  "mmlu-pro": {
    id: "mmlu-pro", name: "MMLU-Pro", measures: "knowledge and reasoning, 10-option multiple choice across 14 subjects",
    source: "https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro", paper: "https://arxiv.org/abs/2406.01574",
    license: "MIT", of: 12032, hasLoose: true, hf: { dataset: "TIGER-Lab/MMLU-Pro", config: "default", split: "test" }, generated: false,
  },
  mmlu: {
    id: "mmlu", name: "MMLU", measures: "general knowledge, 4-option multiple choice across 57 subjects",
    source: "https://huggingface.co/datasets/cais/mmlu", paper: "https://arxiv.org/abs/2009.03300",
    license: "MIT", of: 14042, hasLoose: true, hf: { dataset: "cais/mmlu", config: "all", split: "test" }, generated: false,
  },
  gsm8k: {
    id: "gsm8k", name: "GSM8K", measures: "grade-school maths word problems, final number checked",
    source: "https://huggingface.co/datasets/openai/gsm8k", paper: "https://arxiv.org/abs/2110.14168",
    license: "MIT", of: 1319, hasLoose: true, hf: { dataset: "openai/gsm8k", config: "main", split: "test" }, generated: false,
  },
  math500: {
    id: "math500", name: "MATH-500", measures: "competition maths, final answer checked after normalising",
    source: "https://huggingface.co/datasets/HuggingFaceH4/MATH-500", paper: "https://arxiv.org/abs/2305.20050",
    license: "MIT (the source repositories openai/prm800k and the MATH dataset; the Hugging Face copy states none)",
    of: 500, hasLoose: true, hf: { dataset: "HuggingFaceH4/MATH-500", config: "default", split: "test" }, generated: false,
  },
  longctx: {
    id: "longctx", name: "Long context (needle, multi-key, variable chain)", measures: "finding facts buried in 4K to 128K tokens of text",
    source: "made in this project after RULER (NVIDIA, Apache-2.0) and needle-in-a-haystack (Kamradt, MIT)",
    paper: "https://arxiv.org/abs/2404.06654", license: "MIT (this project)", of: null, hasLoose: true, hf: null, generated: true,
  },
};

export const SUITE_IDS = Object.keys(SUITES) as SuiteId[];

export function isSuiteId(v: string): v is SuiteId {
  return (SUITE_IDS as string[]).includes(v);
}

export const suiteDir = (id: SuiteId) => resolve(PROJECT_ROOT, "quality", id);
export const suiteFile = (id: SuiteId) => resolve(suiteDir(id), id === "ifeval" ? "input_data.jsonl" : "data.jsonl");

/** Parses a downloaded file of one JSON row per line into rows, checking the count and each row. */
export function parseRows<T>(text: string, convert: (raw: unknown, i: number) => T | null, expected: number | null): { ok: true; rows: T[] } | { ok: false; error: string } {
  const rows: T[] = [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, error: `Line ${i + 1} is not valid JSON.` };
    }
    const row = convert(raw, i);
    if (row === null) return { ok: false, error: `Line ${i + 1} is not a question this test understands.` };
    rows.push(row);
  }
  if (expected !== null && rows.length !== expected) return { ok: false, error: `Expected ${expected} questions and found ${rows.length}.` };
  return { ok: true, rows };
}

export interface LoadOptions {
  limit: number | null;
  sizes: PresetId[];
  charsPerToken: number;
  /** Override the file, for tests. */
  file?: string;
  /** Skip the check that the file holds the full published set, for tests. */
  anyCount?: boolean;
}

/** Turns the text of a downloaded file into questions, refusing a file that is not the full, well-formed set. */
export function questionsFromText(id: SuiteId, text: string, o: Pick<LoadOptions, "limit" | "anyCount">): { ok: true; questions: Question[] } | { ok: false; error: string } {
  const expected = o.anyCount ? null : SUITES[id].of;
  if (id === "ifeval") {
    const parsed = parseIfEval(text, expected);
    if (!parsed.ok) return parsed;
    return { ok: true, questions: pickQuestions(parsed.rows, o.limit).map((row) => ({ key: row.key, prompt: row.prompt, check: (r: string) => checkResponse(row, r) })) };
  }
  if (id === "mmlu-pro" || id === "mmlu") {
    const parsed = parseRows<McRow>(text, id === "mmlu-pro" ? mmluProRow : mmluRow, expected);
    return parsed.ok ? { ok: true, questions: mcQuestions(parsed.rows, o.limit) } : parsed;
  }
  if (id === "gsm8k") {
    const parsed = parseRows<Gsm8kRow>(text, gsm8kRow, expected);
    return parsed.ok ? { ok: true, questions: gsm8kQuestions(parsed.rows, o.limit) } : parsed;
  }
  const parsed = parseRows<MathRow>(text, mathRow, expected);
  return parsed.ok ? { ok: true, questions: mathQuestions(parsed.rows, o.limit) } : parsed;
}

export async function loadSuite(id: SuiteId, o: LoadOptions): Promise<{ ok: true; questions: Question[] } | { ok: false; error: string }> {
  const suite = SUITES[id];
  if (suite.generated) return { ok: true, questions: longContextQuestions({ sizes: o.sizes, charsPerToken: o.charsPerToken }) };
  let text: string;
  try {
    text = await readFile(o.file ?? suiteFile(id), "utf8");
  } catch {
    return { ok: false, error: `The ${suite.name} questions are not downloaded yet. Run:  bun run quality:fetch ${id}` };
  }
  return questionsFromText(id, text, o);
}

export { DEFAULT_LONGCTX_SIZES, LONGCTX_SIZES };

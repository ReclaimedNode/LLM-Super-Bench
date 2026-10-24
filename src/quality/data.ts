/**
 * Reads and checks the IFEval data file. The file is Google Research's, kept as they published it
 * in quality/ifeval/ (see the NOTICE there). It is checked on every load, so a file that was cut
 * short, edited or swapped for something else is refused instead of scoring the wrong questions.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { KNOWN_INSTRUCTIONS } from "./ifeval.ts";
import type { IfEvalRow } from "./ifeval.ts";

/** Prompts in Google Research's data file. */
export const IFEVAL_COUNT = 541;
export const IFEVAL_DIR = resolve(PROJECT_ROOT, "quality/ifeval");
export const IFEVAL_FILE = resolve(IFEVAL_DIR, "input_data.jsonl");

export type ParsedData = { ok: true; rows: IfEvalRow[] } | { ok: false; error: string };

/** Pure, so it can be tested. `expected` is the row count to demand, or null for no demand. */
export function parseIfEval(text: string, expected: number | null = IFEVAL_COUNT): ParsedData {
  const rows: IfEvalRow[] = [];
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  for (let i = 0; i < lines.length; i++) {
    let o: unknown;
    try {
      o = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, error: `Line ${i + 1} is not valid JSON.` };
    }
    const r = o as Partial<IfEvalRow>;
    if (
      typeof r.key !== "number" || typeof r.prompt !== "string" || r.prompt === "" ||
      !Array.isArray(r.instruction_id_list) || !Array.isArray(r.kwargs) ||
      r.instruction_id_list.length !== r.kwargs.length || r.instruction_id_list.length === 0
    ) {
      return { ok: false, error: `Line ${i + 1} is not an IFEval question.` };
    }
    const unknown = r.instruction_id_list.find((id) => !KNOWN_INSTRUCTIONS.includes(id));
    if (unknown) return { ok: false, error: `Line ${i + 1} uses a rule this tool does not know: ${unknown}.` };
    rows.push(r as IfEvalRow);
  }
  if (new Set(rows.map((r) => r.key)).size !== rows.length) return { ok: false, error: "Some question keys appear twice." };
  if (expected !== null && rows.length !== expected) {
    return { ok: false, error: `Expected ${expected} questions and found ${rows.length}.` };
  }
  return { ok: true, rows };
}

export async function loadIfEval(path: string = IFEVAL_FILE): Promise<ParsedData> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { ok: false, error: "The IFEval questions are not downloaded yet. Run:  bun run quality:fetch" };
  }
  return parseIfEval(text);
}

/** Every question, or an even spread of `limit` of them so a short run still covers every kind of rule. */
export function pickQuestions(rows: IfEvalRow[], limit: number | null): IfEvalRow[] {
  if (limit === null || limit >= rows.length) return rows;
  const out: IfEvalRow[] = [];
  for (let i = 0; i < limit; i++) out.push(rows[Math.floor((i * rows.length) / limit)]!);
  return out;
}

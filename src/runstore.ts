/**
 * The run files kept in results/. Writing, listing and reading all live here so the file name
 * is checked in exactly one place: a name that does not match is never opened.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./config.ts";
import { hasFinishedRun } from "./runfile.ts";
import type { RunFile } from "./runfile.ts";

export const RUNS_DIR = resolve(PROJECT_ROOT, "results");
/** The only names ever served: run-race-2026-10-24T04-05-24-350Z.json */
export const RUN_NAME = /^run-(?:race|sweep)-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;
const MAX_LISTED = 50;
const MAX_BYTES = 5 * 1024 * 1024;

export function runFileName(file: Pick<RunFile, "kind" | "createdAt">): string {
  return `run-${file.kind}-${file.createdAt.replace(/[:.]/g, "-")}.json`;
}

/** Saves a finished run. A run with nothing finished in it is not kept. Returns the name, or null. */
export async function saveRun(file: RunFile, dir: string = RUNS_DIR): Promise<string | null> {
  if (!hasFinishedRun(file)) return null;
  const name = runFileName(file);
  if (!RUN_NAME.test(name)) return null;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, name), JSON.stringify(file, null, 2) + "\n");
    return name;
  } catch {
    return null;
  }
}

export interface SavedRun {
  name: string;
  kind: "race" | "sweep";
  createdAt: string;
  complete: boolean;
}

/** Newest first. Files that do not read as run files are skipped, never trusted. */
export async function listRuns(dir: string = RUNS_DIR): Promise<SavedRun[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => RUN_NAME.test(n));
  } catch {
    return [];
  }
  names.sort().reverse();
  const out: SavedRun[] = [];
  for (const name of names.slice(0, MAX_LISTED)) {
    const file = await readRun(name, dir);
    if (file) out.push({ name, kind: file.kind, createdAt: file.createdAt, complete: file.complete !== false });
  }
  return out;
}

/** The text of one saved run, or null if the name is not a run file's name or it cannot be read. */
export async function readRunText(name: string, dir: string = RUNS_DIR): Promise<string | null> {
  if (!RUN_NAME.test(name)) return null;
  try {
    const f = Bun.file(resolve(dir, name));
    if (f.size > MAX_BYTES) return null;
    return await f.text();
  } catch {
    return null;
  }
}

async function readRun(name: string, dir: string): Promise<RunFile | null> {
  const text = await readRunText(name, dir);
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as RunFile;
    return o && o.format === "llm-super-bench-run" && (o.kind === "race" || o.kind === "sweep") && typeof o.createdAt === "string" ? o : null;
  } catch {
    return null;
  }
}

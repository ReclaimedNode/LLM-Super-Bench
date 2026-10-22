/**
 * The run folder: results/bench/<run-name>/.
 *
 * Everything in here is written the instant it exists. A grid can run for two
 * hours; killing it at any moment must lose at most the run that was in flight,
 * so runs.jsonl is appended per run and never buffered, and the summaries are
 * rewritten whole after each cell.
 */

import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import type { BenchRunRecord, CellStat, EngineCell, PowerReading, RunManifest } from "./types.ts";

export const BENCH_RESULTS_ROOT = resolve(PROJECT_ROOT, "results/bench");

export function runDir(runName: string): string {
  return resolve(BENCH_RESULTS_ROOT, runName);
}

export const FILES = {
  runs: "runs.jsonl",
  cells: "cells.json",
  report: "report.md",
  manifest: "manifest.json",
  engine: "engine.json",
  power: "power.json",
} as const;

/** A run name that is a folder name: date, time, nothing exotic. */
export function defaultRunName(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

export async function ensureRunDir(runName: string): Promise<string> {
  const dir = runDir(runName);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function appendRun(runName: string, record: BenchRunRecord): Promise<void> {
  const dir = await ensureRunDir(runName);
  await appendFile(resolve(dir, FILES.runs), JSON.stringify(record) + "\n", "utf8");
}

/** Reads the log. A half-written last line from a killed process is skipped. */
export async function readRuns(runName: string): Promise<BenchRunRecord[]> {
  let text: string;
  try {
    text = await readFile(resolve(runDir(runName), FILES.runs), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: BenchRunRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as BenchRunRecord);
    } catch {
      // A torn line is the one the kill interrupted. Losing it is the contract.
    }
  }
  return out;
}

async function writeJson(runName: string, file: string, value: unknown): Promise<void> {
  const dir = await ensureRunDir(runName);
  await Bun.write(resolve(dir, file), JSON.stringify(value, null, 2) + "\n");
}

async function readJson<T>(runName: string, file: string): Promise<T | null> {
  const f = Bun.file(resolve(runDir(runName), file));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as T;
  } catch {
    return null;
  }
}

export const writeCells = (runName: string, cells: CellStat[]) => writeJson(runName, FILES.cells, cells);
export const readCells = (runName: string) => readJson<CellStat[]>(runName, FILES.cells);

export const writeManifest = (runName: string, manifest: RunManifest) => writeJson(runName, FILES.manifest, manifest);
export const readManifest = (runName: string) => readJson<RunManifest>(runName, FILES.manifest);

export const writeEngine = (runName: string, cells: EngineCell[]) => writeJson(runName, FILES.engine, cells);
export const readEngine = (runName: string) => readJson<EngineCell[]>(runName, FILES.engine);

export const writePower = (runName: string, readings: PowerReading[]) => writeJson(runName, FILES.power, readings);
export const readPower = (runName: string) => readJson<PowerReading[]>(runName, FILES.power);

export async function writeReport(runName: string, markdown: string): Promise<void> {
  const dir = await ensureRunDir(runName);
  await Bun.write(resolve(dir, FILES.report), markdown);
}

/** Run folders, newest first by modification time. */
export async function listRuns(): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(BENCH_RESULTS_ROOT);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const withTimes = await Promise.all(
    names.map(async (name) => {
      try {
        const s = await stat(resolve(BENCH_RESULTS_ROOT, name));
        return s.isDirectory() ? { name, at: s.mtimeMs } : null;
      } catch {
        return null;
      }
    }),
  );
  return withTimes
    .filter((x): x is { name: string; at: number } => x !== null)
    .sort((a, b) => b.at - a.at)
    .map((x) => x.name);
}

export async function latestRun(): Promise<string | null> {
  return (await listRuns())[0] ?? null;
}

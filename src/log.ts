/**
 * The run log: one JSON line per lane per race, appended to results/runs.jsonl.
 * This file is the record the report reads, and the one honest artefact of a
 * race after the screen has gone.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "./config.ts";
import type { LaneResult, PresetId, RunLogRecord } from "./types.ts";

export const DEFAULT_LOG_PATH = resolve(PROJECT_ROOT, "results/runs.jsonl");

export function toRecord(opts: {
  result: LaneResult;
  runId: string;
  preset: PresetId;
  promptChars: number;
  ts?: string;
}): RunLogRecord {
  const r = opts.result;
  return {
    ts: opts.ts ?? new Date().toISOString(),
    runId: opts.runId,
    lane: r.label,
    baseUrl: r.baseUrl,
    model: r.model,
    preset: opts.preset,
    promptChars: opts.promptChars,
    firstResponseSec: r.firstResponseSec,
    firstWordSec: r.firstWordSec,
    firstWordField: r.firstWordField,
    lastWordSec: r.lastWordSec,
    chunks: r.chunks,
    tokens: r.tokens,
    tokenSource: r.tokenSource,
    totalSec: r.totalSec,
    error: r.blocked ?? r.error,
    ...(r.setup ? { setup: r.setup } : {}),
    ...(r.promptTokens !== null && r.promptTokens !== undefined ? { promptTokens: r.promptTokens } : {}),
    ...(r.cachedTokens ? { cachedTokens: r.cachedTokens } : {}),
    // Only when there were several, so a one-stream record is the line it always was.
    ...(r.concurrency && r.concurrency > 1
      ? { concurrency: r.concurrency, failedStreams: r.failedStreams ?? 0, streams: r.streams ?? [] }
      : {}),
  };
}

export async function appendRecords(records: RunLogRecord[], logPath: string = DEFAULT_LOG_PATH): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(logPath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await appendFile(logPath, body, "utf8");
}

/** Reads the log. Skips blank and unparseable lines rather than dying on them. */
export async function readRecords(logPath: string = DEFAULT_LOG_PATH): Promise<RunLogRecord[]> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: RunLogRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as RunLogRecord);
    } catch {
      // A half-written line from a killed process should not break the report.
    }
  }
  return out;
}

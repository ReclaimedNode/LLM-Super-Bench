/**
 * A sweep: the same races run one after another over a grid of prompt sizes and
 * stream counts, each cell repeated, and boiled down to one table.
 *
 * Every run in a sweep is an ordinary race. It is measured by the same code,
 * shown on the lanes as it happens, and logged to the same runs.jsonl. The
 * table is worked out from those results, never from anything rounded for the
 * screen: each cell reports the MEDIAN of its runs, with the lowest and highest
 * beside it, because one run of a local model is a sample and not a measurement.
 */

import type { MachineSetup } from "./details.ts";
import { isPresetId } from "./prompt.ts";
import { runRace } from "./race.ts";
import type { RunRaceOptions } from "./race.ts";
import { laneSpeed, laneThroughput, median, promptSpeed } from "./timing.ts";
import type { LaneResult, PresetId, RaceEvent } from "./types.ts";

export const MAX_REPEATS = 5;
/** Races in one sweep. A sweep of 128K prompts at 16 streams is not one to start by accident. */
export const MAX_SWEEP_RUNS = 60;
/** Between runs, so one machine's cool-down or cache eviction is not the next run's problem. */
export const DEFAULT_PAUSE_MS = 1500;

export interface SweepRequest {
  laneIds: string[];
  presets: PresetId[];
  concurrencies: number[];
  repeats: number;
  /** One short race first, not in the table, so the first measured run is not the one that wakes the model up. */
  warmup: boolean;
}

export type SweepRequestResult = { ok: true; request: SweepRequest } | { ok: false; error: string };

function wholeList(value: unknown, what: string): { ok: true; list: unknown[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, error: `Pick at least one ${what}.` };
  return { ok: true, list: value };
}

export function parseSweepRequest(
  body: unknown,
  limits: { laneIds: string[]; maxConcurrency: number },
): SweepRequestResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  let laneIds = limits.laneIds;
  if (b.lanes !== undefined) {
    const l = wholeList(b.lanes, "machine");
    if (!l.ok) return l;
    if (!l.list.every((x) => typeof x === "string")) return { ok: false, error: "Pick at least one machine." };
    const unknown = (l.list as string[]).filter((id) => !limits.laneIds.includes(id));
    if (unknown.length > 0) {
      return { ok: false, error: `Unknown machine: ${unknown.map((u) => JSON.stringify(u)).join(", ")}.` };
    }
    laneIds = limits.laneIds.filter((id) => (l.list as string[]).includes(id));
  }

  const p = wholeList(b.presets, "prompt size");
  if (!p.ok) return p;
  const badPreset = p.list.find((x) => typeof x !== "string" || !isPresetId(x));
  if (badPreset !== undefined) return { ok: false, error: `Unknown prompt size: ${JSON.stringify(badPreset)}.` };
  const presets = [...new Set(p.list as PresetId[])];

  const c = wholeList(b.concurrencies, "stream count");
  if (!c.ok) return c;
  const badStreams = c.list.find(
    (x) => typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > limits.maxConcurrency,
  );
  if (badStreams !== undefined) {
    return { ok: false, error: `Streams per machine must be a whole number from 1 to ${limits.maxConcurrency}.` };
  }
  const concurrencies = [...new Set(c.list as number[])].sort((x, y) => x - y);

  let repeats = 1;
  if (b.repeats !== undefined) {
    const r = b.repeats;
    if (typeof r !== "number" || !Number.isInteger(r) || r < 1 || r > MAX_REPEATS) {
      return { ok: false, error: `Repeats must be a whole number from 1 to ${MAX_REPEATS}.` };
    }
    repeats = r;
  }

  let warmup = false;
  if (b.warmup !== undefined) {
    if (typeof b.warmup !== "boolean") return { ok: false, error: "Warm-up must be true or false." };
    warmup = b.warmup;
  }

  const runs = presets.length * concurrencies.length * repeats;
  if (runs > MAX_SWEEP_RUNS) {
    return {
      ok: false,
      error: `That is ${runs} races (${presets.length} sizes x ${concurrencies.length} stream counts x ${repeats} repeats). A sweep is limited to ${MAX_SWEEP_RUNS}.`,
    };
  }

  return { ok: true, request: { laneIds, presets, concurrencies, repeats, warmup } };
}

/** The middle of a cell's runs, with the lowest and highest, so the spread is never hidden. */
export interface Spread {
  median: number;
  min: number;
  max: number;
}

export function spread(values: (number | null)[]): Spread | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const mid = median(nums);
  if (mid === null) return null;
  return { median: mid, min: Math.min(...nums), max: Math.max(...nums) };
}

export interface SweepRow {
  preset: PresetId;
  /** Streams per machine. */
  concurrency: number;
  laneId: string;
  label: string;
  /** Races asked for, and how many of them this machine finished. */
  repeats: number;
  finished: number;
  /** "tokens/sec" only when every finished run of this cell reported usage. */
  speedUnit: "tokens/sec" | "chunks/sec";
  firstWordSec: Spread | null;
  /** One stream's speed (the median of one stream's when there were several). */
  speed: Spread | null;
  /** Every stream together. Null for one stream. */
  throughput: Spread | null;
  /** Prompt tokens per second to the first word. Null where that would be a guess. */
  promptSpeed: Spread | null;
  totalSec: Spread | null;
  promptTokens: number | null;
}

/** One cell's runs (each an array of per-lane results) folded into one row per lane. */
export function summarizeCell(preset: PresetId, concurrency: number, runs: LaneResult[][]): SweepRow[] {
  const laneIds = [...new Set(runs.flatMap((run) => run.map((r) => r.laneId)))];
  return laneIds.map((laneId) => {
    const mine = runs.map((run) => run.find((r) => r.laneId === laneId)).filter((r): r is LaneResult => !!r);
    const ok = mine.filter((r) => !r.error && !r.blocked && r.totalSec !== null);
    const speedUnit = ok.length > 0 && ok.every((r) => r.tokens !== null) ? "tokens/sec" : "chunks/sec";
    return {
      preset,
      concurrency,
      laneId,
      label: mine[0]!.label,
      repeats: runs.length,
      finished: ok.length,
      speedUnit,
      firstWordSec: spread(ok.map((r) => r.firstWordSec)),
      speed: spread(ok.map((r) => laneSpeed(r, speedUnit))),
      throughput: spread(ok.map((r) => laneThroughput(r, speedUnit))),
      promptSpeed: spread(ok.map((r) => promptSpeed(r))),
      totalSec: spread(ok.map((r) => r.totalSec)),
      promptTokens: ok.find((r) => r.promptTokens !== null)?.promptTokens ?? null,
    };
  });
}

const CSV_COLUMNS = [
  "prompt_size",
  "prompt_tokens",
  "streams_per_machine",
  "machine",
  "runs_finished",
  "runs_asked",
  "first_word_sec_median",
  "first_word_sec_min",
  "first_word_sec_max",
  "speed_unit",
  "speed_median",
  "speed_min",
  "speed_max",
  "throughput_median",
  "throughput_min",
  "throughput_max",
  "prompt_tokens_per_sec_median",
  "prompt_tokens_per_sec_min",
  "prompt_tokens_per_sec_max",
  "total_sec_median",
  "total_sec_min",
  "total_sec_max",
  "engine",
  "model_file",
  "quant",
  "llama_cpp_build",
  "slots",
  "context_per_slot",
  "machine_notes",
  "reply_length",
  "thinking",
];

function csvCell(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "number" ? String(Math.round(value * 1000) / 1000) : value;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A spreadsheet-ready table. Blank where a number would have been a guess. */
export function sweepCsv(
  rows: SweepRow[],
  setups: Record<string, MachineSetup> = {},
  settings: { maxTokens?: number; thinking?: string } = {},
): string {
  const trio = (s: Spread | null) => [s?.median ?? null, s?.min ?? null, s?.max ?? null];
  const lines = rows.map((r) =>
    [
      r.preset,
      r.promptTokens,
      r.concurrency,
      r.label,
      r.finished,
      r.repeats,
      ...trio(r.firstWordSec),
      r.speedUnit,
      ...trio(r.speed),
      ...trio(r.throughput),
      ...trio(r.promptSpeed),
      ...trio(r.totalSec),
      setups[r.laneId]?.engine ?? null,
      setups[r.laneId]?.modelFile ?? null,
      setups[r.laneId]?.quant ?? null,
      setups[r.laneId]?.build ?? null,
      setups[r.laneId]?.slots ?? null,
      setups[r.laneId]?.contextPerSlot ?? null,
      setups[r.laneId]?.notes ?? null,
      settings.maxTokens ?? null,
      settings.thinking ?? null,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}

export interface SweepProgress {
  type: "sweep-progress";
  /** 1-based position of the race now starting, and how many there are. */
  index: number;
  total: number;
  preset: PresetId;
  concurrency: number;
  repeat: number;
  repeats: number;
}

export interface SweepDone {
  type: "sweep-done";
  rows: SweepRow[];
  csv: string;
  /** False when the sweep ended early: the page was closed, or STOP was pressed. */
  complete: boolean;
  /** True when it ended because STOP was pressed. */
  stopped?: boolean;
  /** Where the server saved the table, relative to the harness folder. Set by the server. */
  savedAs?: string;
}

export interface SweepWarmup {
  type: "sweep-warmup";
}

export type SweepEvent = SweepProgress | SweepDone | SweepWarmup;

export interface RunSweepOptions extends Omit<RunRaceOptions, "preset" | "concurrency" | "emit" | "runId"> {
  request: SweepRequest;
  /** Gets the sweep's own events and, unchanged, every event of every race in it. */
  emit: (event: RaceEvent | SweepEvent) => void;
  pauseMs?: number;
  /** Checked between races: true means the page is gone, so stop. */
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export async function runSweep(opts: RunSweepOptions): Promise<SweepDone> {
  const { request, emit, pauseMs = DEFAULT_PAUSE_MS, shouldStop, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
  const total = request.presets.length * request.concurrencies.length * request.repeats;
  const rows: SweepRow[] = [];
  let index = 0;
  let complete = true;
  let stoppedByUser = false;
  const mustStop = () => {
    if (opts.signal?.aborted) stoppedByUser = true;
    return stoppedByUser || (shouldStop?.() ?? false);
  };

  if (request.warmup && !mustStop()) {
    emit({ type: "sweep-warmup" } satisfies SweepWarmup);
    const { request: _r, emit: _e, pauseMs: _p, shouldStop: _s, sleep: _sl, ...raceOptions } = opts;
    // Not logged and not in the table: it exists only to be thrown away.
    await runRace({ ...raceOptions, logPath: null, laneIds: request.laneIds, preset: "short", concurrency: 1, emit });
    if (pauseMs > 0) await sleep(pauseMs);
  }

  outer: for (const preset of request.presets) {
    for (const concurrency of request.concurrencies) {
      const runs: LaneResult[][] = [];
      for (let repeat = 1; repeat <= request.repeats; repeat++) {
        if (mustStop()) {
          complete = false;
          break;
        }
        if (index > 0 && pauseMs > 0) await sleep(pauseMs);
        index++;
        emit({ type: "sweep-progress", index, total, preset, concurrency, repeat, repeats: request.repeats } satisfies SweepProgress);
        const { request: _r, emit: _e, pauseMs: _p, shouldStop: _s, sleep: _sl, ...raceOptions } = opts;
        const outcome = await runRace({
          ...raceOptions,
          laneIds: request.laneIds,
          preset,
          concurrency,
          emit,
        });
        // A race cut off by STOP is half a measurement. It stays in the run log,
        // marked stopped, and is left out of the table.
        if (opts.signal?.aborted) {
          stoppedByUser = true;
          complete = false;
          break;
        }
        runs.push(outcome.results);
      }
      // A cell stopped part way still reports the runs it did get to.
      if (runs.length > 0) rows.push(...summarizeCell(preset, concurrency, runs));
      if (!complete) break outer;
    }
  }

  const done: SweepDone = {
    type: "sweep-done",
    rows,
    csv: sweepCsv(rows, opts.laneSetups, { maxTokens: opts.config.maxTokens, thinking: opts.config.thinking ?? "auto" }),
    complete,
    ...(stoppedByUser ? { stopped: true } : {}),
  };
  emit(done);
  return done;
}

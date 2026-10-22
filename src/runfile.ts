/**
 * The file a finished race or sweep is saved as, so it can be charted and shared.
 *
 * It holds the numbers and how each machine was set up, and nothing that says
 * where a machine is: no address, no host name, no folder. A person can send it
 * to someone else, and the results page can draw their machines beside yours.
 */

import { baseName } from "./details.ts";
import type { MachineSetup } from "./details.ts";
import { summarizeCell } from "./sweep.ts";
import type { SweepRow } from "./sweep.ts";
import type { LaneResult, PresetId } from "./types.ts";

export const RUN_FORMAT = "llm-super-bench-run";
export const RUN_VERSION = 1;

export interface RunFileMachine {
  id: string;
  label: string;
  /** The short model name. Never a folder or an address. */
  model: string;
  setup: MachineSetup | null;
}

export interface RunFile {
  format: typeof RUN_FORMAT;
  version: typeof RUN_VERSION;
  kind: "race" | "sweep";
  createdAt: string;
  /** What was set for every machine in the run. A thinking model's numbers mean different things with these. */
  settings: { maxTokens: number; thinking: "auto" | "low" | "off" };
  /** False when a sweep was stopped before it finished. */
  complete: boolean;
  machines: RunFileMachine[];
  rows: SweepRow[];
}

export interface BuildRunFileOptions {
  kind: "race" | "sweep";
  rows: SweepRow[];
  lanes: { laneId: string; label: string; displayModel?: string; model: string }[];
  setups: Record<string, MachineSetup>;
  maxTokens: number;
  thinking?: "auto" | "low" | "off";
  complete?: boolean;
  now?: Date;
}

export function buildRunFile(o: BuildRunFileOptions): RunFile {
  const used = new Set(o.rows.map((r) => r.laneId));
  return {
    format: RUN_FORMAT,
    version: RUN_VERSION,
    kind: o.kind,
    createdAt: (o.now ?? new Date()).toISOString(),
    settings: { maxTokens: o.maxTokens, thinking: o.thinking ?? "auto" },
    complete: o.complete ?? true,
    machines: o.lanes
      .filter((l) => used.has(l.laneId))
      .map((l) => ({
        id: l.laneId,
        label: l.label,
        model: baseName(l.displayModel ?? l.model),
        setup: o.setups[l.laneId] ?? null,
      })),
    rows: o.rows,
  };
}

/** One race is one cell with one run: the same rows a sweep makes, so one page draws both. */
export function raceRows(preset: PresetId, concurrency: number, results: LaneResult[]): SweepRow[] {
  return summarizeCell(preset, concurrency, [results]);
}

/** A file with no finished machine in it is not worth keeping. */
export function hasFinishedRun(file: RunFile): boolean {
  return file.rows.some((r) => r.finished > 0);
}

/**
 * Planning the grid, and deciding what a resumed run may skip.
 *
 * A cell is one lane x one model x one prompt length. Lanes are separate
 * machines, so they run at the same time; the cells inside one lane run
 * strictly one after another, because two cells on one machine would measure
 * each other.
 */

import { modelKeyForRecord, modelKeyIndex, modelKeyOf, modelsForLane } from "./config.ts";
import type { BenchConfig, BenchRunRecord, Cell, GridPlan, LanePlan } from "./types.ts";

/**
 * A cell's identity as a map key. JSON, not a joined string, so a label
 * containing the separator cannot collide with a different cell.
 */
export function cellKey(laneLabel: string, modelKey: string, nominalLabel: string): string {
  return JSON.stringify([laneLabel, modelKey, nominalLabel]);
}

export function keyOfCell(cell: Cell): string {
  return cellKey(cell.laneLabel, cell.modelKey, cell.nominalLabel);
}

/**
 * A record's cell.
 *
 * Keyed on the model's IDENTITY, not on the id string it happened to be
 * recorded under. A run finished before models moved to uniform paths recorded
 * a per-machine path; keying on that string would make every one of its cells
 * look unfinished and re-run the lot.
 */
export function keyOfRecord(record: BenchRunRecord, index?: Map<string, string>): string {
  const key = index ? modelKeyForRecord(index, record) : (record.modelKey ?? record.modelId);
  return cellKey(record.laneLabel, key, record.nominalLabel);
}

/** A cell's name on screen and in the log. */
export function cellName(cell: Cell): string {
  return `${cell.laneLabel} · ${cell.modelName} · ${cell.nominalLabel}${cell.torture ? " (torture)" : ""}`;
}

/**
 * Builds the grid.
 *
 * Cells are grouped by model within a lane, so a managed lane starts each
 * server once and runs everything for that model before moving on. Prompt
 * lengths go shortest first: the quick cells are done before the long ones, so
 * a grid that gets killed early still has something in it.
 */
export function buildGrid(config: BenchConfig): GridPlan {
  const lanes: LanePlan[] = config.lanes.map((lane) => {
    const cells: Cell[] = [];
    for (const model of modelsForLane(config, lane)) {
      for (const length of config.promptLengths) {
        cells.push({
          laneLabel: lane.label,
          modelId: model.id,
          modelKey: modelKeyOf(model),
          modelName: model.name,
          nominalLabel: length.label,
          nominalTokens: length.tokens,
          measuredRuns: config.measuredRuns,
          torture: false,
        });
      }
      // A torture cell rides on the end of its own model's block, while that
      // model's server is already up.
      for (const t of config.torture) {
        if (t.lane !== lane.label || t.model !== model.id) continue;
        cells.push({
          laneLabel: lane.label,
          modelId: model.id,
          modelKey: modelKeyOf(model),
          modelName: model.name,
          nominalLabel: t.label ?? String(t.tokens),
          nominalTokens: t.tokens,
          measuredRuns: 1,
          torture: true,
        });
      }
    }
    return { laneLabel: lane.label, managed: lane.ssh !== undefined, cells };
  });

  const totalCells = lanes.reduce((n, l) => n + l.cells.length, 0);
  const totalRuns = lanes.reduce((n, l) => n + l.cells.reduce((m, c) => m + c.measuredRuns, 0), 0);
  return { lanes, totalCells, totalRuns };
}

/**
 * How many measured runs a cell already has on disk. Warm-ups never count:
 * they are discarded by definition, so a resumed grid still warms up.
 */
export function completedRunsByCell(
  records: BenchRunRecord[],
  index?: Map<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.warmup) continue;
    const key = keyOfRecord(r, index);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface ResumeDecision {
  cell: Cell;
  done: number;
  /** Runs still owed. Zero means skip the cell entirely. */
  remaining: number;
  skip: boolean;
}

/**
 * What a resumed grid owes.
 *
 * A recorded run counts whatever it says -- good, failed or invalid. Re-running
 * a cell that already produced its N attempts would quietly change the sample
 * after the fact, and the point of the log is that it is the record. `--force`
 * is how you say you meant it.
 */
export function resumePlan(
  cells: Cell[],
  records: BenchRunRecord[],
  force: boolean,
  index?: Map<string, string>,
): ResumeDecision[] {
  const counts = force ? new Map<string, number>() : completedRunsByCell(records, index);
  return cells.map((cell) => {
    const done = counts.get(keyOfCell(cell)) ?? 0;
    const remaining = Math.max(0, cell.measuredRuns - done);
    return { cell, done, remaining, skip: remaining === 0 };
  });
}

/**
 * A rough clock for the whole grid, in seconds.
 *
 * Deliberately rough, and said to be rough wherever it is shown. Generation
 * time is the output cap divided by an assumed rate; prefill is the nominal
 * prompt size divided by an assumed rate. Neither is measured yet -- that is
 * the entire point of the run about to start.
 */
export interface EstimateAssumptions {
  writeTokensPerSec: number;
  readTokensPerSec: number;
  /** Seconds of overhead per model on a managed lane: load the weights, poll. */
  modelStartSec: number;
}

export const DEFAULT_ASSUMPTIONS: EstimateAssumptions = {
  writeTokensPerSec: 40,
  readTokensPerSec: 500,
  modelStartSec: 60,
};

export function estimateLaneSeconds(
  plan: LanePlan,
  decisions: ResumeDecision[],
  config: BenchConfig,
  assume: EstimateAssumptions = DEFAULT_ASSUMPTIONS,
): number {
  const byCell = new Map(decisions.map((d) => [keyOfCell(d.cell), d]));
  let seconds = 0;
  const modelsSeen = new Set<string>();

  for (const cell of plan.cells) {
    const decision = byCell.get(keyOfCell(cell));
    if (!decision || decision.skip) continue;

    const runs = decision.remaining + config.warmupRuns;
    const perRun = cell.nominalTokens / assume.readTokensPerSec + config.outputCap / assume.writeTokensPerSec;
    seconds += runs * perRun;
    // Rests sit between cells, not after the last one; close enough at this
    // resolution, and it is labelled rough everywhere it appears.
    seconds += config.restSeconds;

    if (plan.managed && !modelsSeen.has(cell.modelId)) {
      modelsSeen.add(cell.modelId);
      seconds += assume.modelStartSec;
    }
  }
  return seconds;
}

/** The grid takes as long as its slowest lane: lanes run at the same time. */
export function estimateGridSeconds(
  grid: GridPlan,
  decisionsByLane: Map<string, ResumeDecision[]>,
  config: BenchConfig,
  assume: EstimateAssumptions = DEFAULT_ASSUMPTIONS,
): number {
  let longest = 0;
  for (const lane of grid.lanes) {
    const seconds = estimateLaneSeconds(lane, decisionsByLane.get(lane.laneLabel) ?? [], config, assume);
    if (seconds > longest) longest = seconds;
  }
  return longest;
}

/** "1h 12m" / "4m 30s" / "12s". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
}

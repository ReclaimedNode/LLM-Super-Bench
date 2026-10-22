/**
 * Turning runs into numbers, and deciding which runs are allowed to become
 * numbers at all.
 *
 * The headline of a cell is the MEDIAN, never the mean, with the lowest and
 * highest beside it. A mean of five runs hides the one that was three times
 * slower; the range does not.
 */

import { computeRate, median } from "../timing.ts";
import type { TextField } from "../types.ts";
import { keyOfRecord } from "./plan.ts";
import { modelKeyForRecord } from "./config.ts";
import type { BenchRunRecord, Cell, CellStat, Stat3 } from "./types.ts";

/** A run whose output fell below this share of the cap did not run to the cap. */
export const SHORT_OUTPUT_RATIO = 0.9;

export function stat3(values: number[]): Stat3 | null {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  const mid = median(nums);
  if (mid === null) return null;
  return { median: mid, low: Math.min(...nums), high: Math.max(...nums), n: nums.length };
}

/**
 * Reading speed: TRUE prompt tokens divided by the seconds spent waiting for
 * the first word.
 *
 * True tokens, from the server's usage frame -- never the nominal size, which
 * is a label on a button. The wait is first-word, not first-response: a server
 * that opens with an empty chunk has answered but has not read anything yet.
 */
export function readingSpeed(truePromptTokens: number | null, firstWordSec: number | null): number | null {
  if (truePromptTokens === null || firstWordSec === null) return null;
  if (!(truePromptTokens > 0) || !(firstWordSec > 0)) return null;
  return truePromptTokens / firstWordSec;
}

/**
 * Writing speed, using the repo's existing formula over true output tokens:
 * (count - 1) / (last piece - first piece). Not count / total, which would
 * punish a lane twice for one slow prefill.
 */
export function writingSpeed(record: BenchRunRecord): number | null {
  const count = record.outputTokens;
  if (count === null) return null;
  return computeRate(count, record.firstWordSec, record.lastWordSec);
}

export interface Verdict {
  /** May this run become a number? */
  usable: boolean;
  /** Why not, if not. */
  invalidReason: string | null;
  /** Marks that are shown whether or not the run is usable. */
  flags: string[];
}

/**
 * Whether a run counts, and why.
 *
 * Three ways to not count:
 *  - it errored, so there is nothing to count;
 *  - the server served part of the prompt from cache, so its reading speed is
 *    a measurement of the cache, not of the machine;
 *  - it stopped short of the cap, so its numbers describe a different amount of
 *    work from the rest of the cell.
 *
 * All three stay in the log and are shown on the board. Excluded is not the
 * same as hidden, and a number that quietly vanished is worse than one that is
 * marked.
 */
export function judgeRun(record: BenchRunRecord, outputCap: number): Verdict {
  const flags: string[] = [];

  if (record.error !== null) {
    return { usable: false, invalidReason: `failed: ${record.error}`, flags: ["failed"] };
  }
  if (record.cachedTokens !== null && record.cachedTokens > 0) {
    flags.push("cached");
    return {
      usable: false,
      invalidReason: `the server served ${record.cachedTokens} prompt tokens from cache, so this run had a head start`,
      flags,
    };
  }
  if (record.outputTokens === null || record.promptTokens === null) {
    return {
      usable: false,
      invalidReason: "the server reported no token usage, so there are no true counts to divide by",
      flags: ["no-usage"],
    };
  }
  if (record.outputTokens < outputCap * SHORT_OUTPUT_RATIO) {
    flags.push("short-output");
    return {
      usable: false,
      invalidReason: `stopped at ${record.outputTokens} of the ${outputCap}-token cap, under ${Math.round(SHORT_OUTPUT_RATIO * 100)}%`,
      flags,
    };
  }
  if (record.firstWordField !== null && record.firstWordField !== "content") {
    flags.push(`first word arrived as ${record.firstWordField}`);
  }
  return { usable: true, invalidReason: null, flags };
}

/** Applies the verdict to a record, in place of the runner having to know it. */
export function markRun(record: BenchRunRecord, outputCap: number): BenchRunRecord {
  const verdict = judgeRun(record, outputCap);
  return { ...record, invalidReason: verdict.invalidReason, flags: verdict.flags };
}

function uniqueField(records: BenchRunRecord[]): TextField | null {
  const fields = new Set(records.map((r) => r.firstWordField).filter((f): f is TextField => f !== null));
  return fields.size === 1 ? [...fields][0]! : null;
}

/** One cell's summary over the runs recorded for it. */
export function summariseCell(cell: Cell, records: BenchRunRecord[], outputCap: number): CellStat {
  const measured = records.filter((r) => !r.warmup);
  const judged = measured.map((r) => ({ record: r, verdict: judgeRun(r, outputCap) }));
  const used = judged.filter((j) => j.verdict.usable).map((j) => j.record);

  const failed = judged.filter((j) => j.record.error !== null).length;
  const cachedInvalid = judged.filter((j) => j.verdict.flags.includes("cached")).length;
  const shortOutput = judged.filter((j) => j.verdict.flags.includes("short-output")).length;

  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed} of ${measured.length} runs failed.`);
  if (cachedInvalid > 0) {
    notes.push(`${cachedInvalid} run(s) excluded: the server served part of the prompt from cache.`);
  }
  if (shortOutput > 0) {
    notes.push(
      `${shortOutput} run(s) excluded: output stopped under ${Math.round(SHORT_OUTPUT_RATIO * 100)}% of the ${outputCap}-token cap.`,
    );
  }
  const noUsage = judged.filter((j) => j.verdict.flags.includes("no-usage")).length;
  if (noUsage > 0) notes.push(`${noUsage} run(s) excluded: the server reported no token usage.`);

  const field = uniqueField(used);
  if (field !== null && field !== "content") {
    notes.push(`The first word arrived in the \`${field}\` field, not \`content\`: this model streamed its thinking first.`);
  }

  let status: CellStat["status"];
  if (measured.length === 0) status = "not-run";
  else if (used.length === 0) status = failed === measured.length ? "failed" : "no-valid-runs";
  else if (used.length < measured.length) status = "partial";
  else status = "ok";

  const fingerprints = [...new Set(measured.map((r) => r.systemFingerprint).filter((f): f is string => f !== null))];
  if (fingerprints.length > 1) {
    notes.push(`The server reported more than one version during this cell: ${fingerprints.join(" / ")}.`);
  }

  return {
    laneLabel: cell.laneLabel,
    modelId: cell.modelId,
    modelKey: cell.modelKey,
    modelName: cell.modelName,
    nominalLabel: cell.nominalLabel,
    nominalTokens: cell.nominalTokens,
    torture: cell.torture,
    status,
    runsRecorded: measured.length,
    runsUsed: used.length,
    failed,
    cachedInvalid,
    shortOutput,
    readSpeed: stat3(
      used.map((r) => readingSpeed(r.promptTokens, r.firstWordSec)).filter((v): v is number => v !== null),
    ),
    writeSpeed: stat3(used.map(writingSpeed).filter((v): v is number => v !== null)),
    firstWordSec: stat3(used.map((r) => r.firstWordSec).filter((v): v is number => v !== null)),
    totalSec: stat3(used.map((r) => r.totalSec).filter((v): v is number => v !== null)),
    truePromptTokens: stat3(used.map((r) => r.promptTokens).filter((v): v is number => v !== null)),
    trueOutputTokens: stat3(used.map((r) => r.outputTokens).filter((v): v is number => v !== null)),
    firstWordField: field,
    fingerprints,
    notes,
  };
}

/**
 * Every cell in the grid, summarised from the log.
 *
 * `index` maps every id a model has ever been known by to its key, so records
 * written before models moved to uniform paths still land in the right cell.
 */
export function summariseCells(
  cells: Cell[],
  records: BenchRunRecord[],
  outputCap: number,
  index?: Map<string, string>,
): CellStat[] {
  const byCell = new Map<string, BenchRunRecord[]>();
  for (const r of records) {
    const key = keyOfRecord(r, index);
    const arr = byCell.get(key);
    if (arr) arr.push(r);
    else byCell.set(key, [r]);
  }
  return cells.map((cell) =>
    summariseCell(cell, byCell.get(JSON.stringify([cell.laneLabel, cell.modelKey, cell.nominalLabel])) ?? [], outputCap),
  );
}

/**
 * "Lane B reads 3.8x faster and writes 1.4x faster than Lane A on this model."
 *
 * Returns null when there is nothing to compare, rather than a sentence with a
 * hole in it.
 */
export interface LaneSpeeds {
  label: string;
  read: number | null;
  write: number | null;
}

interface Winner {
  verb: "reads" | "writes";
  ratio: number;
  fast: string;
  slow: string;
}

function winnerOf(verb: Winner["verb"], a: LaneSpeeds, b: LaneSpeeds, pick: (l: LaneSpeeds) => number | null): Winner | null {
  const av = pick(a);
  const bv = pick(b);
  if (av === null || bv === null || !(av > 0) || !(bv > 0)) return null;
  const [fast, slow] = av >= bv ? [av, bv] : [bv, av];
  const [fastLabel, slowLabel] = av >= bv ? [a.label, b.label] : [b.label, a.label];
  return { verb, ratio: fast / slow, fast: fastLabel, slow: slowLabel };
}

export function compareSentence(a: LaneSpeeds, b: LaneSpeeds): string | null {
  const read = winnerOf("reads", a, b, (l) => l.read);
  const write = winnerOf("writes", a, b, (l) => l.write);
  const both = [read, write].filter((w): w is Winner => w !== null);
  if (both.length === 0) return null;

  // When one lane wins both, name it once: "X reads 3.8x faster and writes
  // 1.4x faster than Y". When they split, each half gets its own clause,
  // because "X reads faster but writes slower" is a different fact and
  // flattening it into one comparison would be a lie.
  if (read && write && read.fast === write.fast) {
    return `${read.fast} reads ${read.ratio.toFixed(1)}x faster and writes ${write.ratio.toFixed(1)}x faster than ${read.slow} on this model.`;
  }
  return `${both.map((w) => `${w.fast} ${w.verb} ${w.ratio.toFixed(1)}x faster than ${w.slow}`).join("; ")} on this model.`;
}

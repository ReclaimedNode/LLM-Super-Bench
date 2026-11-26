/**
 * Sustained streams: the most streams a machine carried cleanly in a sweep.
 *
 * A sweep over several stream counts already holds the answer to "how many at
 * once can this machine really take?", spread over its rows. This file reads it
 * out. For each machine and prompt size it climbs the stream counts the sweep
 * ran, lowest first, and stops at the first one that was not clean. The last
 * clean one is the figure.
 *
 * A stream count is clean when every run asked for finished, no stream in any
 * of them failed, and the machine was not asked for more than it runs at once
 * (streams past that wait in its queue, so they are not running together).
 *
 * Two things the figure is not. It is not a limit when nothing failed: a sweep
 * that topped out at 8 with every level clean says "at least 8", and the
 * sentence says so. And it says nothing about speed: a machine can sustain 16
 * streams that each crawl. Read it beside ALL STREAMS.
 */

import { peakText } from "./memory.ts";
import type { MemoryPeak } from "./memory.ts";
import type { PresetId } from "./types.ts";

/** The part of a sweep row this needs. A SweepRow is one. */
export interface SustainedInput {
  preset: PresetId;
  concurrency: number;
  laneId: string;
  label: string;
  repeats: number;
  finished: number;
  failedStreams?: number;
  slots?: number | null;
  memory?: MemoryPeak | null;
}

export type SustainedStop = "failed-runs" | "failed-streams" | "queue";

export interface SustainedRow {
  preset: PresetId;
  laneId: string;
  label: string;
  /** The highest clean stream count. Null when even the lowest one tried was not clean. */
  sustained: number | null;
  /** The highest stream count the sweep ran for this machine and size. */
  top: number;
  /** The first stream count that was not clean. Null when every one was, so `sustained` is "at least". */
  stoppedAt: number | null;
  /** What was wrong at `stoppedAt`. */
  stop: SustainedStop | null;
  /** The whole fact as one sentence. */
  sentence: string;
}

function whyNotClean(row: SustainedInput): SustainedStop | null {
  if (row.finished < row.repeats) return "failed-runs";
  if ((row.failedStreams ?? 0) > 0) return "failed-streams";
  if (typeof row.slots === "number" && row.concurrency > row.slots) return "queue";
  return null;
}

const streams = (n: number) => `${n} stream${n === 1 ? "" : "s"}`;

function sentenceFor(label: string, preset: string, sustained: number | null, top: number, bad: SustainedInput | null, stop: SustainedStop | null): string {
  const at = `at ${preset}`;
  if (bad === null || stop === null) {
    return `${label} sustained ${streams(top)} ${at}, the most this sweep asked for, so its limit is at least that.`;
  }
  let what: string;
  if (stop === "queue") {
    what = `it runs ${bad.slots} at a time, so at ${bad.concurrency} the rest waited in its queue`;
  } else if (stop === "failed-runs") {
    const lost = bad.repeats - bad.finished;
    what = `at ${bad.concurrency}, ${lost} of ${bad.repeats} run${bad.repeats === 1 ? "" : "s"} did not finish`;
  } else {
    const asked = bad.concurrency * bad.finished;
    what = `at ${bad.concurrency}, ${bad.failedStreams} of ${asked} streams failed`;
  }
  // Stated beside the failure, not as its cause: the tool saw both, and only that.
  const memory = stop !== "queue" && bad.memory ? ` Memory at ${bad.concurrency}: ${peakText(bad.memory)}.` : "";
  const head = sustained === null
    ? `${label} did not sustain ${streams(bad.concurrency)} ${at}, the fewest this sweep asked for`
    : `${label} sustained ${streams(sustained)} ${at}`;
  return `${head}: ${what}.${memory}`;
}

/**
 * One row per machine and prompt size that the sweep ran at two or more stream
 * counts. One stream count is a measurement, not a climb, so it gets no row.
 */
export function sustainedStreams(rows: SustainedInput[]): SustainedRow[] {
  const groups = new Map<string, SustainedInput[]>();
  for (const row of rows) {
    const key = `${row.preset}\u0000${row.laneId}`;
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }

  const out: SustainedRow[] = [];
  for (const list of groups.values()) {
    const levels = [...list].sort((a, b) => a.concurrency - b.concurrency);
    if (levels.length < 2) continue;
    let sustained: number | null = null;
    let bad: SustainedInput | null = null;
    let stop: SustainedStop | null = null;
    for (const level of levels) {
      stop = whyNotClean(level);
      if (stop !== null) {
        bad = level;
        break;
      }
      sustained = level.concurrency;
    }
    const head = levels[0]!;
    const top = levels.at(-1)!.concurrency;
    out.push({
      preset: head.preset,
      laneId: head.laneId,
      label: head.label,
      sustained,
      top,
      stoppedAt: bad?.concurrency ?? null,
      stop: bad ? stop : null,
      sentence: sentenceFor(head.label, head.preset, sustained, top, bad, bad ? stop : null),
    });
  }
  return out;
}

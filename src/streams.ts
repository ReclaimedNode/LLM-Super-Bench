/**
 * Several streams on one machine.
 *
 * With concurrency above one, every lane sends the same number of requests at
 * the same instant, and each request is a stream. This file turns a lane's
 * streams back into the one LaneResult the rest of the tool already knows how to
 * score, log and show.
 *
 * What the lane's numbers become, and why each is named as it is:
 *
 *   first word      the MEDIAN of the streams. With four streams there are four
 *                   first words; the one in the middle is what a typical user
 *                   waited, and no stream's number is thrown away.
 *   last word       the LATEST of the streams, which closes the window the
 *                   combined throughput is measured over.
 *   total           the LATEST of the streams: how long until all of them were done.
 *   chunks, tokens  the SUM.
 *
 * Speed per stream and throughput are not stored on the result. They are worked
 * out from `streams` by timing.ts, so a number cannot drift from the samples it
 * came from.
 */

import { median } from "./timing.ts";
import type { LaneResult, StreamSample } from "./types.ts";

/** The powers of two from 1 up to `max`, which is what the page offers. */
export function concurrencyOptions(max: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n *= 2) out.push(n);
  return out;
}

/** The run id of stream `index` (0-based) out of `total`. One stream keeps the plain id. */
export function streamRunId(runId: string, index: number, total: number): string {
  if (total <= 1) return runId;
  // Padded to one width so no stream's prompt is a character longer than another's.
  const width = String(total).length;
  return `${runId}-s${String(index + 1).padStart(width, "0")}`;
}

function sampleOf(r: LaneResult): StreamSample {
  return {
    firstWordSec: r.firstWordSec,
    lastWordSec: r.lastWordSec,
    chunks: r.chunks,
    tokens: r.tokens,
    totalSec: r.totalSec,
  };
}

function nonNull(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

/**
 * One result for a lane that ran `results.length` streams. A single stream
 * comes back unchanged, so an ordinary race produces exactly what it always did.
 */
export function combineStreams(results: LaneResult[]): LaneResult {
  if (results.length === 0) throw new Error("combineStreams needs at least one stream");
  if (results.length === 1) return results[0]!;

  const total = results.length;
  const ok = results.filter((r) => !r.error && r.totalSec !== null);
  const failed = total - ok.length;
  const head = results[0]!;

  if (ok.length === 0) {
    return {
      ...head,
      concurrency: total,
      failedStreams: total,
      streams: [],
      error: results.every((r) => r.stopped)
        ? head.error
        : `all ${total} streams failed: ${head.error ?? "no reason given"}`,
      ...(results.every((r) => r.stopped) ? { stopped: true } : {}),
    };
  }

  const first = ok[0]!;
  const lastWords = nonNull(ok.map((r) => r.lastWordSec));
  const totals = nonNull(ok.map((r) => r.totalSec));
  // Tokens only when every stream that finished reported them. A sum over some
  // of the streams is not a token count of anything.
  const everyTokens = ok.every((r) => r.tokens !== null);

  return {
    ...first,
    firstResponseSec: median(nonNull(ok.map((r) => r.firstResponseSec))),
    firstWordSec: median(nonNull(ok.map((r) => r.firstWordSec))),
    lastWordSec: lastWords.length > 0 ? Math.max(...lastWords) : null,
    chunks: ok.reduce((sum, r) => sum + r.chunks, 0),
    tokens: everyTokens ? ok.reduce((sum, r) => sum + (r.tokens as number), 0) : null,
    tokenSource: everyTokens ? "usage" : null,
    // Every stream's prompt is the same size bar its run-id, so one stream's
    // true count stands for them. A cache hit on ANY stream is the one to keep.
    cachedTokens: Math.max(...ok.map((r) => r.cachedTokens ?? 0)) || (first.cachedTokens ?? null),
    totalSec: totals.length > 0 ? Math.max(...totals) : null,
    error: null,
    usageSupported: ok.every((r) => r.usageSupported === true),
    concurrency: total,
    failedStreams: failed,
    streams: ok.map(sampleOf),
  };
}

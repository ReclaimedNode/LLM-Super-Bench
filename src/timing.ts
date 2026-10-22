/**
 * Timing and scoring math. Pure functions only, so the numbers on screen can be
 * tested without a network or a browser.
 */

import type { LaneResult, Scoreboard, ScoreboardEntry, StreamSample } from "./types.ts";

/** Monotonic clock. Never Date.now(), which can jump. */
export function monotonicNow(): number {
  return performance.now();
}

/** Milliseconds between two monotonic readings, as seconds, rounded to microseconds. */
export function elapsedSeconds(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) * 1000) / 1_000_000;
}

/**
 * Generation speed after the first word.
 *
 *   (count - 1) / (time of last piece - time of first piece)
 *
 * Deliberately NOT count / total time. Total time includes the wait before the
 * first word, so dividing by it understates the speed of whichever lane waited
 * longest -- it would punish a lane twice for one slow prefill, once in its
 * first-word number and again in its speed.
 *
 * It is count MINUS ONE because N pieces have N-1 gaps between them, and the
 * window measured is the gaps, not the pieces. One piece has no window and no
 * speed.
 *
 * The same formula serves the live readout, passing the last piece received so
 * far as `lastPieceSec`.
 */
export function computeRate(
  count: number,
  firstPieceSec: number | null,
  lastPieceSec: number | null,
): number | null {
  if (firstPieceSec === null || lastPieceSec === null) return null;
  if (count < 2) return null;
  const window = lastPieceSec - firstPieceSec;
  if (!(window > 0)) return null;
  return (count - 1) / window;
}

export type SpeedUnit = "tokens/sec" | "chunks/sec";

function unitsOf(sample: { chunks: number; tokens: number | null }, unit: SpeedUnit): number | null {
  return unit === "tokens/sec" ? sample.tokens : sample.chunks;
}

/**
 * The speed of ONE stream, taken as the median over the streams of a lane that
 * ran several at once. Each stream's own rate is the ordinary formula, so with
 * one stream this is exactly `computeRate`.
 */
export function medianStreamRate(streams: StreamSample[], unit: SpeedUnit): number | null {
  const rates: number[] = [];
  for (const s of streams) {
    const units = unitsOf(s, unit);
    if (units === null) continue;
    const rate = computeRate(units, s.firstWordSec, s.lastWordSec);
    if (rate !== null) rates.push(rate);
  }
  return median(rates);
}

/**
 * Every stream of a lane, together.
 *
 *   sum of (count - 1) over the streams
 *   ---------------------------------------------------
 *   (latest last piece) - (earliest first piece)
 *
 * It is the speed formula with the gaps added up and the window widened to
 * cover all of them, so with one stream it IS the speed formula. Like speed it
 * leaves out the wait before the first word: a lane that prefilled slowly is
 * already marked down on first word and is not marked down twice.
 *
 * A stream with no measurable pieces adds nothing, and is left out of the
 * window as well.
 */
export function throughput(streams: StreamSample[], unit: SpeedUnit): number | null {
  let gaps = 0;
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const s of streams) {
    const units = unitsOf(s, unit);
    if (units === null || units < 1 || s.firstWordSec === null || s.lastWordSec === null) continue;
    gaps += units - 1;
    first = Math.min(first, s.firstWordSec);
    last = Math.max(last, s.lastWordSec);
  }
  if (!(last > first) || gaps <= 0) return null;
  return gaps / (last - first);
}

/**
 * How fast a machine took in the prompt: the server's own count of prompt
 * tokens over the seconds to the first word. That wait also holds the first
 * generated token and the network, so it reads a little low; at 32K and up the
 * prompt is nearly all of it. Null wherever the division would mislead:
 *
 *   several streams   they share one prefill and queue behind each other
 *   a thinking model  its first word is not the end of prefill
 *   a cache hit       tokens that were never processed would be counted
 *   no usage report   the prompt token count would be a guess
 *   a short prompt    under 500 tokens the wait is mostly the first generated token
 */
/** Below this the wait is mostly the first generated token, so the division says nothing about the prompt. */
export const MIN_PROMPT_TOKENS_FOR_SPEED = 500;

export function promptSpeed(
  r: Pick<LaneResult, "promptTokens" | "firstWordSec" | "firstWordField" | "cachedTokens" | "concurrency" | "error" | "blocked">,
): number | null {
  if (r.error || r.blocked) return null;
  if ((r.concurrency ?? 1) > 1) return null;
  if (r.firstWordField !== "content") return null;
  if ((r.cachedTokens ?? 0) > 0) return null;
  if (r.promptTokens === null || !(r.promptTokens >= MIN_PROMPT_TOKENS_FOR_SPEED)) return null;
  if (r.firstWordSec === null || !(r.firstWordSec > 0)) return null;
  return r.promptTokens / r.firstWordSec;
}

/** What a lane's SPEED is: one stream's, or the median of one stream's when it ran several. */
export function laneSpeed(
  r: Pick<LaneResult, "firstWordSec" | "lastWordSec" | "chunks" | "tokens" | "streams">,
  unit: SpeedUnit,
): number | null {
  if (r.streams && r.streams.length > 1) return medianStreamRate(r.streams, unit);
  const units = unitsOf(r, unit);
  if (units === null) return null;
  return computeRate(units, r.firstWordSec, r.lastWordSec);
}

/** Every stream together. Null for a lane that ran one stream: there is nothing to add up. */
export function laneThroughput(
  r: Pick<LaneResult, "streams">,
  unit: SpeedUnit,
): number | null {
  if (!r.streams || r.streams.length < 2) return null;
  return throughput(r.streams, unit);
}

export function median(values: number[]): number | null {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = nums.length >> 1;
  if (nums.length % 2 === 1) return nums[mid]!;
  return (nums[mid - 1]! + nums[mid]!) / 2;
}

/** How many times better `best` is than `next`, for a measure where lower wins. */
export function ratioLowerIsBetter(best: number, next: number): number | null {
  if (!(best > 0) || !Number.isFinite(next)) return null;
  return next / best;
}

/** How many times better `best` is than `next`, for a measure where higher wins. */
export function ratioHigherIsBetter(best: number, next: number): number | null {
  if (!(next > 0) || !Number.isFinite(best)) return null;
  return best / next;
}

/** One decimal place, e.g. 3.2. */
export function formatRatio(ratio: number): string {
  return `${ratio.toFixed(1)}x`;
}

export function formatSeconds(sec: number): string {
  if (sec < 10) return `${sec.toFixed(2)}s`;
  return `${sec.toFixed(1)}s`;
}

interface Ranked {
  label: string;
  value: number;
}

function rank(items: Ranked[], lowerIsBetter: boolean): Ranked[] {
  return [...items].sort((a, b) => (lowerIsBetter ? a.value - b.value : b.value - a.value));
}

/**
 * Names the winner of each measure and states the gap in plain words.
 *
 * Only lanes that actually finished are scored. A lane that errored, was
 * blocked at preflight, or never produced a word is named in `notes` instead.
 */
export function buildScoreboard(results: LaneResult[]): Scoreboard {
  const notes: string[] = [];
  const entries: ScoreboardEntry[] = [];

  // Streams per machine. Every lane of a race runs the same number, so the
  // largest is the race's.
  const concurrency = Math.max(1, ...results.map((r) => r.concurrency ?? 1));
  const several = concurrency > 1;

  for (const r of results) {
    // `blocked` already reads as a sentence naming the lane, so it stands alone.
    if (r.blocked) notes.push(r.blocked);
    else if (r.stopped) notes.push(`${r.label} was stopped before it finished, so it is not scored.`);
    else if (r.error) notes.push(`${r.label} failed: ${r.error}`);
    else if (r.slots !== undefined && (r.concurrency ?? 1) > r.slots) {
      const ran = r.concurrency ?? 1;
      notes.push(
        `${r.label} runs ${r.slots} at a time, so ${ran - r.slots} of the ${ran} streams waited in its queue. Its first word and total include that wait, so they are not like for like.`,
      );
    }
    if (!r.blocked && !r.error && (r.cachedTokens ?? 0) > 0) {
      notes.push(
        `${r.label}'s server reused ${r.cachedTokens!.toLocaleString("en-US")} prompt tokens from its cache, so its first word had a head start and is not like for like. Prompt speed is left blank for it.`,
      );
    }
    if (!r.blocked && !r.error && !r.stopped && r.tokens !== null && r.tokens > 0 && r.tokens < 8) {
      notes.push(
        `${r.label} wrote only ${r.tokens} token${r.tokens === 1 ? "" : "s"}, so its speed means little. Check that it is answering (a thinking model can use the whole reply length thinking).`,
      );
    }
    if (!r.blocked && !r.error && r.failedStreams && r.failedStreams > 0) {
      const ran = r.concurrency ?? 1;
      notes.push(
        `${r.label}: ${r.failedStreams} of ${ran} streams failed. Its numbers are over the ${ran - r.failedStreams} that finished, so they are not like for like.`,
      );
    }
  }

  const finished = results.filter((r) => !r.error && !r.blocked && r.totalSec !== null);

  // Speed unit: tokens only if EVERY finished lane reported real usage.
  const everyLaneHasTokens = finished.length > 0 && finished.every((r) => r.tokens !== null);
  const speedUnit: "tokens/sec" | "chunks/sec" = everyLaneHasTokens ? "tokens/sec" : "chunks/sec";
  if (!everyLaneHasTokens && finished.length > 0) {
    notes.push(
      "Speed is counted in streamed chunks, not tokens: at least one endpoint did not report token usage.",
    );
  }

  // Every lane's rate in the one unit the race settled on. With several
  // streams this is the median speed of ONE stream.
  const laneRates = results.map((r) => ({
    laneId: r.laneId,
    rate: r.error || r.blocked ? null : laneSpeed(r, speedUnit),
  }));

  // Every stream of a lane together. Only when there were several: with one
  // stream it would just be the speed again under a second name.
  const laneThroughputs = several
    ? results.map((r) => ({
        laneId: r.laneId,
        rate: r.error || r.blocked ? null : laneThroughput(r, speedUnit),
      }))
    : [];

  const lanePromptSpeeds = results.map((r) => ({
    laneId: r.laneId,
    rate: promptSpeed(r),
    promptTokens: r.promptTokens,
  }));

  if (finished.length === 0) {
    notes.push("No lane finished, so there is nothing to score.");
    return { speedUnit, entries, laneRates, laneThroughputs, concurrency, lanePromptSpeeds, notes };
  }

  const median_of = several ? ` (median of ${concurrency} streams)` : "";

  // One machine picked on purpose is a result, not a field of one that won by
  // default. When two raced and one fell over, "the only lane" is the news, so
  // that wording stays for that case.
  const solo = results.length === 1;

  // --- First word (lower wins) ---
  const firstWord = finished
    .filter((r) => r.firstWordSec !== null)
    .map((r) => ({ label: r.label, value: r.firstWordSec as number }));
  if (firstWord.length > 0) {
    const sorted = rank(firstWord, true);
    const win = sorted[0]!;
    const next = sorted[1] ?? null;
    const ratio = next ? ratioLowerIsBetter(win.value, next.value) : null;
    entries.push({
      measure: "First word",
      unit: "seconds",
      winnerLabel: win.label,
      winnerValue: win.value,
      runnerUpLabel: next?.label ?? null,
      runnerUpValue: next?.value ?? null,
      ratio,
      sentence: next
        ? `${win.label} reached the first word ${ratio ? formatRatio(ratio) : "?"} faster than ${next.label}${median_of} — ${formatSeconds(win.value)} against ${formatSeconds(next.value)}.`
        : solo
          ? `${win.label} reached the first word in ${formatSeconds(win.value)}${median_of}.`
          : `${win.label} was the only lane to produce a word, at ${formatSeconds(win.value)}.`,
    });
  }

  // --- Speed (higher wins) ---
  const speeds = finished
    .map((r) => {
      const rate = laneSpeed(r, speedUnit);
      return rate === null ? null : { label: r.label, value: rate };
    })
    .filter((x): x is Ranked => x !== null);
  if (speeds.length > 0) {
    const sorted = rank(speeds, false);
    const win = sorted[0]!;
    const next = sorted[1] ?? null;
    const ratio = next ? ratioHigherIsBetter(win.value, next.value) : null;
    const noun = speedUnit === "tokens/sec" ? "tokens" : "chunks";
    entries.push({
      measure: "Speed",
      unit: speedUnit,
      winnerLabel: win.label,
      winnerValue: win.value,
      runnerUpLabel: next?.label ?? null,
      runnerUpValue: next?.value ?? null,
      ratio,
      sentence: next
        ? `${win.label} streamed ${ratio ? formatRatio(ratio) : "?"} more ${noun} per second${several ? " per stream" : ""} than ${next.label}${median_of} — ${win.value.toFixed(1)} against ${next.value.toFixed(1)}.`
        : solo
          ? `${win.label} streamed ${win.value.toFixed(1)} ${speedUnit}${several ? ` per stream${median_of}` : ""}.`
          : `${win.label} was the only lane with a measurable speed, at ${win.value.toFixed(1)} ${speedUnit}${several ? " per stream" : ""}.`,
    });
  }

  // --- Throughput (higher wins), only when each machine ran several streams ---
  // Compared only between lanes whose every stream finished: a lane that lost
  // streams carried less load, and ranking it would flatter or punish it.
  if (several) {
    const noun = speedUnit === "tokens/sec" ? "tokens" : "chunks";
    const whole = finished.filter((r) => !r.failedStreams);
    const totals = whole
      .map((r) => {
        const rate = laneThroughput(r, speedUnit);
        return rate === null ? null : { label: r.label, value: rate };
      })
      .filter((x): x is Ranked => x !== null);
    for (const r of finished) {
      if (r.failedStreams) {
        notes.push(`${r.label} is left out of throughput: only ${(r.concurrency ?? 1) - r.failedStreams} of its ${r.concurrency ?? 1} streams finished.`);
      }
    }
    if (totals.length > 0) {
      const sorted = rank(totals, false);
      const win = sorted[0]!;
      const next = sorted[1] ?? null;
      const ratio = next ? ratioHigherIsBetter(win.value, next.value) : null;
      entries.push({
        measure: "Throughput",
        unit: speedUnit,
        winnerLabel: win.label,
        winnerValue: win.value,
        runnerUpLabel: next?.label ?? null,
        runnerUpValue: next?.value ?? null,
        ratio,
        sentence: next
          ? `${win.label} served ${ratio ? formatRatio(ratio) : "?"} more ${noun} per second across all ${concurrency} streams than ${next.label} — ${win.value.toFixed(1)} against ${next.value.toFixed(1)}.`
          : solo
            ? `${win.label} served ${win.value.toFixed(1)} ${speedUnit} across all ${concurrency} streams.`
            : `${win.label} was the only lane with every stream finished, at ${win.value.toFixed(1)} ${speedUnit} across ${concurrency} streams.`,
      });
    }
  }

  // --- Total time (lower wins) ---
  // Total time only compares like with like when the lanes produced similar
  // amounts of output. Say so when they did not.
  const outputs = finished.map((r) => (speedUnit === "tokens/sec" ? (r.tokens as number) : r.chunks));
  const minOut = Math.min(...outputs);
  const maxOut = Math.max(...outputs);
  if (minOut > 0 && maxOut / minOut > 1.25) {
    notes.push(
      `Total time compares different amounts of output (${minOut} to ${maxOut} ${speedUnit === "tokens/sec" ? "tokens" : "chunks"}). Speed is the fairer measure here.`,
    );
  }

  const totals = finished.map((r) => ({ label: r.label, value: r.totalSec as number }));
  const sortedTotals = rank(totals, true);
  const winT = sortedTotals[0]!;
  const nextT = sortedTotals[1] ?? null;
  const ratioT = nextT ? ratioLowerIsBetter(winT.value, nextT.value) : null;
  entries.push({
    measure: "Total time",
    unit: "seconds",
    winnerLabel: winT.label,
    winnerValue: winT.value,
    runnerUpLabel: nextT?.label ?? null,
    runnerUpValue: nextT?.value ?? null,
    ratio: ratioT,
    sentence: nextT
      ? `${winT.label} finished${several ? ` all ${concurrency} streams` : ""} ${ratioT ? formatRatio(ratioT) : "?"} sooner than ${nextT.label} — ${formatSeconds(winT.value)} against ${formatSeconds(nextT.value)}.`
      : solo
        ? `${winT.label} finished${several ? ` all ${concurrency} streams` : ""} in ${formatSeconds(winT.value)}.`
        : `${winT.label} was the only lane to finish, in ${formatSeconds(winT.value)}.`,
  });

  return { speedUnit, entries, laneRates, laneThroughputs, concurrency, lanePromptSpeeds, notes };
}

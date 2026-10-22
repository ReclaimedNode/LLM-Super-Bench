/**
 * The race: preflight every lane, then start them all in the same tick and let
 * them stream. A lane that fails does not stop the others.
 */

import { extraBodyFor } from "./settings.ts";
import type { MachineSetup } from "./details.ts";
import { appendRecords, toRecord } from "./log.ts";
import type { Fetcher, LaneState } from "./lane.ts";
import { STOPPED_MESSAGE, newLaneState, runLane } from "./lane.ts";
import { preflightLane } from "./preflight.ts";
import { buildPrompt, makeRunId } from "./prompt.ts";
import { combineStreams, streamRunId } from "./streams.ts";
import {
  buildScoreboard,
  computeRate,
  elapsedSeconds,
  laneSpeed,
  laneThroughput,
  median,
  medianStreamRate,
  monotonicNow,
  throughput,
} from "./timing.ts";
import type {
  LaneConfig,
  LaneResult,
  LaneTick,
  PresetId,
  RaceConfig,
  RaceEvent,
  Scoreboard,
  StreamSample,
} from "./types.ts";

export const TICK_MS = 100;

export interface RunRaceOptions {
  config: RaceConfig;
  preset: PresetId;
  sourceText: string;
  emit: (event: RaceEvent) => void;
  runId?: string;
  fetchImpl?: Fetcher;
  now?: () => number;
  /** null disables logging. Tests point this at a temp file. */
  logPath?: string | null;
  skipUsageProbe?: boolean;
  tickMs?: number;
  /**
   * Which lanes race. Absent means every lane in the config: head to head. One
   * id is a single machine on its own. Ids are `lane-<index in the config>`.
   */
  laneIds?: string[];
  /**
   * Simultaneous streams on each machine. Absent means one. Every machine gets
   * the same number, and stream N on one machine reads the same prompt as stream
   * N on the other.
   */
  concurrency?: number;
  /**
   * Requests each lane's machine runs at once, by lane id, where that was
   * found out. Stamped on the lane's result so the scoreboard can say when a
   * race asked for more than a machine runs at a time.
   */
  laneSlots?: Record<string, number | null>;
  /** How each machine said it was set up, by lane id. Saved with the run in the log. */
  laneSetups?: Record<string, MachineSetup>;
  /** Aborting this stops the race: every request is cut off and each lane is marked stopped. */
  signal?: AbortSignal;
}

export interface RaceOutcome {
  runId: string;
  promptChars: number;
  results: LaneResult[];
  scoreboard: Scoreboard;
}

function laneTick(state: LaneState, tokensKnown: boolean, now: () => number): LaneTick {
  const elapsed = state.settled || state.startedAt === null
    ? state.lastElapsedSec
    : elapsedSeconds(state.startedAt, now());
  const units = tokensKnown && state.tokens !== null ? state.tokens : state.chunks;
  const rateUnit = tokensKnown && state.tokens !== null ? ("tokens/sec" as const) : ("chunks/sec" as const);
  return {
    laneId: state.laneId,
    elapsedSec: elapsed,
    chunks: state.chunks,
    tokens: state.tokens,
    // Same formula as the final number, over the pieces received so far. Not
    // against `elapsed`, which would sag every time the stream pauses.
    rate: computeRate(units, state.firstWordSec, state.lastWordSec),
    rateUnit,
    done: state.settled,
  };
}

/**
 * The tick of a lane that is running several streams. Its rate is the median
 * speed of ONE stream and its throughput is every stream together, both by the
 * same formulas as the final numbers, over the pieces received so far.
 */
function laneGroupTick(states: LaneState[], tokensKnown: boolean, now: () => number): LaneTick {
  const settled = states.every((s) => s.settled);
  const started = states.filter((s) => s.startedAt !== null);
  const elapsed = settled
    ? Math.max(...states.map((s) => s.lastElapsedSec))
    : started.length > 0
      ? elapsedSeconds(Math.min(...started.map((s) => s.startedAt as number)), now())
      : 0;

  // Usage arrives on a stream's last frame, so until then the live readout counts chunks.
  const useTokens = tokensKnown && states.every((s) => s.tokens !== null);
  const unit = useTokens ? ("tokens/sec" as const) : ("chunks/sec" as const);
  const samples: StreamSample[] = states.map((s) => ({
    firstWordSec: s.firstWordSec,
    lastWordSec: s.lastWordSec,
    chunks: s.chunks,
    tokens: s.tokens,
    totalSec: null,
  }));

  return {
    laneId: states[0]!.laneId,
    elapsedSec: elapsed,
    chunks: states.reduce((sum, s) => sum + s.chunks, 0),
    tokens: useTokens ? states.reduce((sum, s) => sum + (s.tokens as number), 0) : null,
    rate: medianStreamRate(samples, unit),
    rateUnit: unit,
    done: settled,
    throughput: throughput(samples, unit),
    streams: {
      total: states.length,
      streaming: states.filter((s) => s.firstWordSec !== null && !s.settled).length,
      done: states.filter((s) => s.settled).length,
    },
  };
}

interface RunStreamsOptions {
  laneId: string;
  lane: LaneConfig;
  prompts: string[];
  states: LaneState[];
  maxTokens: number;
  thinking?: "auto" | "off";
  temperature: number;
  timeoutMs: number;
  emit: (event: RaceEvent) => void;
  announceFirstWord: (laneId: string) => void;
  fetchImpl?: Fetcher;
  now: () => number;
  signal?: AbortSignal;
}

/**
 * One lane's streams, to completion, as one LaneResult.
 *
 * One stream is `runLane` exactly as it always was, events and all. With
 * several, only stream 1's text goes to the lane's pane and the lane-level
 * events (start, first word, done) are made here from all the streams, because
 * a stream's own "done" is not the lane's.
 */
async function runStreams(o: RunStreamsOptions): Promise<LaneResult> {
  const { laneId, lane, states, emit } = o;
  const n = states.length;
  const common = {
    laneId,
    lane,
    maxTokens: o.maxTokens,
    temperature: o.temperature,
    timeoutMs: o.timeoutMs,
    fetchImpl: o.fetchImpl,
    now: o.now,
    // Per-machine request fields from the config, plus the page's thinking switch.
    extraBody: extraBodyFor(lane, o.thinking),
    signal: o.signal,
  };

  if (n === 1) {
    return runLane({ ...common, prompt: o.prompts[0]!, emit }, states[0]!);
  }

  emit({ type: "lane-start", laneId });
  const inflight = states.map((state, k) =>
    runLane(
      {
        ...common,
        prompt: o.prompts[k]!,
        emit: (event) => {
          if (event.type === "delta" && k === 0) emit(event);
        },
      },
      state,
    ),
  );
  const all = await Promise.all(inflight);
  let combined = combineStreams(all);
  // A lane cut short by STOP is stopped as a whole, even if some of its streams
  // had already finished: a partial set is not a measurement of the lane.
  if (o.signal?.aborted && all.some((r) => r.stopped)) {
    combined = { ...combined, error: STOPPED_MESSAGE, stopped: true };
  }
  o.announceFirstWord(laneId);

  if (combined.error) {
    emit({
      type: "lane-error",
      laneId,
      message: combined.error,
      elapsedSec: Math.max(...states.map((s) => s.lastElapsedSec)),
      ...(combined.stopped ? { stopped: true } : {}),
    });
    return combined;
  }

  const unit = combined.tokens === null ? ("chunks/sec" as const) : ("tokens/sec" as const);
  emit({
    type: "lane-done",
    laneId,
    totalSec: combined.totalSec as number,
    lastWordSec: combined.lastWordSec,
    chunks: combined.chunks,
    tokens: combined.tokens,
    tokenSource: combined.tokenSource,
    rate: laneSpeed(combined, unit),
    rateUnit: unit,
    streams: n,
    failedStreams: combined.failedStreams ?? 0,
    throughput: laneThroughput(combined, unit),
  });
  return combined;
}

export async function runRace(opts: RunRaceOptions): Promise<RaceOutcome> {
  const { config, preset, emit } = opts;
  const now = opts.now ?? monotonicNow;
  const runId = opts.runId ?? makeRunId();
  const tickMs = opts.tickMs ?? TICK_MS;

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  // One prompt per stream. They differ only in the run-id line, so no two
  // streams share a cache prefix, and stream N reads the same text on every machine.
  const prompts = Array.from({ length: concurrency }, (_, k) =>
    buildPrompt({
      preset,
      sourceText: opts.sourceText,
      charsPerToken: config.charsPerToken,
      runId: streamRunId(runId, k, concurrency),
    }),
  );
  const prompt = prompts[0]!;

  const everyLane = config.lanes.map((lane, i) => ({ laneId: `lane-${i}`, lane }));
  const lanes = opts.laneIds ? everyLane.filter(({ laneId }) => opts.laneIds!.includes(laneId)) : everyLane;
  if (lanes.length === 0) throw new Error("No machine was picked to race.");

  emit({
    type: "race-start",
    runId,
    preset,
    promptChars: prompt.chars,
    targetChars: prompt.targetChars,
    concurrency,
    lanes: lanes.map(({ laneId, lane }) => ({
      laneId,
      label: lane.label,
      displayModel: lane.displayModel ?? lane.model,
    })),
  });

  // --- Preflight, in parallel. A refused lane never gets a request. ---
  const preflights = await Promise.all(
    lanes.map(({ lane }) =>
      preflightLane({
        lane,
        timeoutMs: config.preflightTimeoutMs,
        fetchImpl: opts.fetchImpl,
        skipUsageProbe: opts.skipUsageProbe,
      }),
    ),
  );
  preflights.forEach((p, i) => {
    const { laneId } = lanes[i]!;
    emit({ type: "preflight", laneId, ok: p.ok, message: p.message, usageSupported: p.usageSupported });
    if (!p.ok) emit({ type: "lane-blocked", laneId, message: p.message });
  });

  const runners = lanes.filter((_, i) => preflights[i]!.ok);
  const blocked: LaneResult[] = lanes
    .map(({ laneId, lane }, i) => ({ laneId, lane, p: preflights[i]! }))
    .filter((x) => !x.p.ok)
    .map(({ laneId, lane, p }) => ({
      laneId,
      label: lane.label,
      model: lane.model,
      displayModel: lane.displayModel ?? lane.model,
      baseUrl: lane.baseUrl,
      firstResponseSec: null,
      firstWordSec: null,
      firstWordField: null,
      lastWordSec: null,
      chunks: 0,
      tokens: null,
      tokenSource: null,
      promptTokens: null,
      cachedTokens: null,
      systemFingerprint: null,
      totalSec: null,
      error: null,
      blocked: p.message,
      usageSupported: p.usageSupported,
    }));

  let results: LaneResult[] = [];
  if (runners.length > 0) {
    // One state per stream. With a single stream this is the one state per lane
    // it always was.
    const groups = new Map<string, LaneState[]>();
    for (const { laneId, lane } of runners) {
      groups.set(laneId, Array.from({ length: concurrency }, () => newLaneState(laneId, lane.label)));
    }
    const firstWordSent = new Set<string>();

    // The live readout has to guess a unit before any usage frame arrives, so
    // it takes the conservative one: tokens only if EVERY racing lane's
    // preflight said the endpoint reports them. The final numbers come from
    // the scoreboard, which knows what actually turned up.
    const tokensKnown = preflights.filter((p) => p.ok).every((p) => p.usageSupported === true);

    const tickAll = (): LaneTick[] =>
      runners.map(({ laneId }) => {
        const states = groups.get(laneId)!;
        return states.length === 1 ? laneTick(states[0]!, tokensKnown, now) : laneGroupTick(states, tokensKnown, now);
      });

    // With several streams a lane has no single first word, so the lane's own
    // is announced once every stream has either spoken or ended: the median of
    // the streams that spoke. With one stream runLane announces it itself.
    const announceFirstWord = (laneId: string) => {
      const states = groups.get(laneId)!;
      if (states.length === 1 || firstWordSent.has(laneId)) return;
      if (!states.every((s) => s.firstWordSec !== null || s.settled)) return;
      const spoke = states.filter((s) => s.firstWordSec !== null);
      if (spoke.length === 0) return;
      firstWordSent.add(laneId);
      emit({
        type: "first-word",
        laneId,
        firstWordSec: median(spoke.map((s) => s.firstWordSec as number)) as number,
        field: spoke[0]!.firstWordField ?? "content",
        streams: states.length,
      });
    };

    const ticker = setInterval(() => {
      for (const { laneId } of runners) announceFirstWord(laneId);
      emit({ type: "tick", lanes: tickAll() });
    }, tickMs);

    try {
      // SAME INSTANT: every fetch, on every lane and every stream, is issued in
      // this one synchronous map, with no await between them.
      const inflight = runners.map(({ laneId, lane }) =>
        runStreams({
          laneId,
          lane,
          prompts: prompts.map((p) => p.text),
          states: groups.get(laneId)!,
          maxTokens: config.maxTokens,
          thinking: config.thinking,
          temperature: config.temperature,
          timeoutMs: config.requestTimeoutMs,
          emit,
          announceFirstWord,
          fetchImpl: opts.fetchImpl,
          now,
          signal: opts.signal,
        }),
      );
      results = await Promise.all(inflight);
    } finally {
      clearInterval(ticker);
      emit({ type: "tick", lanes: tickAll() });
    }
  }

  if (opts.laneSlots) {
    results = results.map((r) => {
      const slots = opts.laneSlots![r.laneId];
      return slots === null || slots === undefined ? r : { ...r, slots };
    });
  }

  if (opts.laneSetups) {
    results = results.map((r) => (opts.laneSetups![r.laneId] ? { ...r, setup: opts.laneSetups![r.laneId] } : r));
  }

  // Keep configured lane order, so the screen never reshuffles mid-race.
  const byId = new Map<string, LaneResult>();
  for (const r of [...results, ...blocked]) byId.set(r.laneId, r);
  const ordered = lanes.map(({ laneId }) => byId.get(laneId)!).filter(Boolean);

  const scoreboard = buildScoreboard(ordered);
  emit({ type: "race-done", scoreboard, results: ordered });

  if (opts.logPath !== null) {
    const records = ordered.map((result) =>
      toRecord({ result, runId, preset, promptChars: prompt.chars }),
    );
    await appendRecords(records, opts.logPath);
  }

  return { runId, promptChars: prompt.chars, results: ordered, scoreboard };
}

/**
 * One lane: the request, the stream, and every number we claim about it.
 *
 * All timing happens here, in this process, on the monotonic clock. The browser
 * is only ever told what was measured here.
 */

import { computeRate, elapsedSeconds, monotonicNow } from "./timing.ts";
import type { LaneConfig, LaneResult, RaceEvent, TextField } from "./types.ts";

export type Fetcher = typeof fetch;

export interface LaneRunOptions {
  laneId: string;
  lane: LaneConfig;
  prompt: string;
  maxTokens: number;
  temperature: number;
  /** Sent only when set, so a server's own default is never overridden by accident. */
  topP?: number;
  topK?: number;
  timeoutMs: number;
  emit: (event: RaceEvent) => void;
  fetchImpl?: Fetcher;
  now?: () => number;
  /**
   * Extra top-level fields for the request body. The benchmark uses it to ask a
   * server to turn thinking off per request where the server accepts that.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Aborting this cuts the request off at once. The server on the other end
   * sees the connection close and stops generating, which is the point of STOP:
   * a long prompt must not keep a machine busy after it was cancelled.
   */
  signal?: AbortSignal;
}

/** What a stopped run says. The page and the scoreboard both look for the `stopped` flag, not this text. */
export const STOPPED_MESSAGE = "Stopped by you";

/** Pull the first non-empty text out of a streamed delta, and say which field it came from. */
export function readDelta(chunk: unknown): { text: string; field: TextField } | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== "object" || delta === null) return null;
  const d = delta as Record<string, unknown>;

  // Order matters only for which field gets credit when a chunk carries both;
  // content is the reply, so it wins.
  const fields: TextField[] = ["content", "reasoning", "reasoning_content"];
  for (const field of fields) {
    const value = d[field];
    if (typeof value === "string" && value.length > 0) return { text: value, field };
  }
  return null;
}

/** Everything the usage frame tells us, or null if this frame is not one. */
export interface Usage {
  /** Completion tokens. */
  completion: number | null;
  /** Prompt tokens: the TRUE size of what the model read. */
  prompt: number | null;
  /** Prompt tokens served from cache. Above zero and the run is not comparable. */
  cached: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readUsage(chunk: unknown): Usage | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const usage = (chunk as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;

  const details = typeof u.prompt_tokens_details === "object" && u.prompt_tokens_details !== null
    ? (u.prompt_tokens_details as Record<string, unknown>)
    : null;

  return {
    completion: finiteNumber(u.completion_tokens),
    prompt: finiteNumber(u.prompt_tokens),
    cached: details ? finiteNumber(details.cached_tokens) : null,
  };
}

/** Completion tokens, but only when the endpoint actually reported usage. */
export function readUsageTokens(chunk: unknown): number | null {
  return readUsage(chunk)?.completion ?? null;
}

/**
 * The server's version string. mlx_lm.server puts it on every frame, shaped
 * like "0.31.3-0.31.2-macOS-26.5.1-arm64-arm-64bit-Mach-O-applegpu_g15d":
 * mlx_lm version, mlx version, OS, GPU family. A published number without it
 * cannot be reproduced.
 */
export function readFingerprint(chunk: unknown): string | null {
  if (typeof chunk !== "object" || chunk === null) return null;
  const fp = (chunk as { system_fingerprint?: unknown }).system_fingerprint;
  return typeof fp === "string" && fp !== "" ? fp : null;
}

/** Mutable state a running lane exposes to the tick loop. */
export interface LaneState {
  laneId: string;
  label: string;
  startedAt: number | null;
  firstResponseSec: number | null;
  firstWordSec: number | null;
  firstWordField: TextField | null;
  lastWordSec: number | null;
  chunks: number;
  tokens: number | null;
  promptTokens: number | null;
  cachedTokens: number | null;
  systemFingerprint: string | null;
  settled: boolean;
  lastElapsedSec: number;
}

export function newLaneState(laneId: string, label: string): LaneState {
  return {
    laneId,
    label,
    startedAt: null,
    firstResponseSec: null,
    firstWordSec: null,
    firstWordField: null,
    lastWordSec: null,
    chunks: 0,
    tokens: null,
    promptTokens: null,
    cachedTokens: null,
    systemFingerprint: null,
    settled: false,
    lastElapsedSec: 0,
  };
}

function headers(lane: LaneConfig): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (lane.apiKey) h.Authorization = `Bearer ${lane.apiKey}`;
  return h;
}

function describeError(err: unknown, timeoutMs: number): string {
  if (err instanceof DOMException && err.name === "AbortError") {
    return `Timed out after ${Math.round(timeoutMs / 1000)}s`;
  }
  if (err instanceof Error) {
    // Bun wraps connection failures; the cause usually carries the useful part.
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message}: ${cause.message}`;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Runs one lane to completion. Never throws: a failure becomes a LaneResult
 * with an `error`, so one dead lane cannot stop the race.
 */
export async function runLane(opts: LaneRunOptions, state: LaneState): Promise<LaneResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? monotonicNow;
  const { lane, laneId, emit } = opts;

  const base: LaneResult = {
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
    blocked: null,
    usageSupported: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let stopped = false;
  const onStop = () => {
    stopped = true;
    controller.abort();
  };
  if (opts.signal) {
    if (opts.signal.aborted) onStop();
    else opts.signal.addEventListener("abort", onStop, { once: true });
  }

  // START. The clock begins the instant before the request is written.
  const t0 = now();
  state.startedAt = t0;
  emit({ type: "lane-start", laneId });

  try {
    const response = await fetchImpl(`${lane.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: headers(lane),
      signal: controller.signal,
      body: JSON.stringify({
        model: lane.model,
        messages: [{ role: "user", content: opts.prompt }],
        stream: true,
        // Requirement: ask for usage. Whether the endpoint honours it is
        // recorded, never assumed.
        stream_options: { include_usage: true },
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
        ...(opts.topK !== undefined ? { top_k: opts.topK } : {}),
        ...opts.extraBody,
      }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ").trim();
      throw new Error(`HTTP ${response.status}${detail ? ` - ${detail}` : ""}`);
    }
    if (!response.body) throw new Error("Endpoint returned no response body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawUsage = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;

        // One clock reading per streamed line, taken the moment the line is in
        // hand and shared by every measurement drawn from it. Reading the clock
        // again after JSON.parse would fold our own parse time into the lane's
        // first-word number.
        const at = elapsedSeconds(t0, now());

        // FIRST RESPONSE: the first streamed line of any kind, counted before
        // anything is known about its contents. An instant empty chunk is a
        // response, not a word.
        if (state.firstResponseSec === null) {
          state.firstResponseSec = at;
          emit({ type: "first-response", laneId, firstResponseSec: at });
        }

        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // A malformed frame is not worth failing a race over.
        }

        if (state.systemFingerprint === null) state.systemFingerprint = readFingerprint(parsed);

        const usage = readUsage(parsed);
        if (usage !== null) {
          if (usage.completion !== null) {
            sawUsage = true;
            state.tokens = usage.completion;
          }
          if (usage.prompt !== null) state.promptTokens = usage.prompt;
          if (usage.cached !== null) state.cachedTokens = usage.cached;
        }

        const delta = readDelta(parsed);
        if (!delta) continue;

        state.lastElapsedSec = at;

        if (state.firstWordSec === null) {
          // FIRST WORD: the first streamed delta carrying non-empty text.
          state.firstWordSec = at;
          state.firstWordField = delta.field;
          emit({ type: "first-word", laneId, firstWordSec: at, field: delta.field });
        }
        // The speed window runs to the last piece of text, not to the end of
        // the stream -- trailing usage frames carry no output.
        state.lastWordSec = at;
        state.chunks += 1;
        emit({ type: "delta", laneId, text: delta.text, field: delta.field });
      }
    }

    const totalSec = elapsedSeconds(t0, now());
    state.lastElapsedSec = totalSec;
    state.settled = true;

    const tokens = sawUsage ? state.tokens : null;
    const units = tokens ?? state.chunks;
    const rateUnit = tokens === null ? ("chunks/sec" as const) : ("tokens/sec" as const);
    const rate = computeRate(units, state.firstWordSec, state.lastWordSec);

    emit({
      type: "lane-done",
      laneId,
      totalSec,
      lastWordSec: state.lastWordSec,
      chunks: state.chunks,
      tokens,
      tokenSource: tokens === null ? null : "usage",
      rate,
      rateUnit,
    });

    return {
      ...base,
      firstResponseSec: state.firstResponseSec,
      firstWordSec: state.firstWordSec,
      firstWordField: state.firstWordField,
      lastWordSec: state.lastWordSec,
      chunks: state.chunks,
      tokens,
      tokenSource: tokens === null ? null : "usage",
      promptTokens: state.promptTokens,
      cachedTokens: state.cachedTokens,
      systemFingerprint: state.systemFingerprint,
      totalSec,
      usageSupported: sawUsage,
    };
  } catch (err) {
    const message = stopped ? STOPPED_MESSAGE : describeError(err, opts.timeoutMs);
    const at = elapsedSeconds(t0, now());
    state.lastElapsedSec = at;
    state.settled = true;
    emit({ type: "lane-error", laneId, message, elapsedSec: at, ...(stopped ? { stopped: true } : {}) });
    return {
      ...base,
      firstResponseSec: state.firstResponseSec,
      firstWordSec: state.firstWordSec,
      firstWordField: state.firstWordField,
      lastWordSec: state.lastWordSec,
      chunks: state.chunks,
      promptTokens: state.promptTokens,
      cachedTokens: state.cachedTokens,
      systemFingerprint: state.systemFingerprint,
      error: message,
      ...(stopped ? { stopped: true } : {}),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onStop);
  }
}

/**
 * How many streams a machine can run at once, asked of the machine itself.
 *
 * A server runs only so many requests at the same time (its "slots") and queues
 * the rest. A queued stream shows up as a late first word, which is a number
 * about the queue and not about the machine, so the page offers only as many
 * streams as the machines racing can actually run.
 *
 * llama.cpp's `llama-server` says how many it has at `GET /props`, in
 * `total_slots`. Other servers (vLLM, mlx_lm.server) have no such endpoint, so a
 * lane may declare `"slots": N` in the config instead, and a lane that does
 * neither is reported as unknown rather than guessed at.
 */

import type { Fetcher } from "./lane.ts";
import type { LaneConfig } from "./types.ts";

/** A machine that is down must not hold the page up for long. */
export const CAPACITY_TIMEOUT_MS = 4000;

export interface LaneCapacity {
  /** Requests the machine runs at once. Null when it could not be found out. */
  slots: number | null;
  /**
   * The context, in tokens, the server reports for one request. Shown, never
   * relied on.
   */
  contextTokens: number | null;
  /** Where `slots` came from. */
  source: "config" | "server" | null;
}

export const UNKNOWN_CAPACITY: LaneCapacity = { slots: null, contextTokens: null, source: null };

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** Reads a llama-server `/props` body. Anything that is not the shape it expects is "unknown", not an error. */
export function readProps(body: unknown): LaneCapacity {
  if (typeof body !== "object" || body === null) return UNKNOWN_CAPACITY;
  const props = body as Record<string, unknown>;
  const slots = positiveInt(props.total_slots);
  if (slots === null) return UNKNOWN_CAPACITY;

  const settings = props.default_generation_settings;
  const ctx =
    typeof settings === "object" && settings !== null
      ? positiveInt((settings as Record<string, unknown>).n_ctx)
      : null;
  return { slots, contextTokens: ctx, source: "server" };
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: Fetcher;
}

/**
 * One lane's capacity. A number the person wrote in the config wins over
 * anything the server says, because they may know something it does not (vLLM's
 * `--max-num-seqs`, say). Never throws: a machine that cannot be reached is a
 * machine whose capacity is unknown, and preflight is what reports it down.
 */
export async function probeCapacity(lane: LaneConfig, opts: ProbeOptions = {}): Promise<LaneCapacity> {
  if (lane.slots !== undefined) return { slots: lane.slots, contextTokens: null, source: "config" };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? CAPACITY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (lane.apiKey) headers.Authorization = `Bearer ${lane.apiKey}`;
    const response = await fetchImpl(`${lane.baseUrl}/props`, { headers, signal: controller.signal });
    if (!response.ok) return UNKNOWN_CAPACITY;
    return readProps(await response.json());
  } catch {
    return UNKNOWN_CAPACITY;
  } finally {
    clearTimeout(timer);
  }
}

export interface FitInput {
  label: string;
  contextTokens: number | null;
}

/**
 * For each prompt size, the machines whose reported context looks too small for
 * it: the prompt (approximate, sized by characters) plus the reply cap must fit.
 * A warning and never a block, because what a server reports as its context is
 * not the same across versions (per slot, or all slots together) and the person
 * running it knows which. A machine that did not report one is not warned about.
 */
export function presetFit(
  lanes: FitInput[],
  presets: { id: string; targetTokens: number }[],
  maxTokens: number,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const preset of presets) {
    if (!(preset.targetTokens > 0)) continue;
    const needed = preset.targetTokens + maxTokens;
    const tight = lanes.filter((l) => l.contextTokens !== null && needed > l.contextTokens).map((l) => l.label);
    if (tight.length > 0) out[preset.id] = tight;
  }
  return out;
}

export interface StreamLimit {
  /** The most streams to offer: the smallest known slot count, but never past the configured maximum. */
  max: number;
  /** How many of the machines racing could not say. */
  unknown: number;
  /** The buttons to draw. */
  options: number[];
}

/** 1, 2, 4, 8 ... up to `max`, and `max` itself when it is not one of those, so a 3-slot machine can be asked for 3. */
export function streamChoices(max: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= max; n *= 2) out.push(n);
  if (out[out.length - 1] !== max) out.push(max);
  return out;
}

/**
 * What the page may offer for a set of machines that will race together. The
 * smallest known capacity decides it, since every machine gets the same number
 * and the smallest is the one that would start queueing first. A machine that
 * could not say does not lower it, and is counted so the page can say so.
 */
export function streamLimit(capacities: LaneCapacity[], configMax: number): StreamLimit {
  const known = capacities.map((c) => c.slots).filter((s): s is number => s !== null);
  const unknown = capacities.length - known.length;
  const max = Math.max(1, known.length > 0 ? Math.min(configMax, ...known) : configMax);
  return { max, unknown, options: streamChoices(max) };
}

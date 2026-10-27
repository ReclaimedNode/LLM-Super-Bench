/**
 * Settings that apply to every machine in a race, changed from the page:
 * how long a reply may be, whether thinking is switched off, and how the
 * reply is sampled (temperature, top_p, top_k).
 *
 * A thinking model streams its reasoning first and can spend a short reply cap
 * before it says anything. These two settings are the two ways out of that, and
 * they used to mean editing the config file by hand.
 */

import { rename } from "node:fs/promises";
import { MAX_TEMPERATURE, MAX_TOP_K, validateConfig } from "./config.ts";
import type { LaneConfig, RaceConfig } from "./types.ts";

/** The reply-length buttons. Any other whole number from 64 to 32768 is accepted if the config sets it. */
export const REPLY_LENGTHS = [512, 1024, 2048, 4096, 8192];
const MIN_REPLY = 64;
const MAX_REPLY = 32768;

/** auto: leave the model alone. low: ask for the least reasoning it offers. off: ask it not to think. */
export type Thinking = "auto" | "low" | "off";

/** The temperature buttons. 0 is greedy decoding, the fair default for a speed race. */
export const TEMPERATURES = [0, 0.6, 0.7, 1.0];

export interface SettingsChange {
  maxTokens?: number;
  thinking?: Thinking;
  temperature?: number;
  /** null clears it, so each server goes back to its own default. */
  topP?: number | null;
  topK?: number | null;
}

/** How every machine was asked to sample. Saved with the results, so a number carries it. */
export interface Sampling {
  temperature: number;
  topP?: number;
  topK?: number;
}

export function samplingOf(config: Pick<RaceConfig, "temperature" | "topP" | "topK">): Sampling {
  return {
    temperature: config.temperature,
    ...(config.topP !== undefined ? { topP: config.topP } : {}),
    ...(config.topK !== undefined ? { topK: config.topK } : {}),
  };
}

/** The request fields for sampling. top_p and top_k only when set, so a server's own default is never overridden by accident. */
export function samplingBody(s: Sampling): Record<string, number> {
  return {
    temperature: s.temperature,
    ...(s.topP !== undefined ? { top_p: s.topP } : {}),
    ...(s.topK !== undefined ? { top_k: s.topK } : {}),
  };
}

/** Short text for a table cell or a log line: "temp 0", "temp 0.7, top_p 0.95, top_k 20". */
export function samplingLabel(s: Sampling): string {
  return [`temp ${s.temperature}`, ...(s.topP !== undefined ? [`top_p ${s.topP}`] : []), ...(s.topK !== undefined ? [`top_k ${s.topK}`] : [])].join(", ");
}

/**
 * Above temperature 0, a top_p or top_k left unset means each server uses its own default, which
 * can differ between engines (vLLM reads the model's generation_config.json; llama.cpp has its own).
 * Null when the machines are sampled the same way.
 */
export function samplingWarning(s: Sampling): string | null {
  if (s.temperature === 0) return null;
  const unset = [...(s.topP === undefined ? ["top_p"] : []), ...(s.topK === undefined ? ["top_k"] : [])];
  if (unset.length === 0) return null;
  return `Temperature is ${s.temperature} but ${unset.join(" and ")} ${unset.length > 1 ? "are" : "is"} not set, so each server uses its own default and the machines may sample differently. Set ${unset.join(" and ")} too, or use temperature 0.`;
}

export function parseSettings(body: unknown): { ok: true; change: SettingsChange } | { ok: false; error: string } {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const change: SettingsChange = {};
  if (b.maxTokens !== undefined) {
    const n = b.maxTokens;
    if (typeof n !== "number" || !Number.isInteger(n) || n < MIN_REPLY || n > MAX_REPLY) {
      return { ok: false, error: `Reply length must be a whole number of tokens from ${MIN_REPLY} to ${MAX_REPLY}.` };
    }
    change.maxTokens = n;
  }
  if (b.thinking !== undefined) {
    if (b.thinking !== "auto" && b.thinking !== "low" && b.thinking !== "off") {
      return { ok: false, error: 'Thinking must be "auto" (leave the model as it is), "low" or "off".' };
    }
    change.thinking = b.thinking;
  }
  if (b.temperature !== undefined) {
    const t = b.temperature;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > MAX_TEMPERATURE) {
      return { ok: false, error: `Temperature must be a number from 0 to ${MAX_TEMPERATURE}.` };
    }
    change.temperature = t;
  }
  if (b.topP !== undefined) {
    const v = b.topP;
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1)) {
      return { ok: false, error: "top_p must be a number above 0 and at most 1, or empty to leave it to each server." };
    }
    change.topP = v as number | null;
  }
  if (b.topK !== undefined) {
    const v = b.topK;
    if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TOP_K)) {
      return { ok: false, error: `top_k must be a whole number from 1 to ${MAX_TOP_K}, or empty to leave it to each server.` };
    }
    change.topK = v as number | null;
  }
  if (Object.keys(change).length === 0) {
    return { ok: false, error: "Send a reply length, a thinking setting or a sampling setting." };
  }
  return { ok: true, change };
}

/**
 * The request fields for one machine. With thinking off, every machine is sent the
 * same switch; a field the machine's own `extraBody` already sets for itself wins.
 */
export function extraBodyFor(
  lane: Pick<LaneConfig, "extraBody">,
  thinking: Thinking | undefined,
  engine?: string | null,
): Record<string, unknown> | undefined {
  if (thinking !== "off" && thinking !== "low") return lane.extraBody;
  const own = lane.extraBody ?? {};
  // Ollama's and Strata's OpenAI-compatible endpoints take a plain `reasoning_effort` ("none" turns
  // thinking off) and do not read chat_template_kwargs. A machine's own extraBody still wins.
  if (engine && /ollama|strata/i.test(engine)) {
    return { reasoning_effort: thinking === "off" ? "none" : "low", ...own };
  }
  const kwargs = typeof own.chat_template_kwargs === "object" && own.chat_template_kwargs !== null
    ? (own.chat_template_kwargs as Record<string, unknown>)
    : {};
  return {
    ...own,
    chat_template_kwargs: { ...(thinking === "off" ? { enable_thinking: false } : { reasoning_effort: "low" }), ...kwargs },
  };
}

/** Validates the changed config and, if a path is given, writes it beside the real file and moves it into place. */
export async function applySettings(opts: {
  config: RaceConfig;
  change: SettingsChange;
  writePath?: string;
}): Promise<{ ok: true; config: RaceConfig } | { ok: false; error: string }> {
  const raw: Record<string, unknown> = {
    ...opts.config,
    ...(opts.change.maxTokens !== undefined ? { maxTokens: opts.change.maxTokens } : {}),
    ...(opts.change.thinking !== undefined ? { thinking: opts.change.thinking } : {}),
    ...(opts.change.temperature !== undefined ? { temperature: opts.change.temperature } : {}),
  };
  // null clears the setting, so the key leaves the saved file instead of being written as null.
  for (const key of ["topP", "topK"] as const) {
    const v = opts.change[key];
    if (v === null) delete raw[key];
    else if (v !== undefined) raw[key] = v;
  }
  let validated: RaceConfig;
  try {
    validated = validateConfig(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (opts.writePath) {
    const temp = `${opts.writePath}.tmp`;
    await Bun.write(temp, JSON.stringify(raw, null, 2) + "\n");
    await rename(temp, opts.writePath);
  }
  return { ok: true, config: validated };
}

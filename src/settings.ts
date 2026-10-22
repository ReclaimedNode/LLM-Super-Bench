/**
 * Settings that apply to every machine in a race, changed from the page:
 * how long a reply may be, and whether thinking is switched off.
 *
 * A thinking model streams its reasoning first and can spend a short reply cap
 * before it says anything. These two settings are the two ways out of that, and
 * they used to mean editing the config file by hand.
 */

import { rename } from "node:fs/promises";
import { validateConfig } from "./config.ts";
import type { LaneConfig, RaceConfig } from "./types.ts";

/** The reply-length buttons. Any other whole number from 64 to 32768 is accepted if the config sets it. */
export const REPLY_LENGTHS = [512, 1024, 2048, 4096, 8192];
const MIN_REPLY = 64;
const MAX_REPLY = 32768;

export type Thinking = "auto" | "off";

export interface SettingsChange {
  maxTokens?: number;
  thinking?: Thinking;
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
    if (b.thinking !== "auto" && b.thinking !== "off") {
      return { ok: false, error: 'Thinking must be "auto" (leave the model as it is) or "off".' };
    }
    change.thinking = b.thinking;
  }
  if (change.maxTokens === undefined && change.thinking === undefined) {
    return { ok: false, error: "Send a reply length or a thinking setting." };
  }
  return { ok: true, change };
}

/**
 * The request fields for one machine. With thinking off, every machine is sent the
 * same switch; a field the machine's own `extraBody` already sets for itself wins.
 */
export function extraBodyFor(lane: Pick<LaneConfig, "extraBody">, thinking: Thinking | undefined): Record<string, unknown> | undefined {
  if (thinking !== "off") return lane.extraBody;
  const own = lane.extraBody ?? {};
  const kwargs = typeof own.chat_template_kwargs === "object" && own.chat_template_kwargs !== null
    ? (own.chat_template_kwargs as Record<string, unknown>)
    : {};
  return {
    ...own,
    chat_template_kwargs: { enable_thinking: false, ...kwargs },
  };
}

/** Validates the changed config and, if a path is given, writes it beside the real file and moves it into place. */
export async function applySettings(opts: {
  config: RaceConfig;
  change: SettingsChange;
  writePath?: string;
}): Promise<{ ok: true; config: RaceConfig } | { ok: false; error: string }> {
  const raw = {
    ...opts.config,
    ...(opts.change.maxTokens !== undefined ? { maxTokens: opts.change.maxTokens } : {}),
    ...(opts.change.thinking !== undefined ? { thinking: opts.change.thinking } : {}),
  };
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

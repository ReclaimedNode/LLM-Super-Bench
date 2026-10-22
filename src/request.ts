/**
 * What the page may ask a race to do, checked before anything is touched.
 *
 * Three choices come with every START: which machines, how big a prompt, and how
 * many streams on each machine. A choice that is absent takes its default. A
 * choice that is PRESENT and wrong is refused with a sentence, never quietly
 * turned into a different race: a number on the screen has to belong to the
 * race it says it is from.
 */

import { isPresetId } from "./prompt.ts";
import type { PresetId } from "./types.ts";

export interface RaceRequest {
  preset: PresetId;
  /** The lanes that race, in configured order. */
  laneIds: string[];
  /** Simultaneous streams on each machine. */
  concurrency: number;
}

export type RaceRequestResult = { ok: true; request: RaceRequest } | { ok: false; error: string };

export interface RaceRequestLimits {
  /** Every lane id the config has, in order. */
  laneIds: string[];
  maxConcurrency: number;
}

export function parseRaceRequest(body: unknown, limits: RaceRequestLimits): RaceRequestResult {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  let preset: PresetId = "short";
  if (b.preset !== undefined) {
    if (typeof b.preset !== "string" || !isPresetId(b.preset)) {
      return { ok: false, error: `Unknown prompt size: ${JSON.stringify(b.preset)}.` };
    }
    preset = b.preset;
  }

  let laneIds = limits.laneIds;
  if (b.lanes !== undefined) {
    if (!Array.isArray(b.lanes) || b.lanes.length === 0 || !b.lanes.every((l) => typeof l === "string")) {
      return { ok: false, error: "Pick at least one machine to race." };
    }
    const asked = new Set(b.lanes as string[]);
    const unknown = [...asked].filter((id) => !limits.laneIds.includes(id));
    if (unknown.length > 0) {
      return { ok: false, error: `Unknown machine: ${unknown.map((u) => JSON.stringify(u)).join(", ")}.` };
    }
    // Configured order, whatever order they were asked in, so the screen never reshuffles.
    laneIds = limits.laneIds.filter((id) => asked.has(id));
  }

  let concurrency = 1;
  if (b.concurrency !== undefined) {
    const n = b.concurrency;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > limits.maxConcurrency) {
      return {
        ok: false,
        error: `Streams per machine must be a whole number from 1 to ${limits.maxConcurrency}.`,
      };
    }
    concurrency = n;
  }

  return { ok: true, request: { preset, laneIds, concurrency } };
}

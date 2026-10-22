/**
 * Changing which machines are tested, from the page.
 *
 * The page sends a list of machines (a name, an address and optional notes).
 * Each address is asked for its model id, because the race must send the exact
 * id the machine lists. Settings the page does not edit (an API key, a slot
 * override, extra request fields) stay with the machine they belonged to. Only
 * a list in which every machine answered is saved, so a typo cannot leave the
 * page pointing at nothing.
 */

import { rename } from "node:fs/promises";
import { validateConfig } from "./config.ts";
import { baseName, probeDetails } from "./details.ts";
import { normalizeAddress, readModelId } from "./init.ts";
import type { Fetcher } from "./lane.ts";
import type { LaneConfig, RaceConfig } from "./types.ts";

export interface EditedLane {
  label: string;
  baseUrl: string;
  notes?: string;
  /** Streams the machine runs at once. A number sets it, null clears it (the machine is asked), absent keeps what was saved. */
  slots?: number | null;
}

export const MIN_MACHINES = 1;
export const MAX_MACHINES = 4;

export function parseEditedLanes(body: unknown): { ok: true; lanes: EditedLane[] } | { ok: false; error: string } {
  const list = (body as { lanes?: unknown } | null)?.lanes;
  if (!Array.isArray(list)) return { ok: false, error: "Send the list of machines." };
  if (list.length < MIN_MACHINES || list.length > MAX_MACHINES) {
    return { ok: false, error: `Keep between ${MIN_MACHINES} and ${MAX_MACHINES} machines. Head to head uses two; solo uses one.` };
  }
  const lanes: EditedLane[] = [];
  const labels = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const row = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const n = i + 1;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    if (label === "") return { ok: false, error: `Machine ${n} needs a name.` };
    if (label.length > 40) return { ok: false, error: `Machine ${n}'s name is longer than 40 characters.` };
    if (labels.has(label)) return { ok: false, error: `Two machines are called "${label}". Each name must be different; it is what the scoreboard shows.` };
    labels.add(label);
    const baseUrl = typeof row.baseUrl === "string" ? normalizeAddress(row.baseUrl) : null;
    if (baseUrl === null) return { ok: false, error: `${label} needs an address like http://192.168.1.50:8000.` };
    const notes = typeof row.notes === "string" ? row.notes.trim() : "";
    if (notes.length > 300) return { ok: false, error: `${label}'s notes are longer than 300 characters.` };
    let slots: number | null | undefined;
    if (row.slots === null || row.slots === "") slots = null;
    else if (row.slots !== undefined) {
      const n = typeof row.slots === "string" ? Number(row.slots.trim()) : row.slots;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 256) {
        return { ok: false, error: `${label}'s streams at once must be a whole number from 1 to 256, or empty to ask the machine.` };
      }
      slots = n;
    }
    lanes.push({ label, baseUrl, ...(notes ? { notes } : {}), ...(slots !== undefined ? { slots } : {}) });
  }
  return { ok: true, lanes };
}

/**
 * The saved machines: each edited one takes the settings of the machine it
 * replaces (same address first, else same name), with its newly read model id.
 */
export function mergeLanes(existing: LaneConfig[], edited: EditedLane[], modelIds: string[]): LaneConfig[] {
  return edited.map((e, i) => {
    const before = existing.find((x) => x.baseUrl === e.baseUrl) ?? existing.find((x) => x.label === e.label);
    const modelId = modelIds[i]!;
    const kept: LaneConfig = { label: e.label, baseUrl: e.baseUrl, model: modelId, displayModel: "" };
    if (before) {
      // The short model name is only still right if it is the same model.
      if (before.model === modelId && before.displayModel) kept.displayModel = before.displayModel;
      if (before.apiKey) kept.apiKey = before.apiKey;
      if (before.slots !== undefined && e.slots === undefined) kept.slots = before.slots;
      if (before.extraBody) kept.extraBody = before.extraBody;
    }
    if (kept.displayModel === "") delete kept.displayModel;
    if (typeof e.slots === "number") kept.slots = e.slots;
    if (e.notes) kept.notes = e.notes;
    return kept;
  });
}

export type ApplyResult = { ok: true; config: RaceConfig } | { ok: false; problems: string[] };

export async function applyEdit(opts: {
  config: RaceConfig;
  edited: EditedLane[];
  /** Where the new config is written. Absent means do not write (for checking only). */
  writePath?: string;
  fetchImpl?: Fetcher;
}): Promise<ApplyResult> {
  const found = await Promise.all(opts.edited.map((l) => readModelId(l.baseUrl, opts.fetchImpl)));
  const problems = found.flatMap((f, i) =>
    "error" in f ? [`${opts.edited[i]!.label} (${opts.edited[i]!.baseUrl}) ${f.error}.`] : [],
  );
  if (problems.length > 0) return { ok: false, problems };

  const lanes = mergeLanes(opts.config.lanes, opts.edited, found.map((f) => (f as { id: string }).id));
  const raw = { ...opts.config, lanes };
  let validated: RaceConfig;
  try {
    validated = validateConfig(raw);
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }

  if (opts.writePath) {
    // Written beside the real file and moved into place, so a crash cannot leave half a config.
    const temp = `${opts.writePath}.tmp`;
    await Bun.write(temp, JSON.stringify(raw, null, 2) + "\n");
    await rename(temp, opts.writePath);
  }
  return { ok: true, config: validated };
}

export type CheckResult =
  | {
      ok: true;
      address: string;
      modelFile: string | null;
      quant: string | null;
      build: string | null;
      slots: number | null;
      contextPerSlot: number | null;
    }
  | { ok: false; address: string | null; error: string };

/** Asks one address what it is, for the line shown beside it as soon as it is typed. */
export async function checkMachine(address: unknown, fetchImpl?: Fetcher): Promise<CheckResult> {
  const baseUrl = typeof address === "string" ? normalizeAddress(address) : null;
  if (baseUrl === null) return { ok: false, address: null, error: "That is not an address. Try http://192.168.1.50:8000" };
  const model = await readModelId(baseUrl, fetchImpl);
  if ("error" in model) return { ok: false, address: baseUrl, error: `This machine ${model.error}.` };
  const d = await probeDetails({ label: "check", baseUrl, model: model.id, displayModel: model.id }, "check", { fetchImpl });
  return {
    ok: true,
    address: baseUrl,
    modelFile: d.modelFile ?? baseName(model.id),
    quant: d.quant,
    build: d.build,
    slots: d.slots,
    contextPerSlot: d.contextPerSlot,
  };
}

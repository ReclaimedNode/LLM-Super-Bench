/**
 * What each machine says about itself, asked of the machine.
 *
 * A published number is only as good as the setup behind it, and two machines
 * are rarely set up alike. This reads what llama-server will tell us (its
 * `/props`, `/slots` and `/v1/models`), keeps the parts that matter, and says
 * where two machines differ.
 *
 * What it cannot read is how the server was started: llama-server does not
 * report its command line. `-c`, `-ngl`, flash attention, speculative decoding
 * and the like are only on the machine itself, so a lane may carry a free-text
 * `notes` in the config, shown and saved beside everything below.
 *
 * Every probe has a timeout and none throws. A machine that cannot be asked
 * comes back with its fields null, which is "unknown", never a guess.
 */

import { CAPACITY_TIMEOUT_MS, UNKNOWN_CAPACITY, readProps } from "./capacity.ts";
import type { LaneCapacity } from "./capacity.ts";
import type { Fetcher } from "./lane.ts";
import type { LaneConfig } from "./types.ts";

/** The compact, saveable part: goes in the CSV and in every logged run. */
export interface MachineSetup {
  /** The model file's name, never its folder: the page gets filmed. */
  modelFile: string | null;
  /** Read out of the file name (Q8_0, F16 ...). Null when the name does not say. */
  quant: string | null;
  /** llama.cpp's own build string. */
  build: string | null;
  slots: number | null;
  /** Context for one request, per slot, as the server reports it. */
  contextPerSlot: number | null;
  vision: boolean | null;
  /** Free text from the config about what the API cannot see. */
  notes: string | null;
}

export interface MachineDetails extends MachineSetup {
  laneId: string;
  label: string;
  /** Where `slots` came from: the server, or the config. */
  slotsSource: LaneCapacity["source"];
  /** Each slot's own context, from /slots. Null when that endpoint is off. */
  slotContexts: number[] | null;
  /** Model name as /v1/models lists it. */
  modelId: string | null;
  /** The model's training context, if the server says. */
  trainContext: number | null;
  parameters: number | null;
  /** True when the chat template mentions thinking. Whether it is on is a request setting. */
  templateMentionsThinking: boolean | null;
  /** False when the machine could not be asked at all. */
  reachable: boolean;
}

export const EMPTY_SETUP: MachineSetup = {
  modelFile: null,
  quant: null,
  build: null,
  slots: null,
  contextPerSlot: null,
  vision: null,
  notes: null,
};

const QUANT = /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|F16|F32|BF16)(?=[-_.]|$)/i;

export function quantOf(file: string | null): string | null {
  if (!file) return null;
  const m = QUANT.exec(file.replace(/\.gguf$/i, ""));
  return m ? m[1]!.toUpperCase() : null;
}

/** "/Users/me/models/Foo-Q8_0.gguf" or "C:\\models\\Foo.gguf" -> "Foo-Q8_0.gguf". */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts[parts.length - 1] ?? path;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

async function getJson(lane: LaneConfig, path: string, timeoutMs: number, fetchImpl: Fetcher): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (lane.apiKey) headers.Authorization = `Bearer ${lane.apiKey}`;
    const response = await fetchImpl(`${lane.baseUrl}${path}`, { headers, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface DetailsOptions {
  timeoutMs?: number;
  fetchImpl?: Fetcher;
}

/** Reads the three answers into one record. Pure, so it can be tested without a server. */
export function readDetails(
  lane: Pick<LaneConfig, "label" | "slots" | "notes">,
  laneId: string,
  answers: { props: unknown | null; slots: unknown | null; models: unknown | null },
): MachineDetails {
  const props = obj(answers.props);
  const capacity: LaneCapacity = lane.slots !== undefined
    ? { slots: lane.slots, contextTokens: readProps(answers.props).contextTokens, source: "config" }
    : answers.props === null
      ? UNKNOWN_CAPACITY
      : readProps(answers.props);

  const modelPath = str(props?.model_path);
  const modelFile = modelPath ? baseName(modelPath) : null;

  const modalities = obj(props?.modalities);
  const vision = typeof modalities?.vision === "boolean" ? modalities.vision : null;

  const template = str(props?.chat_template);
  const templateMentionsThinking = template === null ? null : /think|reasoning/i.test(template);

  const slotList = Array.isArray(answers.slots) ? answers.slots : null;
  const slotContexts = slotList
    ? slotList.map((s) => num(obj(s)?.n_ctx)).filter((n): n is number => n !== null)
    : null;

  const first = Array.isArray(obj(answers.models)?.data) ? obj((obj(answers.models)!.data as unknown[])[0]) : null;
  const meta = obj(first?.meta);

  // Per-slot context: prefer what /slots says about the slots themselves.
  const contextPerSlot = slotContexts && slotContexts.length > 0 ? slotContexts[0]! : capacity.contextTokens;

  return {
    laneId,
    label: lane.label,
    reachable: answers.props !== null || answers.slots !== null || answers.models !== null,
    modelFile,
    quant: quantOf(modelFile),
    build: str(props?.build_info),
    slots: capacity.slots,
    slotsSource: capacity.source,
    contextPerSlot,
    slotContexts: slotContexts && slotContexts.length > 0 ? slotContexts : null,
    vision,
    notes: lane.notes ?? null,
    // llama-server lists the model by its full path; the folder stays off the page.
    modelId: str(first?.id) ? baseName(str(first?.id)!) : null,
    trainContext: num(meta?.n_ctx_train),
    parameters: num(meta?.n_params),
    templateMentionsThinking,
  };
}

export async function probeDetails(lane: LaneConfig, laneId: string, opts: DetailsOptions = {}): Promise<MachineDetails> {
  const timeoutMs = opts.timeoutMs ?? CAPACITY_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const [props, slots, models] = await Promise.all([
    getJson(lane, "/props", timeoutMs, fetchImpl),
    getJson(lane, "/slots", timeoutMs, fetchImpl),
    getJson(lane, "/v1/models", timeoutMs, fetchImpl),
  ]);
  return readDetails(lane, laneId, { props, slots, models });
}

export function setupOf(d: MachineDetails): MachineSetup {
  return {
    modelFile: d.modelFile,
    quant: d.quant,
    build: d.build,
    slots: d.slots,
    contextPerSlot: d.contextPerSlot,
    vision: d.vision,
    notes: d.notes,
  };
}

/**
 * Where two or more machines are set up differently, in plain sentences. Only
 * things both sides reported are compared: a machine that did not say is not
 * "different", it is unknown, and that is said separately.
 */
export function differences(details: MachineDetails[]): string[] {
  const out: string[] = [];
  if (details.length < 2) return out;

  const check = (what: string, pick: (d: MachineDetails) => string | number | boolean | null, show = String) => {
    const known = details.filter((d) => pick(d) !== null);
    if (known.length < 2) return;
    const values = new Set(known.map((d) => pick(d)));
    if (values.size > 1) {
      out.push(`${what} differs: ${known.map((d) => `${d.label} ${show(pick(d)!)}`).join(", ")}.`);
    }
  };

  check("Model file", (d) => d.modelFile);
  check("Quantization", (d) => d.quant);
  check("llama.cpp build", (d) => d.build);
  check("Slots", (d) => d.slots);
  check("Context per slot", (d) => d.contextPerSlot, (v) => Number(v).toLocaleString("en-US"));
  check("Image support", (d) => d.vision, (v) => (v ? "on" : "off"));

  const noted = details.filter((d) => d.notes);
  if (noted.length > 0 && new Set(details.map((d) => d.notes ?? "")).size > 1) {
    out.push(`Notes differ: ${details.map((d) => `${d.label}: ${d.notes ?? "none given"}`).join("; ")}.`);
  }

  const silent = details.filter((d) => !d.reachable).map((d) => d.label);
  if (silent.length > 0) out.push(`${silent.join(" and ")} did not answer, so nothing is known about its setup.`);
  return out;
}

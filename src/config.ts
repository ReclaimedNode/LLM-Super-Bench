/**
 * Config loading and validation.
 *
 * The real config holds hostnames and machine names, so it is gitignored.
 * race.config.example.json is the committed stand-in and points at the mock
 * lanes, which is what makes `bun run race` work with no hardware.
 */

import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { LaneConfig, RaceConfig } from "./types.ts";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  port: 9500,
  maxTokens: 512,
  temperature: 0,
  charsPerToken: 4,
  promptFile: "prompts/sample.txt",
  requestTimeoutMs: 180_000,
  preflightTimeoutMs: 30_000,
  maxConcurrency: 16,
};

/** More than this and the page is asking one machine for more streams than any of these servers has slots. */
export const MAX_CONCURRENCY_LIMIT = 64;

export const CONFIG_PATH = resolve(PROJECT_ROOT, "race.config.json");
export const EXAMPLE_CONFIG_PATH = resolve(PROJECT_ROOT, "race.config.example.json");

function fail(message: string): never {
  throw new Error(`race.config.json: ${message}`);
}

/** Short model name for the screen: the last path segment, no directories. */
export function defaultDisplayModel(model: string): string {
  const trimmed = model.replace(/\/+$/, "");
  return basename(trimmed) || trimmed;
}

export function validateConfig(raw: unknown): RaceConfig {
  if (typeof raw !== "object" || raw === null) fail("must be a JSON object");
  const obj = raw as Record<string, unknown>;

  const lanesRaw = obj.lanes;
  if (!Array.isArray(lanesRaw)) fail("needs a `lanes` array");
  if (lanesRaw.length < 1 || lanesRaw.length > 4) {
    fail(`needs between 1 and 4 lanes, found ${lanesRaw.length}`);
  }

  const lanes: LaneConfig[] = lanesRaw.map((laneRaw, i) => {
    if (typeof laneRaw !== "object" || laneRaw === null) fail(`lane ${i} must be an object`);
    const lane = laneRaw as Record<string, unknown>;
    const label = lane.label;
    const baseUrl = lane.baseUrl;
    const model = lane.model;
    if (typeof label !== "string" || label.trim() === "") fail(`lane ${i} needs a non-empty \`label\``);
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") fail(`lane ${i} needs a non-empty \`baseUrl\``);
    if (typeof model !== "string" || model.trim() === "") fail(`lane ${i} needs a non-empty \`model\``);
    try {
      new URL(baseUrl);
    } catch {
      fail(`lane ${i} has a baseUrl that is not a URL: ${baseUrl}`);
    }
    const displayModel = typeof lane.displayModel === "string" && lane.displayModel.trim() !== ""
      ? lane.displayModel
      : defaultDisplayModel(model);
    const out: LaneConfig = {
      label,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      model,
      displayModel,
    };
    if (typeof lane.apiKey === "string" && lane.apiKey !== "") out.apiKey = lane.apiKey;
    if (lane.slots !== undefined) {
      if (typeof lane.slots !== "number" || !Number.isInteger(lane.slots) || lane.slots < 1 || lane.slots > 1024) {
        fail(`lane ${i} \`slots\` must be a whole number from 1 to 1024`);
      }
      out.slots = lane.slots;
    }
    if (lane.extraBody !== undefined) {
      const body = lane.extraBody;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        fail(`lane ${i} \`extraBody\` must be a JSON object`);
      }
      const reserved = ["model", "messages", "stream", "stream_options", "max_tokens", "temperature"];
      const clash = Object.keys(body).filter((k) => reserved.includes(k));
      if (clash.length > 0) {
        fail(`lane ${i} \`extraBody\` may not set ${clash.join(", ")}: the race sets those so both machines get the same request`);
      }
      out.extraBody = body as Record<string, unknown>;
    }
    if (lane.notes !== undefined) {
      if (typeof lane.notes !== "string" || lane.notes.length > 300) {
        fail(`lane ${i} \`notes\` must be text of at most 300 characters`);
      }
      if (lane.notes.trim() !== "") out.notes = lane.notes.trim();
    }
    return out;
  });

  const labels = new Set(lanes.map((l) => l.label));
  if (labels.size !== lanes.length) fail("lane labels must be unique -- they are what the scoreboard names");

  const num = (key: keyof typeof DEFAULTS, min: number): number => {
    const v = obj[key];
    if (v === undefined) return DEFAULTS[key] as number;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(`\`${key}\` must be a number >= ${min}`);
    return v;
  };

  const promptFile = typeof obj.promptFile === "string" && obj.promptFile.trim() !== ""
    ? obj.promptFile
    : DEFAULTS.promptFile;

  const maxConcurrency = num("maxConcurrency", 1);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency > MAX_CONCURRENCY_LIMIT) {
    fail(`\`maxConcurrency\` must be a whole number from 1 to ${MAX_CONCURRENCY_LIMIT}`);
  }

  return {
    port: num("port", 1),
    maxTokens: num("maxTokens", 1),
    temperature: obj.temperature === undefined ? DEFAULTS.temperature : num("temperature", 0),
    charsPerToken: num("charsPerToken", 1),
    promptFile,
    requestTimeoutMs: num("requestTimeoutMs", 1000),
    preflightTimeoutMs: num("preflightTimeoutMs", 1000),
    maxConcurrency,
    ...(typeof obj.password === "string" && obj.password.trim() !== "" ? { password: obj.password } : {}),
    lanes,
  };
}

export interface LoadedConfig {
  config: RaceConfig;
  path: string;
  usedExample: boolean;
}

export async function loadConfig(): Promise<LoadedConfig> {
  const real = Bun.file(CONFIG_PATH);
  if (await real.exists()) {
    return { config: validateConfig(await real.json()), path: CONFIG_PATH, usedExample: false };
  }
  const example = Bun.file(EXAMPLE_CONFIG_PATH);
  if (!(await example.exists())) {
    throw new Error("No race.config.json and no race.config.example.json. Cannot start.");
  }
  return { config: validateConfig(await example.json()), path: EXAMPLE_CONFIG_PATH, usedExample: true };
}

export async function loadPromptSource(config: RaceConfig): Promise<string> {
  const path = resolve(PROJECT_ROOT, config.promptFile);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Prompt file not found: ${path}. Drop a text file in prompts/ and set promptFile in race.config.json.`);
  }
  return await file.text();
}

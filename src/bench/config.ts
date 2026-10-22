/**
 * Benchmark config: loading, validating, and the allow-pattern that guards
 * every value which reaches a remote command line.
 *
 * bench.config.json holds hostnames, machine names and model paths, so it is
 * gitignored. bench.config.example.json is the committed stand-in and points at
 * the mock lanes.
 */

import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import type { BenchConfig, BenchLane, BenchModel, ModelKind, PromptLength, SshTarget, TortureCell } from "./types.ts";

export const BENCH_CONFIG_PATH = resolve(PROJECT_ROOT, "bench.config.json");
export const BENCH_EXAMPLE_CONFIG_PATH = resolve(PROJECT_ROOT, "bench.config.example.json");

const DEFAULTS = {
  progressPort: 9600,
  boardPort: 9700,
  outputCap: 128,
  measuredRuns: 5,
  warmupRuns: 1,
  restSeconds: 30,
  requestTimeoutMs: 1_800_000,
  preflightTimeoutMs: 30_000,
  serverStartTimeoutMs: 600_000,
  promptFile: "prompts/sample.txt",
  charsPerToken: 4,
  temperature: 0,
  powerHoldSeconds: 60,
  engineTrials: 5,
};

/**
 * The only characters allowed in a config value that ends up on a remote
 * command line: letters, digits, underscore, dot, slash, tilde, hyphen.
 *
 * Everything a shell could act on is therefore absent -- no space, quote,
 * semicolon, dollar, backtick, ampersand, pipe, newline, redirect. The runner
 * builds argument arrays rather than shell strings on the local side, but the
 * remote side of ssh is a shell by definition, so the values that land there
 * are checked as well as quoted. Belt and braces, deliberately.
 */
export const SAFE_REMOTE_VALUE = /^[A-Za-z0-9_.~/-]+$/;

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(`bench.config.json: ${message}`);
}

/**
 * Refuses a value that could change the meaning of a remote command. The
 * message names the value and the field, because the alternative is a user
 * staring at a refusal with no idea which line of their config caused it.
 */
export function assertRemoteSafe(value: string, field: string): string {
  if (value === "") fail(`${field} is empty`);
  if (!SAFE_REMOTE_VALUE.test(value)) {
    const bad = [...value].filter((c) => !SAFE_REMOTE_VALUE.test(c));
    const shown = [...new Set(bad)].map((c) => JSON.stringify(c)).join(", ");
    fail(
      `${field} contains characters that are not allowed in a value sent to a remote command: ${shown}. ` +
        `Allowed: letters, digits, and _ . / ~ -`,
    );
  }
  return value;
}

/** True when the value is safe. For callers that want a boolean, not a throw. */
export function isRemoteSafe(value: string): boolean {
  return value !== "" && SAFE_REMOTE_VALUE.test(value);
}

function str(obj: Record<string, unknown>, key: string, field: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") fail(`${field} must be a non-empty string`);
  return v;
}

function optStr(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

type NumericKey = {
  [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] extends number ? K : never;
}[keyof typeof DEFAULTS];

function num(obj: Record<string, unknown>, key: NumericKey, min: number): number {
  const v = obj[key];
  if (v === undefined) return DEFAULTS[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) fail(`\`${key}\` must be a number >= ${min}`);
  return v;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseSsh(raw: unknown, laneLabel: string): SshTarget {
  const o = object(raw, `lane "${laneLabel}" ssh`);
  const host = assertRemoteSafe(str(o, "host", `lane "${laneLabel}" ssh.host`), `lane "${laneLabel}" ssh.host`);
  const binDir = assertRemoteSafe(
    str(o, "binDir", `lane "${laneLabel}" ssh.binDir`),
    `lane "${laneLabel}" ssh.binDir`,
  );
  const user = optStr(o, "user");
  if (user !== undefined) assertRemoteSafe(user, `lane "${laneLabel}" ssh.user`);

  const port = o.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`lane "${laneLabel}" ssh.port must be a port number`);
  }
  const sshPort = o.sshPort;
  if (sshPort !== undefined && (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
    fail(`lane "${laneLabel}" ssh.sshPort must be a port number`);
  }

  const out: SshTarget = { host, binDir, port };
  if (user !== undefined) out.user = user;
  if (typeof sshPort === "number") out.sshPort = sshPort;
  return out;
}

/** Where setup puts the environments and the models on every machine. */
export const BENCH_ENVS_ROOT = "~/bench-envs";
export const BENCH_MODELS_ROOT = "~/bench-models";

const MODEL_KINDS: ModelKind[] = ["llm", "image", "video"];

/** The uniform path a model lives at on every lane. */
export function uniformModelPath(dir: string): string {
  return `${BENCH_MODELS_ROOT}/${dir}`;
}

function parseModels(raw: unknown): BenchModel[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("needs a non-empty `models` array");
  const models = raw.map((entry, i) => {
    const o = object(entry, `models[${i}]`);

    const dir = optStr(o, "dir");
    if (dir !== undefined) assertRemoteSafe(dir, `models[${i}].dir`);
    if (dir !== undefined && dir.includes("/")) fail(`models[${i}].dir is a folder name, so it cannot contain "/"`);

    // With a `dir`, the id is the uniform path setup puts it at, so one config
    // works on every machine and nobody has to keep two fields in step.
    const explicitId = optStr(o, "id");
    const id = explicitId ?? (dir !== undefined ? uniformModelPath(dir) : undefined);
    if (id === undefined) fail(`models[${i}] needs an \`id\` or a \`dir\``);
    // The model id becomes --model on a remote command line in managed mode.
    assertRemoteSafe(id, `models[${i}].id`);

    const kindRaw = optStr(o, "kind") ?? "llm";
    if (!(MODEL_KINDS as string[]).includes(kindRaw)) {
      fail(`models[${i}].kind must be one of ${MODEL_KINDS.join(", ")}`);
    }

    const model: BenchModel = { name: optStr(o, "name") ?? id, id, kind: kindRaw as ModelKind };
    if (dir !== undefined) model.dir = dir;

    if (o.aliases !== undefined) {
      if (!Array.isArray(o.aliases)) fail(`models[${i}].aliases must be an array of ids`);
      model.aliases = o.aliases.map((a, j) => {
        if (typeof a !== "string" || a.trim() === "") fail(`models[${i}].aliases[${j}] must be an id`);
        return a;
      });
    }

    const hfRepo = optStr(o, "hfRepo");
    if (hfRepo !== undefined) {
      assertRemoteSafe(hfRepo, `models[${i}].hfRepo`);
      model.hfRepo = hfRepo;
    }

    const approxGb = o.approxGb;
    if (approxGb !== undefined) {
      if (typeof approxGb !== "number" || !Number.isFinite(approxGb) || approxGb <= 0) {
        fail(`models[${i}].approxGb must be a positive number of gigabytes`);
      }
      model.approxGb = approxGb;
    }

    const activeParams = optStr(o, "activeParams");
    const quantization = optStr(o, "quantization");
    const fileSize = optStr(o, "fileSize");
    if (activeParams) model.activeParams = activeParams;
    if (quantization) model.quantization = quantization;
    if (fileSize) model.fileSize = fileSize;
    return model;
  });

  const ids = new Set(models.map((m) => m.id));
  if (ids.size !== models.length) fail("two models share an id; ids must be unique");
  const dirs = models.map((m) => m.dir).filter((d): d is string => d !== undefined);
  if (new Set(dirs).size !== dirs.length) fail("two models share a `dir`; they would overwrite each other");
  return models;
}

function parsePromptLengths(raw: unknown): PromptLength[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("needs a non-empty `promptLengths` array");
  const lengths = raw.map((entry, i): PromptLength => {
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || entry < 1) fail(`promptLengths[${i}] must be >= 1`);
      return { label: shortTokenLabel(entry), tokens: entry };
    }
    const o = object(entry, `promptLengths[${i}]`);
    const tokens = o.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 1) {
      fail(`promptLengths[${i}].tokens must be a number >= 1`);
    }
    return { label: optStr(o, "label") ?? shortTokenLabel(tokens), tokens };
  });
  const labels = new Set(lengths.map((l) => l.label));
  if (labels.size !== lengths.length) fail("two prompt lengths share a label; labels name cells and must be unique");
  return [...lengths].sort((a, b) => a.tokens - b.tokens);
}

/** 512 -> "512", 4096 -> "4K", 100000 -> "100K". A label, never a measurement. */
export function shortTokenLabel(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1024;
  if (Number.isInteger(k)) return `${k}K`;
  return `${Math.round(tokens / 1000)}K`;
}

function parseLanes(raw: unknown, models: BenchModel[]): BenchLane[] {
  if (!Array.isArray(raw) || raw.length === 0) fail("needs a non-empty `lanes` array");
  const known = new Set(models.map((m) => m.id));

  const lanes = raw.map((entry, i) => {
    const o = object(entry, `lanes[${i}]`);
    const label = str(o, "label", `lanes[${i}].label`);
    const baseUrl = str(o, "baseUrl", `lanes[${i}].baseUrl`);
    try {
      new URL(baseUrl);
    } catch {
      fail(`lane "${label}" has a baseUrl that is not a URL: ${baseUrl}`);
    }

    const lane: BenchLane = { label, baseUrl: baseUrl.replace(/\/+$/, "") };

    if (o.models !== undefined) {
      if (!Array.isArray(o.models) || o.models.length === 0) fail(`lane "${label}" .models must be a non-empty array`);
      const ids = o.models.map((m, j) => {
        if (typeof m !== "string" || m.trim() === "") fail(`lane "${label}" .models[${j}] must be a model id`);
        if (!known.has(m)) fail(`lane "${label}" names a model that is not in \`models\`: ${m}`);
        return m;
      });
      lane.models = ids;
    }

    if (o.ssh !== undefined) lane.ssh = parseSsh(o.ssh, label);
    const apiKey = optStr(o, "apiKey");
    if (apiKey) lane.apiKey = apiKey;

    if (o.localPaths !== undefined) {
      const paths = object(o.localPaths, `lane "${label}" .localPaths`);
      const known = new Set(models.map((m) => m.dir).filter((d): d is string => d !== undefined));
      const out: Record<string, string> = {};
      for (const [dir, value] of Object.entries(paths)) {
        if (!known.has(dir)) {
          fail(`lane "${label}" .localPaths names "${dir}", which is not any model's \`dir\``);
        }
        if (typeof value !== "string" || value.trim() === "") {
          fail(`lane "${label}" .localPaths["${dir}"] must be a path`);
        }
        // It becomes the source of a symlink on a remote command line.
        out[dir] = assertRemoteSafe(value, `lane "${label}" .localPaths["${dir}"]`);
      }
      lane.localPaths = out;
    }

    // A managed lane's baseUrl has to be the port the runner starts the server
    // on, or the runner would start a server and then poll something else.
    if (lane.ssh) {
      const port = Number(new URL(lane.baseUrl).port);
      if (port !== lane.ssh.port) {
        fail(
          `lane "${label}" is managed, so its baseUrl port (${port || "none"}) must equal ssh.port (${lane.ssh.port}) -- ` +
            `that is the port the runner starts the server on.`,
        );
      }
    }
    return lane;
  });

  const labels = new Set(lanes.map((l) => l.label));
  if (labels.size !== lanes.length) fail("lane labels must be unique -- they are what the board names");
  return lanes;
}

function parseTorture(raw: unknown, lanes: BenchLane[], models: BenchModel[]): TortureCell[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail("`torture` must be an array");
  const laneLabels = new Set(lanes.map((l) => l.label));
  const modelIds = new Set(models.map((m) => m.id));
  return raw.map((entry, i) => {
    const o = object(entry, `torture[${i}]`);
    const lane = str(o, "lane", `torture[${i}].lane`);
    const model = str(o, "model", `torture[${i}].model`);
    if (!laneLabels.has(lane)) fail(`torture[${i}] names a lane that does not exist: ${lane}`);
    if (!modelIds.has(model)) fail(`torture[${i}] names a model that does not exist: ${model}`);
    const tokens = o.tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 1) {
      fail(`torture[${i}].tokens must be a number >= 1`);
    }
    const out: TortureCell = { lane, model, tokens };
    const label = optStr(o, "label");
    out.label = label ?? shortTokenLabel(tokens);
    return out;
  });
}

export function validateBenchConfig(raw: unknown): BenchConfig {
  const obj = object(raw, "the config");

  const models = parseModels(obj.models);
  const lanes = parseLanes(obj.lanes, models);
  const promptLengths = parsePromptLengths(obj.promptLengths);
  const torture = parseTorture(obj.torture, lanes, models);

  const runName = optStr(obj, "runName") ?? null;
  if (runName !== null && !/^[A-Za-z0-9._-]+$/.test(runName)) {
    fail("`runName` names a folder, so it may only hold letters, digits, and . _ -");
  }

  return {
    runName,
    progressPort: num(obj, "progressPort", 1),
    boardPort: num(obj, "boardPort", 1),
    outputCap: num(obj, "outputCap", 1),
    measuredRuns: num(obj, "measuredRuns", 1),
    warmupRuns: num(obj, "warmupRuns", 0),
    restSeconds: num(obj, "restSeconds", 0),
    requestTimeoutMs: num(obj, "requestTimeoutMs", 1000),
    preflightTimeoutMs: num(obj, "preflightTimeoutMs", 1000),
    serverStartTimeoutMs: num(obj, "serverStartTimeoutMs", 1000),
    promptFile: optStr(obj, "promptFile") ?? DEFAULTS.promptFile,
    charsPerToken: num(obj, "charsPerToken", 1),
    temperature: obj.temperature === undefined ? DEFAULTS.temperature : num(obj, "temperature", 0),
    promptLengths,
    models,
    lanes,
    torture,
    powerHoldSeconds: num(obj, "powerHoldSeconds", 1),
    disableThinking: obj.disableThinking !== false,
    engineBenchmark: obj.engineBenchmark !== false,
    engineTrials: num(obj, "engineTrials", 1),
    image: obj.image,
    video: obj.video,
  };
}

export interface LoadedBenchConfig {
  config: BenchConfig;
  path: string;
  usedExample: boolean;
}

export async function loadBenchConfig(explicitPath?: string): Promise<LoadedBenchConfig> {
  // An explicit path lets one command be pointed at a config while another is
  // mid-run against the default one.
  if (explicitPath) {
    const named = Bun.file(explicitPath);
    if (!(await named.exists())) throw new ConfigError(`No config at ${explicitPath}`);
    return { config: validateBenchConfig(await named.json()), path: explicitPath, usedExample: false };
  }

  const real = Bun.file(BENCH_CONFIG_PATH);
  if (await real.exists()) {
    return { config: validateBenchConfig(await real.json()), path: BENCH_CONFIG_PATH, usedExample: false };
  }
  const example = Bun.file(BENCH_EXAMPLE_CONFIG_PATH);
  if (!(await example.exists())) {
    throw new ConfigError("No bench.config.json and no bench.config.example.json. Cannot start.");
  }
  return { config: validateBenchConfig(await example.json()), path: BENCH_EXAMPLE_CONFIG_PATH, usedExample: true };
}

/**
 * Does an id the endpoint listed mean the model the config asked for?
 *
 * Exactly equal counts. So does a config id written with a leading `~/` whose
 * path matches the tail of a listed absolute one, because that is what the
 * tilde means: the server was started with `~/models/m` and lists it as
 * `/home/someone/models/m`.
 *
 * Nothing looser than that. Matching on the last path segment alone would
 * happily confuse two quantizations of the same model sitting in different
 * directories, and that is a wrong number published under a right-looking
 * name.
 */
export function modelIdMatches(configured: string, listed: string): boolean {
  if (configured === listed) return true;
  if (!configured.startsWith("~/")) return false;
  const tail = configured.slice(1); // "/models/m"
  return listed.endsWith(tail) && listed.startsWith("/") && listed.length > tail.length;
}

/**
 * The id the endpoint lists for a model, or null if it has none.
 *
 * `candidates` is every id that model answers to, because the endpoint may not
 * list it under the one it was started with: a model at ~/bench-models/<dir>
 * is usually a SYMLINK to wherever that machine already had the weights, and
 * mlx_lm.server resolves the link and lists the target. The lane's
 * `localPaths` entry names exactly that target, so it is already known --
 * which is the same fact that lets an older run's cells be recognised.
 */
export function resolveModelId(candidates: string | string[], listed: string[]): string | null {
  const wanted = typeof candidates === "string" ? [candidates] : candidates;
  for (const candidate of wanted) {
    const hit = listed.find((id) => modelIdMatches(candidate, id));
    if (hit) return hit;
  }
  return null;
}

/**
 * A model's identity, independent of where its weights happen to sit.
 *
 * The `dir` is that identity: it is the same on every machine by construction,
 * which is the whole point of putting every model at ~/bench-models/<dir>. A
 * model without one falls back to its id, which is the best available answer.
 */
export function modelKeyOf(model: BenchModel): string {
  return model.dir ?? model.id;
}

/**
 * Every id this model has ever answered to.
 *
 * A run finished before the move to uniform paths recorded whatever that
 * machine called the weights, and those cells still have to count as done and
 * still have to sit under one heading beside another machine's. A lane's
 * `localPaths` entry IS such an id -- it names the same weights on that
 * machine -- so it counts without anyone having to write it down twice.
 */
export function knownIdsFor(config: BenchConfig, model: BenchModel): string[] {
  const ids = new Set<string>([model.id]);
  if (model.dir) ids.add(uniformModelPath(model.dir));
  for (const alias of model.aliases ?? []) ids.add(alias);
  for (const lane of config.lanes) {
    const local = model.dir ? lane.localPaths?.[model.dir] : undefined;
    if (local) ids.add(local);
  }
  return [...ids];
}

/** Every known id mapped to the model key it belongs to. */
export function modelKeyIndex(config: BenchConfig): Map<string, string> {
  const index = new Map<string, string>();
  for (const model of config.models) {
    const key = modelKeyOf(model);
    for (const id of knownIdsFor(config, model)) index.set(id, key);
  }
  return index;
}

/**
 * The key for a record: what it recorded if it has one, else what the config
 * says that id belongs to, else the id itself so an unrecognised model is
 * still shown rather than silently folded into another.
 */
export function modelKeyForRecord(
  index: Map<string, string>,
  record: { modelId: string; modelKey?: string },
): string {
  return record.modelKey ?? index.get(record.modelId) ?? record.modelId;
}

/** Which models a lane runs, in config order. */
export function modelsForLane(config: BenchConfig, lane: BenchLane): BenchModel[] {
  if (!lane.models) return config.models;
  const wanted = new Set(lane.models);
  return config.models.filter((m) => wanted.has(m.id));
}

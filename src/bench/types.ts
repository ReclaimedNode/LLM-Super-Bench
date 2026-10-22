/**
 * Shapes for the benchmark: the grid, one measured run, and one cell's summary.
 *
 * The race is the show. This is the measuring engine, and its numbers get
 * published, so every figure here is either measured or explicitly marked as
 * not measured. There is no third kind.
 */

import type { TextField } from "../types.ts";

// ------------------------------------------------------------------ config

/** Which environment a model needs on the machine. */
export type ModelKind = "llm" | "image" | "video";

export interface BenchModel {
  /** What the board calls it. */
  name: string;
  /** Exact model id or path, as GET /v1/models lists it. */
  id: string;
  /**
   * Folder name under ~/bench-models. Every lane keeps the model at the same
   * path, so one config works on every machine whatever each already had and
   * wherever it had it.
   */
  dir?: string;
  /** Hugging Face repo id, for a machine that does not have it yet. */
  hfRepo?: string;
  /**
   * Ids this model was recorded under before. A run finished under a
   * per-machine path stays comparable with one finished under the uniform
   * path: same weights, same model, one heading on the board.
   */
  aliases?: string[];
  /** Which environment runs it. Defaults to the language-model one. */
  kind: ModelKind;
  /** Rough download size, checked against free disk BEFORE downloading. */
  approxGb?: number;
  /** For a mixture-of-experts model, the parameters actually active per token. */
  activeParams?: string;
  /** e.g. "4-bit". */
  quantization?: string;
  /** e.g. "7.8 GB". */
  fileSize?: string;
}

export interface SshTarget {
  host: string;
  user?: string;
  /** The Python environment's bin directory on that machine, e.g. ~/venv/bin. */
  binDir: string;
  /** The port the started server listens on. */
  port: number;
  /** SSH port, if not 22. */
  sshPort?: number;
}

export interface BenchLane {
  label: string;
  /** Root of the endpoint, no /v1. For a managed lane this must name ssh.port. */
  baseUrl: string;
  /** Model ids this lane runs. Absent means every model in the config. */
  models?: string[];
  /** Present means MANAGED: the runner starts and stops the server itself. */
  ssh?: SshTarget;
  apiKey?: string;
  /**
   * Copies this machine already has, keyed by the model's `dir`. Setup links
   * them into ~/bench-models instead of downloading tens of gigabytes that are
   * already on the disk.
   */
  localPaths?: Record<string, string>;
}

export interface PromptLength {
  /** The cell's label, e.g. "4K". A label, never a measurement. */
  label: string;
  /** The nominal target. The TRUE count comes from the server's usage frame. */
  tokens: number;
}

export interface TortureCell {
  lane: string;
  model: string;
  tokens: number;
  label?: string;
}

export interface BenchConfig {
  /** Names the results folder. Null means "stamp it with the date and time". */
  runName: string | null;
  progressPort: number;
  boardPort: number;
  /** max_tokens on every request, and what "under length" is measured against. */
  outputCap: number;
  measuredRuns: number;
  warmupRuns: number;
  restSeconds: number;
  requestTimeoutMs: number;
  preflightTimeoutMs: number;
  /** How long to wait for a managed server to list its model. */
  serverStartTimeoutMs: number;
  promptFile: string;
  /** Starting guess only. Every model gets measured with one probe. */
  charsPerToken: number;
  temperature: number;
  promptLengths: PromptLength[];
  models: BenchModel[];
  lanes: BenchLane[];
  torture: TortureCell[];
  /** Seconds of steady load per reading in the power pass. */
  powerHoldSeconds: number;
  /** Ask the server to turn thinking off per request as well as at startup. */
  disableThinking: boolean;
  /** Run the engine's own benchmark after a managed model's API cells. */
  engineBenchmark: boolean;
  engineTrials: number;
  /**
   * The image and video blocks, carried through as written.
   *
   * Their own settings readers parse them, so the shapes live next to the code
   * that uses them. They are carried rather than dropped because a config key
   * that is silently ignored is worse than one that is rejected: the run looks
   * like it obeyed you and quietly used the defaults instead.
   */
  image?: unknown;
  video?: unknown;
}

// ------------------------------------------------------------------ grid

export interface Cell {
  laneLabel: string;
  modelId: string;
  modelKey: string;
  modelName: string;
  nominalLabel: string;
  nominalTokens: number;
  measuredRuns: number;
  torture: boolean;
}

export interface LanePlan {
  laneLabel: string;
  managed: boolean;
  /** Cells grouped by model, in the order they will run. */
  cells: Cell[];
}

export interface GridPlan {
  lanes: LanePlan[];
  totalCells: number;
  totalRuns: number;
}

// ------------------------------------------------------------------ records

/** One line of runs.jsonl. Written the instant the run ends. */
export interface BenchRunRecord {
  ts: string;
  runName: string;
  /** The unique id on the prompt's first line. No two runs share one. */
  runId: string;
  laneLabel: string;
  modelId: string;
  /**
   * The model's identity, stable across machines and across a change of id.
   * Older records predate this field; their key is recovered from the config.
   */
  modelKey?: string;
  modelName: string;
  nominalLabel: string;
  /** The cell's LABEL in tokens. Never used as a measurement. */
  nominalTokens: number;
  outputCap: number;
  /** 0 for the discarded warm-up, then 1..N. */
  runIndex: number;
  warmup: boolean;
  torture: boolean;

  firstResponseSec: number | null;
  firstWordSec: number | null;
  firstWordField: TextField | null;
  lastWordSec: number | null;
  totalSec: number | null;

  /** TRUE prompt tokens, from the server's usage frame. */
  promptTokens: number | null;
  /** TRUE output tokens, from the server's usage frame. */
  outputTokens: number | null;
  /** Above zero means a prompt cache helped, and the run does not count. */
  cachedTokens: number | null;
  /** Streamed pieces of text. Not a token count. */
  chunks: number;
  promptChars: number;

  systemFingerprint: string | null;
  /** Whether the request asked the server to turn thinking off. */
  thinkingDisabled: boolean;

  error: string | null;
  /** Set when the run is excluded from the medians, saying why. */
  invalidReason: string | null;
  /** Visible marks that do not on their own exclude a run. */
  flags: string[];
}

export interface Stat3 {
  median: number;
  low: number;
  high: number;
  n: number;
}

export type CellStatus = "ok" | "partial" | "failed" | "no-valid-runs" | "not-run";

export interface CellStat {
  laneLabel: string;
  modelId: string;
  /** What groups this cell with the same model on another machine. */
  modelKey: string;
  modelName: string;
  nominalLabel: string;
  nominalTokens: number;
  torture: boolean;
  status: CellStatus;

  runsRecorded: number;
  runsUsed: number;
  failed: number;
  cachedInvalid: number;
  shortOutput: number;

  /** True prompt tokens per second of wait, from the usage frame. */
  readSpeed: Stat3 | null;
  /** (pieces - 1) / (last piece - first piece), the repo's formula. */
  writeSpeed: Stat3 | null;
  firstWordSec: Stat3 | null;
  totalSec: Stat3 | null;
  truePromptTokens: Stat3 | null;
  trueOutputTokens: Stat3 | null;

  /** Which streamed field carried the first word, when every used run agreed. */
  firstWordField: TextField | null;
  fingerprints: string[];
  notes: string[];
}

// ------------------------------------------------------------------ engine

export interface EngineTrial {
  promptTps: number;
  generationTps: number;
  peakMemory: number;
  totalTime: number;
}

export interface EngineSample {
  promptTokens: number | null;
  generationTokens: number | null;
  batchSize: number | null;
  trials: EngineTrial[];
  /** What the tool itself printed on its "Averages:" line. */
  toolAverages: { promptTps: number | null; generationTps: number | null; peakMemory: number | null } | null;
}

export interface EngineCell {
  laneLabel: string;
  modelId: string;
  nominalLabel: string;
  nominalTokens: number;
  generationTokens: number;
  /** OUR median/low/high over the tool's per-trial lines. The tool prints a mean. */
  promptTps: Stat3 | null;
  generationTps: Stat3 | null;
  peakMemoryGb: number | null;
  trials: number;
  /** Set when the command is missing or its output did not parse. */
  unavailable: string | null;
  raw: string | null;
}

// ------------------------------------------------------------------ power

export interface PowerReading {
  laneLabel: string;
  /** Null for the lane's idle reading. */
  modelId: string | null;
  modelName: string | null;
  kind: "idle" | "load";
  watts: number;
  holdSeconds: number;
  ts: string;
  note?: string;
}

// ------------------------------------------------------------------ results

export interface RunManifest {
  runName: string;
  startedAt: string;
  finishedAt: string | null;
  outputCap: number;
  measuredRuns: number;
  warmupRuns: number;
  restSeconds: number;
  temperature: number;
  promptFile: string;
  disableThinking: boolean;
  models: BenchModel[];
  lanes: { label: string; managed: boolean }[];
  promptLengths: PromptLength[];
  fingerprints: string[];
  /** Measured characters per token, per model. */
  charsPerToken: Record<string, number>;
  /**
   * What this run actually measured. A run folder can hold a language grid, an
   * image grid, a video grid, or several, and the board and the report print
   * only the settings that apply to what is in it. Absent on a manifest
   * written before this field existed, which is always a language grid.
   */
  measured?: ("llm" | "image" | "video")[];
  /**
   * Set only on a run built by `merge-runs`: which runs it was built from and
   * which lanes each contributed. Absent on a run that measured its own cells.
   */
  mergedFrom?: { runName: string; lanes: string[] }[];
}

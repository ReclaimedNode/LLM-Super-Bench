/**
 * Shared shapes for the race.
 *
 * A "lane" is one computer running one model behind an OpenAI-compatible
 * streaming chat endpoint. A "race" sends one identical prompt to every lane
 * at the same instant and measures each one in this process.
 */

export interface LaneConfig {
  /** What the screen calls this lane, e.g. "Lane A". */
  label: string;
  /** Root of the endpoint, e.g. http://localhost:9001 (no /v1). */
  baseUrl: string;
  /** Exact model id the endpoint lists at GET {base}/v1/models. */
  model: string;
  /** Optional shorter name to show on camera. Defaults to the last path segment of `model`. */
  displayModel?: string;
  /** Optional bearer token, for endpoints that want one. Never logged. */
  apiKey?: string;
  /**
   * How many requests this machine runs at once, for a server that cannot say
   * (vLLM, mlx_lm.server). llama-server says so itself at /props. When set, it
   * wins over what the server says.
   */
  slots?: number;
  /**
   * Extra top-level fields added to this machine's chat requests, for things
   * only its server understands, such as switching thinking off:
   * `{"chat_template_kwargs": {"enable_thinking": false}}` on llama-server.
   * Cannot change what is being measured, so the model, messages, streaming,
   * token cap and temperature may not be set here.
   */
  extraBody?: Record<string, unknown>;
  /**
   * Free text about how this machine was started that the API cannot report
   * ("-c 262144, spec decoding on"). Shown on the machine card and saved with
   * the results, so a published number carries it.
   */
  notes?: string;
}

export interface RaceConfig {
  port: number;
  maxTokens: number;
  /** "off" sends every machine the switch that turns thinking off. Absent or "auto" leaves the model as it is. */
  thinking?: "auto" | "off";
  temperature: number;
  /** Characters per token used to size the 8K / 32K presets. Approximate by definition. */
  charsPerToken: number;
  promptFile: string;
  requestTimeoutMs: number;
  preflightTimeoutMs: number;
  /**
   * The most simultaneous streams the page may ask each machine for. The page
   * offers the powers of two up to this. Absent means 16.
   */
  maxConcurrency?: number;
  /**
   * Optional password for the page (any user name). RACE_PASSWORD in the
   * environment wins over this, and is the better place for it.
   */
  password?: string;
  lanes: LaneConfig[];
}

export type PresetId = "short" | "4k" | "8k" | "16k" | "32k" | "64k" | "128k";

/** Which streamed field carried the first non-empty text. */
export type TextField = "content" | "reasoning" | "reasoning_content";

/** How we know the token count, if we know it at all. */
export type TokenSource = "usage" | null;

/**
 * What one stream of a lane measured, kept when a lane ran more than one stream
 * at once. The lane's own speed and throughput are computed from these, so the
 * log can be re-read later without trusting a number somebody already rounded.
 */
export interface StreamSample {
  firstWordSec: number | null;
  lastWordSec: number | null;
  chunks: number;
  tokens: number | null;
  totalSec: number | null;
}

export interface LaneResult {
  laneId: string;
  label: string;
  /** Full model id. Goes to the log, not to the screen. */
  model: string;
  /** Short model name for the screen. */
  displayModel: string;
  /** Goes to the log, not to the screen. */
  baseUrl: string;
  /**
   * Seconds to the FIRST STREAMED LINE of any kind, including one carrying no
   * text. Some servers send an instant empty chunk; that is a response, not a
   * word, and conflating the two reports nonsense.
   */
  firstResponseSec: number | null;
  /** Seconds from request written to first non-empty streamed text. */
  firstWordSec: number | null;
  firstWordField: TextField | null;
  /** Seconds to the LAST streamed text. With firstWordSec this is the speed window. */
  lastWordSec: number | null;
  /** Streamed chunks that carried text. NOT a token count. */
  chunks: number;
  /** Completion tokens, only when the endpoint reported usage. */
  tokens: number | null;
  tokenSource: TokenSource;
  /**
   * TRUE prompt token count from the server's usage frame. The race does not
   * show it; the benchmark divides by it, so it must never be inferred.
   */
  promptTokens: number | null;
  /**
   * Tokens the server served from its prompt cache. Anything above zero means
   * the run got a head start and is not comparable.
   */
  cachedTokens: number | null;
  /**
   * The server's own version string, e.g. mlx_lm version, mlx version, OS and
   * GPU family. Published numbers are meaningless without it.
   */
  systemFingerprint: string | null;
  totalSec: number | null;
  error: string | null;
  /** Set when preflight refused to start this lane. */
  blocked: string | null;
  /** True when the person pressed STOP. The run is cut short on purpose, so it is not scored and is not a failure of the machine. */
  stopped?: boolean;
  /** How the machine said it was set up when the race started. Logged, not scored. */
  setup?: import("./details.ts").MachineSetup;
  /** True once the endpoint said it supports usage reporting. */
  usageSupported: boolean | null;
  /**
   * Simultaneous streams this lane ran. Absent means one, and then nothing
   * below is set. When it is more than one, `firstWordSec` is the MEDIAN of the
   * streams, `lastWordSec` and `totalSec` are the LATEST of them, and `chunks`
   * and `tokens` are the SUM.
   */
  concurrency?: number;
  /** How many of those streams failed. Their numbers are not in anything above. */
  failedStreams?: number;
  /** Every stream that finished, one sample each. */
  streams?: StreamSample[];
  /** Requests the machine runs at once, when that was known for this race. */
  slots?: number;
}

export interface ScoreboardEntry {
  measure: "First word" | "Speed" | "Throughput" | "Total time";
  unit: string;
  winnerLabel: string;
  winnerValue: number;
  runnerUpLabel: string | null;
  runnerUpValue: number | null;
  /** How many times better the winner is than the runner-up. */
  ratio: number | null;
  /** Plain-words version of the same fact. */
  sentence: string;
}

export interface Scoreboard {
  /** "tokens/sec" only when every finished lane reported usage; otherwise "chunks/sec". */
  speedUnit: "tokens/sec" | "chunks/sec";
  entries: ScoreboardEntry[];
  /**
   * Each lane's final speed expressed in `speedUnit`, so every number on the
   * screen is in one unit. A lane may have real tokens while the race as a
   * whole falls back to chunks; the tokens still go to the log.
   */
  laneRates: { laneId: string; rate: number | null }[];
  /**
   * With more than one stream per machine, `laneRates` is the median speed of
   * ONE stream and this is every stream together. Empty when nothing ran more
   * than one stream.
   */
  laneThroughputs: { laneId: string; rate: number | null }[];
  /** Streams per machine this race ran. 1 for an ordinary race. */
  concurrency: number;
  /**
   * Prompt tokens divided by seconds to the first word, per lane. Null where it
   * would be a guess: several streams, a reasoning model, a cache hit, or no
   * usage report. Not a ranking, so it has no winner.
   */
  lanePromptSpeeds: { laneId: string; rate: number | null; promptTokens: number | null }[];
  notes: string[];
}

export interface LaneTick {
  laneId: string;
  elapsedSec: number;
  chunks: number;
  tokens: number | null;
  /** With several streams: the median speed of one stream, over those streaming so far. */
  rate: number | null;
  rateUnit: "tokens/sec" | "chunks/sec";
  done: boolean;
  /** Only with several streams: every stream together, same formula over the pieces so far. */
  throughput?: number | null;
  /** Only with several streams: how many are streaming now and how many have finished. */
  streams?: { total: number; streaming: number; done: number };
}

export type RaceEvent =
  | {
      type: "race-start";
      runId: string;
      preset: PresetId;
      promptChars: number;
      targetChars: number;
      /** Streams per machine. 1 is an ordinary race. */
      concurrency: number;
      /** The lanes that are racing: all of them head to head, one for a single machine. */
      lanes: { laneId: string; label: string; displayModel: string }[];
    }
  | { type: "preflight"; laneId: string; ok: boolean; message: string; usageSupported: boolean | null }
  | { type: "lane-blocked"; laneId: string; message: string }
  | { type: "lane-start"; laneId: string }
  | { type: "first-response"; laneId: string; firstResponseSec: number }
  | {
      type: "first-word";
      laneId: string;
      firstWordSec: number;
      field: TextField;
      /** Set when this is the median of several streams rather than one stream's own. */
      streams?: number;
    }
  | { type: "delta"; laneId: string; text: string; field: TextField }
  | { type: "tick"; lanes: LaneTick[] }
  | {
      type: "lane-done";
      laneId: string;
      totalSec: number;
      lastWordSec: number | null;
      chunks: number;
      tokens: number | null;
      tokenSource: TokenSource;
      rate: number | null;
      rateUnit: "tokens/sec" | "chunks/sec";
      /** Set with several streams: how many ran, how many of those failed, and every stream together. */
      streams?: number;
      failedStreams?: number;
      throughput?: number | null;
    }
  | { type: "lane-error"; laneId: string; message: string; elapsedSec: number; stopped?: boolean }
  | { type: "race-done"; scoreboard: Scoreboard; results: LaneResult[] };

export interface RunLogRecord {
  ts: string;
  runId: string;
  lane: string;
  baseUrl: string;
  model: string;
  preset: PresetId;
  promptChars: number;
  /** First streamed line of any kind, empty text included. */
  firstResponseSec: number | null;
  /** First streamed line carrying actual text. */
  firstWordSec: number | null;
  firstWordField: TextField | null;
  /** Last streamed text. The speed window is lastWordSec - firstWordSec. */
  lastWordSec: number | null;
  chunks: number;
  tokens: number | null;
  tokenSource: TokenSource;
  totalSec: number | null;
  error: string | null;
  /** Simultaneous streams. Absent in a record from before this existed, which means one. */
  concurrency?: number;
  /** How many of those streams failed. Only set when there were several. */
  failedStreams?: number;
  /** One sample per finished stream, only when there were several. */
  streams?: StreamSample[];
  /** The machine's reported setup. Absent in a record from before this existed. */
  setup?: import("./details.ts").MachineSetup;
  /** The server's own prompt token count, and how many of those it served from cache. Absent when it did not say. */
  promptTokens?: number;
  cachedTokens?: number;
}

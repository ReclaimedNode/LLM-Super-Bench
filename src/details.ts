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
  /** Which inference engine answers: "llama.cpp", "vLLM", "Ollama" ... Read from the server, or typed in the config. */
  engine: string | null;
  /** The model file's name, never its folder: the page gets filmed. */
  modelFile: string | null;
  /** Read out of the file name (Q8_0, F16 ...). Null when the name does not say. */
  quant: string | null;
  /** The server's own build or version string (llama.cpp's build, "vLLM 0.x", "Ollama 0.x" ...). */
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

// GGUF names (Q8_0, F16 ...) and the usual vLLM ones (AWQ, GPTQ, FP8 ...).
const QUANT = /(?:^|[-_.])((?:IQ|Q)\d(?:_[A-Z0-9]+)*|F16|F32|BF16|AWQ|GPTQ|NVFP4|MXFP4|FP8|FP4|INT4|INT8|W4A16|W8A8)(?=[-_.]|$)/i;

export function quantOf(file: string | null): string | null {
  if (!file) return null;
  const m = QUANT.exec(file.replace(/\.gguf$/i, ""));
  return m ? m[1]!.toUpperCase() : null;
}

/** A folder named only for its bit width ("8-bit", "4bit"), as MLX conversions often use. */
const BIT_FOLDER = /^(\d{1,2})[-_ ]?bits?$/i;

/** MLX bit width from a name or path: "Foo-MLX/8-bit" or "mlx-community/Foo-4bit" -> "MLX 8-bit" / "MLX 4-bit". */
export function mlxQuantOf(name: string | null): string | null {
  if (!name) return null;
  const m = /(?:^|[-_/\\ ])(\d{1,2})[-_ ]?bits?(?=$|[-_/\\ ])/i.exec(name);
  return m ? `MLX ${m[1]}-bit` : quantOf(baseName(name));
}

/**
 * The model's name without its folder. A path ending in a bit-width folder keeps its parent, because
 * "/models/Foo-MLX/8-bit" -> "8-bit" names nothing: it becomes "Foo-MLX/8-bit".
 */
export function shortModelName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? path;
  return BIT_FOLDER.test(last) && parts.length > 1 ? `${parts[parts.length - 2]}/${last}` : last;
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

/** Like getJson, plus the Server header, which some engines use to say what and which version they are. */
async function getJsonAndServer(
  lane: LaneConfig,
  path: string,
  timeoutMs: number,
  fetchImpl: Fetcher,
): Promise<{ body: unknown | null; server: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (lane.apiKey) headers.Authorization = `Bearer ${lane.apiKey}`;
    const response = await fetchImpl(`${lane.baseUrl}${path}`, { headers, signal: controller.signal });
    const server = response.headers.get("server");
    if (!response.ok) return { body: null, server };
    return { body: await response.json().catch(() => null), server };
  } catch {
    return { body: null, server: null };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(lane: LaneConfig, path: string, timeoutMs: number, fetchImpl: Fetcher): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (lane.apiKey) headers.Authorization = `Bearer ${lane.apiKey}`;
    const response = await fetchImpl(`${lane.baseUrl}${path}`, { headers, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.text()).slice(0, 2_000_000);
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

/** What the other engines say about themselves. Every field is null unless that engine answered. */
export interface ExtraAnswers {
  /** Ollama: GET /api/version, /api/ps, /api/tags. */
  ollamaVersion?: unknown | null;
  ollamaPs?: unknown | null;
  ollamaTags?: unknown | null;
  /** LM Studio: GET /api/v0/models. */
  lmstudio?: unknown | null;
  /** SGLang: GET /get_server_info. */
  sglang?: unknown | null;
  /** KoboldCpp: GET /api/extra/version. */
  kobold?: unknown | null;
  /** Text Generation Inference: GET /info. */
  tgi?: unknown | null;
  /** Strata: GET /health, which answers with JSON naming the model and `max_context`. */
  strata?: unknown | null;
  /** GET /health again, read for the MLX servers (mlx-vlm names its loaded model and context there). */
  health?: unknown | null;
  /** The Server header that came with GET /health: "mlx_vlm/0.7.10", or Python's "BaseHTTP/0.6 ..." for mlx_lm.server. */
  server?: string | null;
  /** mlx-vlm: GET /v1/settings, its runtime settings (drafter and so on). Asked only when the server is mlx-vlm. */
  mlxSettings?: unknown | null;
  /** GET /v1/models `data`, for engines recognised by the shape of their list. */
  models?: unknown[] | null;
  /** The model this machine is configured for, so mlx_lm.server's list (cached models first) is read for the right one. */
  configuredModel?: string | null;
}

interface EngineReading {
  engine: string | null;
  build: string | null;
  modelFile: string | null;
  quant: string | null;
  slots: number | null;
  context: number | null;
  vision?: boolean | null;
}

const NO_ENGINE: EngineReading = { engine: null, build: null, modelFile: null, quant: null, slots: null, context: null };

function entryNamed(list: unknown, id: string | null): Record<string, unknown> | null {
  const items = Array.isArray(list) ? list : [];
  const found = items.find((x) => id !== null && (str(obj(x)?.name) === id || str(obj(x)?.model) === id || str(obj(x)?.id) === id));
  return obj(found ?? items[0]);
}

/**
 * Names the engine from what it answered, and reads what that engine reports. A server that answers
 * none of these stays unnamed: it is "not reported", never a guess. The config's own `engine` wins.
 */
export function readEngine(modelId: string | null, first: Record<string, unknown> | null, extra: ExtraAnswers): EngineReading {
  const ollamaVersion = str(obj(extra.ollamaVersion)?.version);
  if (ollamaVersion !== null) {
    const loaded = entryNamed(obj(extra.ollamaPs)?.models, modelId);
    const installed = entryNamed(obj(extra.ollamaTags)?.models, modelId);
    const details = obj(installed?.details) ?? obj(loaded?.details);
    return {
      engine: "Ollama",
      build: `Ollama ${ollamaVersion}`,
      modelFile: modelId,
      quant: str(details?.quantization_level),
      slots: null,
      context: num(loaded?.context_length),
    };
  }

  const lmModels = Array.isArray(obj(extra.lmstudio)?.data) ? (obj(extra.lmstudio)!.data as unknown[]) : null;
  if (lmModels !== null) {
    const loaded = lmModels.map(obj).find((m) => m && str(m.id) === modelId) ?? lmModels.map(obj).find((m) => m?.state === "loaded") ?? null;
    const kind = str(loaded?.compatibility_type);
    return {
      engine: kind ? `LM Studio (${kind.toUpperCase()})` : "LM Studio",
      build: null,
      modelFile: null,
      quant: str(loaded?.quantization),
      slots: null,
      context: num(loaded?.loaded_context_length) ?? num(loaded?.max_context_length),
    };
  }

  const sglang = obj(extra.sglang);
  if (sglang !== null || str(first?.owned_by) === "sglang") {
    const version = str(sglang?.version);
    return {
      engine: "SGLang",
      build: version ? `SGLang ${version}` : "SGLang",
      modelFile: str(sglang?.model_path) ? baseName(str(sglang?.model_path)!) : null,
      quant: str(sglang?.quantization)?.toUpperCase() ?? null,
      slots: num(sglang?.max_running_requests),
      context: num(sglang?.context_length),
    };
  }

  // Other servers answer /health too (llama-server, vLLM), but only Strata's says `max_context` and `loaded`.
  const strata = obj(extra.strata);
  if (strata !== null && num(strata.max_context) !== null && typeof strata.loaded === "boolean") {
    const model = str(strata.model);
    return {
      engine: "Strata",
      build: null,
      modelFile: model ? baseName(model) : null,
      quant: null,
      slots: null,
      context: num(strata.max_context),
      vision: typeof strata.images === "boolean" ? strata.images : null,
    };
  }

  // mlx-vlm says so in its Server header ("mlx_vlm/0.7.10"); its /health also has fields no other engine sends.
  const health = obj(extra.health);
  const server = str(extra.server);
  const vlmHeader = server !== null && /^mlx[_-]vlm\//i.test(server);
  const vlmHealth = health !== null && str(health.status) === "healthy" && "loaded_model" in health && "continuous_batching_enabled" in health;
  if (vlmHeader || vlmHealth) {
    const version = vlmHeader ? server!.replace(/^mlx[_-]vlm\//i, "").split(/\s/)[0]! : null;
    const loaded = str(health?.loaded_model) ?? modelId;
    const current = obj(obj(extra.mlxSettings)?.current);
    const drafter = str(current?.draft_kind) ?? (str(current?.draft_model) ? "speculative" : null);
    return {
      engine: "mlx-vlm",
      build: [version ? `mlx-vlm ${version}` : "mlx-vlm", drafter ? `${drafter} drafter` : null].filter(Boolean).join(", "),
      modelFile: loaded ? shortModelName(loaded) : null,
      quant: mlxQuantOf(loaded),
      // --max-num-seqs is not reported anywhere; set `slots` on the machine.
      slots: null,
      context: num(health?.effective_context_limit) ?? num(health?.loaded_context_size),
    };
  }

  // mlx_lm.server is Python's built-in http.server: a "BaseHTTP/..." Server header, a bare {"status":"ok"}
  // at /health, and /v1/models entries with no owned_by. It reports no version or limits.
  const listed = Array.isArray(extra.models) ? extra.models : [];
  const plainList = listed.length > 0 && listed.every((m) => obj(m) !== null && !("owned_by" in obj(m)!));
  if (server !== null && /^BaseHTTP\//.test(server) && health !== null && str(health.status) === "ok" && plainList) {
    const wanted = str(extra.configuredModel);
    const ids = listed.map((m) => str(obj(m)?.id)).filter((x): x is string => x !== null);
    // It lists the models in the Hugging Face cache first and the one it was started with last.
    const model = (wanted !== null && ids.includes(wanted) ? wanted : null) ?? ids[ids.length - 1] ?? null;
    return {
      engine: "mlx-lm",
      build: "mlx-lm",
      modelFile: model ? shortModelName(model) : null,
      quant: mlxQuantOf(model),
      slots: null,
      context: null,
    };
  }

  const kobold = obj(extra.kobold);
  if (kobold !== null && /kobold/i.test(str(kobold.result) ?? "")) {
    const version = str(kobold.version);
    return { ...NO_ENGINE, engine: "KoboldCpp", build: version ? `KoboldCpp ${version}` : "KoboldCpp" };
  }

  const tgi = obj(extra.tgi);
  if (tgi !== null && str(tgi.model_id) !== null) {
    const version = str(tgi.version);
    return {
      engine: "TGI",
      build: version ? `TGI ${version}` : "TGI",
      modelFile: baseName(str(tgi.model_id)!),
      quant: null,
      slots: num(tgi.max_concurrent_requests),
      context: num(tgi.max_total_tokens),
    };
  }

  if (str(first?.owned_by) === "tensorrt_llm") return { ...NO_ENGINE, engine: "TensorRT-LLM" };
  return NO_ENGINE;
}

/** Reads the three answers into one record. Pure, so it can be tested without a server. */
export function readDetails(
  lane: Pick<LaneConfig, "label" | "slots" | "notes" | "engine"> & Partial<Pick<LaneConfig, "model">>,
  laneId: string,
  answers: {
    props: unknown | null;
    slots: unknown | null;
    models: unknown | null;
    /** vLLM's GET /version, and the text of its GET /metrics. Both optional. */
    version?: unknown | null;
    metrics?: string | null;
    /** Answers from other engines' own endpoints. Each is null when that endpoint is not there. */
    extra?: ExtraAnswers;
  },
): MachineDetails {
  const props = obj(answers.props);
  const capacity: LaneCapacity = lane.slots !== undefined
    ? { slots: lane.slots, contextTokens: readProps(answers.props).contextTokens, source: "config" }
    : answers.props === null
      ? UNKNOWN_CAPACITY
      : readProps(answers.props);

  const first = Array.isArray(obj(answers.models)?.data) ? obj((obj(answers.models)!.data as unknown[])[0]) : null;
  const meta = obj(first?.meta);

  // vLLM has no /props. It lists the model's real path or Hugging Face name as `root`, and the longest
  // request it accepts as `max_model_len`, and it says its version at /version.
  const vllm = str(first?.owned_by) === "vllm" || num(first?.max_model_len) !== null;
  const modelPath = str(props?.model_path) ?? (vllm ? str(first?.root) : null);
  const modelFile = modelPath ? baseName(modelPath) : null;
  const version = str(obj(answers.version)?.version);
  const build = str(props?.build_info) ?? (vllm ? (version ? `vLLM ${version}` : "vLLM") : null);
  const maxSeqs = answers.metrics ? /max_num_seqs="(\d+)"/.exec(answers.metrics) : null;
  const metricSlots = maxSeqs && Number(maxSeqs[1]) > 0 ? Number(maxSeqs[1]) : null;

  const listed = Array.isArray(obj(answers.models)?.data) ? (obj(answers.models)!.data as unknown[]) : null;
  const other = readEngine(str(first?.id), first, { models: listed, configuredModel: lane.model ?? null, ...(answers.extra ?? {}) });
  const engine = lane.engine ?? (props !== null && (props.model_path !== undefined || props.build_info !== undefined) ? "llama.cpp" : vllm ? "vLLM" : other.engine);

  const modalities = obj(props?.modalities);
  const vision = typeof modalities?.vision === "boolean" ? modalities.vision : null;

  const template = str(props?.chat_template);
  const templateMentionsThinking = template === null ? null : /think|reasoning/i.test(template);

  const slotList = Array.isArray(answers.slots) ? answers.slots : null;
  const slotContexts = slotList
    ? slotList.map((s) => num(obj(s)?.n_ctx)).filter((n): n is number => n !== null)
    : null;

  // Per-slot context: prefer what /slots says about the slots themselves; vLLM's one-request limit otherwise.
  const contextPerSlot =
    slotContexts && slotContexts.length > 0 ? slotContexts[0]! : capacity.contextTokens ?? num(first?.max_model_len);

  return {
    laneId,
    label: lane.label,
    reachable: answers.props !== null || answers.slots !== null || answers.models !== null || other.engine !== null,
    engine,
    modelFile: modelFile ?? other.modelFile,
    quant: quantOf(modelFile) ?? other.quant ?? quantOf(other.modelFile),
    build: build ?? other.build,
    slots: capacity.slots ?? metricSlots ?? other.slots,
    slotsSource: capacity.slots === null && (metricSlots !== null || other.slots !== null) ? "server" : capacity.source,
    contextPerSlot: contextPerSlot ?? other.context,
    slotContexts: slotContexts && slotContexts.length > 0 ? slotContexts : null,
    vision: vision ?? other.vision ?? null,
    notes: lane.notes ?? null,
    // llama-server lists the model by its full path; the folder stays off the page.
    modelId: str(first?.id) ? shortModelName(str(first?.id)!) : null,
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
  // vLLM only: asked after the rest, and only when /props did not answer, so a llama-server is not bothered.
  let version: unknown | null = null;
  let metrics: string | null = null;
  const extra: ExtraAnswers = {};
  if (props === null) {
    // Every other engine has its own status address; each that is not there just answers 404.
    const ask = (path: string) => getJson(lane, path, timeoutMs, fetchImpl);
    let ollamaVersion, ollamaPs, ollamaTags, lmstudio, sglang, kobold, tgi, healthAnswer;
    [version, metrics, ollamaVersion, ollamaPs, ollamaTags, lmstudio, sglang, kobold, tgi, healthAnswer] = await Promise.all([
      ask("/version"),
      getText(lane, "/metrics", timeoutMs, fetchImpl),
      ask("/api/version"),
      ask("/api/ps"),
      ask("/api/tags"),
      ask("/api/v0/models"),
      ask("/get_server_info"),
      ask("/api/extra/version"),
      ask("/info"),
      getJsonAndServer(lane, "/health", timeoutMs, fetchImpl),
    ]);
    const strata = healthAnswer.body;
    Object.assign(extra, { ollamaVersion, ollamaPs, ollamaTags, lmstudio, sglang, kobold, tgi, strata, health: strata, server: healthAnswer.server });
    // mlx-vlm keeps its drafter settings at /v1/settings; asked only once the server said it is mlx-vlm.
    if (healthAnswer.server !== null && /^mlx[_-]vlm\//i.test(healthAnswer.server)) {
      extra.mlxSettings = await ask("/v1/settings");
    }
  }
  return readDetails(lane, laneId, { props, slots, models, version, metrics, extra });
}

export function setupOf(d: MachineDetails): MachineSetup {
  return {
    engine: d.engine,
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

  check("Engine", (d) => d.engine);
  check("Model file", (d) => d.modelFile);
  check("Quantization", (d) => d.quant);
  check("Server build", (d) => d.build);
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

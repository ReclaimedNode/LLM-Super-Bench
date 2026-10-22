/**
 * Starting and stopping the model servers the race page talks to.
 *
 * The race page does not start anything: it points at two endpoints that are
 * already serving. Doing that by hand is a pair of long ssh one-liners that
 * have to be right about six things at once -- bind address, prompt cache,
 * thinking, detaching, the log, the pid -- and a machine that falls asleep
 * halfway through looks exactly like a network fault. This is that pair of
 * commands, written down once.
 *
 * Two rules it exists to keep:
 *
 *  - Everything it starts, it can stop BY PID. The server's pid and the
 *    keep-awake's pid are written to a state file the moment they are known,
 *    so `lanes down` stops exactly those processes. Never a pattern match: on
 *    a machine that is also a cluster node, `pkill -f mlx_lm.server` is a way
 *    to take down somebody else's work.
 *  - A lane is not "up" because a process started. It is up when the endpoint
 *    lists the exact model id the race config asks for, because the race's own
 *    preflight refuses anything else -- and because mlx_lm.server treats an
 *    unknown model name as one to go and DOWNLOAD.
 */

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { unlink } from "node:fs/promises";
import { PROJECT_ROOT, defaultDisplayModel } from "./config.ts";
import { extractModelIds } from "./preflight.ts";
import { checkSleep, holdAwake } from "./bench/awake.ts";
import { reachLane } from "./bench/reach.ts";
import type { Pinger } from "./bench/reach.ts";
import type { AwakeHold } from "./bench/awake.ts";
import {
  THINKING_OFF_ARGS,
  parsePid,
  runRemote,
  startServerCommand,
  stopPidCommand,
} from "./bench/ssh.ts";
import type { RemoteRunner } from "./bench/ssh.ts";
import type { SshTarget } from "./bench/types.ts";
import type { RaceConfig } from "./types.ts";

/** Where the pids live between `up` and `down`. Gitignored. */
export const STATE_PATH = resolve(PROJECT_ROOT, ".lanes.json");

/** Where each lane's server writes its output on its own machine. */
export function laneLogFile(port: number): string {
  return `/tmp/llm-race-server-${port}.log`;
}

export const DEFAULT_BIN_DIR = "~/bench-envs/llm/bin";

export class LanesError extends Error {}

// ------------------------------------------------------------------ the models

export type LaneModelKey = "14b" | "27b" | "31b" | "122b" | "35b";

/** One chat model the lanes can be started on by name. */
export interface LaneModel {
  key: LaneModelKey;
  /** The folder it sits in under the models root. */
  dir: string;
  /** What the race page calls it in the lane header. */
  displayModel: string;
}

/**
 * The models `lanes up --model <key>` can start.
 *
 * This table mirrors the model folders every lane machine carries under
 * bench-models: one key has to mean the same weights on every machine, because
 * two machines running different models is not a race. It is here so that
 * changing the model on camera is `lanes down`, `lanes up --model 31b`, reload
 * -- and race.config.json is never edited by hand under the lights.
 */
export const LANE_MODELS: Record<LaneModelKey, LaneModel> = {
  "14b": { key: "14b", dir: "Qwen3-14B-4bit", displayModel: "Qwen3 14B 4-bit" },
  "27b": { key: "27b", dir: "Qwen3.8-27B-4bit", displayModel: "Qwen3.8 27B 4-bit" },
  "31b": { key: "31b", dir: "gemma-4-31b-it-bf16", displayModel: "Gemma 4 31B 16-bit" },
  "122b": { key: "122b", dir: "Qwen3.5-122B-A10B-4bit", displayModel: "Qwen3.5 122B-A10B 4-bit" },
  "35b": { key: "35b", dir: "Qwen3.6-35B-A3B-4bit", displayModel: "Qwen3.6 35B-A3B 4-bit" },
};

/** The keys, in the order they are offered in and refused in. */
export const LANE_MODEL_ORDER: LaneModelKey[] = ["14b", "27b", "31b", "122b", "35b"];

/**
 * Where those folders are on a lane machine.
 *
 * An absolute path rather than `~/bench-models`, because the model id has to be
 * the exact string the endpoint lists at /v1/models: the remote shell expands
 * $HOME long before mlx_lm.server sees it, so the endpoint lists the expanded
 * path, and the race's preflight refuses an id that does not match character
 * for character. Every lane machine runs as the same account as this Mac, so
 * this Mac's home is the home they have.
 */
export const LANE_MODELS_ROOT = `${homedir()}/bench-models`;

/** The model id a lane started on `model` serves, which is what the race asks for. */
export function laneModelPath(model: LaneModel): string {
  return `${LANE_MODELS_ROOT}/${model.dir}`;
}

/**
 * One of the five keys, or a refusal that names all five.
 *
 * A wrong key is refused here rather than at the server, because mlx_lm.server
 * treats a model name it does not recognise as one to go and DOWNLOAD.
 */
export function laneModelFor(value: string | undefined | null): LaneModel {
  const named = LANE_MODEL_ORDER.join(", ");
  if (value === undefined || value === null || value.trim() === "") {
    throw new LanesError(`--model needs one of these after it: ${named}.`);
  }
  const key = value.trim().toLowerCase();
  if (!Object.hasOwn(LANE_MODELS, key)) {
    throw new LanesError(`I do not know the model "${value}". It is one of: ${named}.`);
  }
  return LANE_MODELS[key as LaneModelKey];
}

// ------------------------------------------------------------------ the config

export interface LaneTarget {
  label: string;
  baseUrl: string;
  /** The exact id the endpoint must list, which is what the race asks for. */
  model: string;
  /** What the race page calls that model in the lane header. */
  displayModel: string;
  /** The `--model` key it came from, null when it came from the config. */
  modelKey: LaneModelKey | null;
  target: SshTarget;
}

export interface LaneTargets {
  lanes: LaneTarget[];
  /** Lanes on this Mac, which nothing needs to start over ssh. */
  local: string[];
}

/**
 * Which machines a race config points at.
 *
 * The host and port come from the lane's own baseUrl -- there is no second
 * place to write the address and get it wrong. A lane may still carry an `ssh`
 * block to override the binary directory or the ssh user.
 *
 * A `model` replaces the config's model on EVERY lane, for this session only:
 * the config file is never written to, and a race whose machines ran different
 * weights would not be a race.
 */
export function targetsFromRaceConfig(raw: unknown, model: LaneModel | null = null): LaneTargets {
  const config = raw as { lanes?: unknown[]; laneBinDir?: unknown };
  if (!Array.isArray(config?.lanes) || config.lanes.length === 0) {
    throw new LanesError("That config has no lanes. Copy race.config.example.json to race.config.json and fill it in.");
  }

  const defaultBin = typeof config.laneBinDir === "string" ? config.laneBinDir : DEFAULT_BIN_DIR;
  const lanes: LaneTarget[] = [];
  const local: string[] = [];

  for (const [i, entry] of config.lanes.entries()) {
    const lane = entry as {
      label?: unknown;
      baseUrl?: unknown;
      model?: unknown;
      displayModel?: unknown;
      ssh?: Record<string, unknown>;
    };
    const label = typeof lane.label === "string" && lane.label !== "" ? lane.label : `lane ${i}`;
    if (typeof lane.baseUrl !== "string" || typeof lane.model !== "string") {
      throw new LanesError(`Lane "${label}" needs a baseUrl and a model.`);
    }

    let url: URL;
    try {
      url = new URL(lane.baseUrl);
    } catch {
      throw new LanesError(`Lane "${label}" has a baseUrl that is not a URL: ${lane.baseUrl}`);
    }

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") {
      local.push(label);
      continue;
    }

    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    const ssh = lane.ssh ?? {};
    const target: SshTarget = {
      host: typeof ssh.host === "string" ? ssh.host : url.hostname,
      binDir: typeof ssh.binDir === "string" ? ssh.binDir : defaultBin,
      port,
    };
    if (typeof ssh.user === "string") target.user = ssh.user;
    if (typeof ssh.sshPort === "number") target.sshPort = ssh.sshPort;

    const configDisplay = typeof lane.displayModel === "string" && lane.displayModel.trim() !== ""
      ? lane.displayModel
      : defaultDisplayModel(lane.model);

    lanes.push({
      label,
      baseUrl: lane.baseUrl.replace(/\/+$/, ""),
      model: model === null ? lane.model : laneModelPath(model),
      displayModel: model === null ? configDisplay : model.displayModel,
      modelKey: model === null ? null : model.key,
      target,
    });
  }

  return { lanes, local };
}

// ------------------------------------------------------------------ state

export interface LaneProcess {
  label: string;
  host: string;
  port: number;
  model: string;
  /** What the race page calls that model. Read on every page load. */
  displayModel: string;
  /** The `--model` key it was started from, null when the model came from the config. */
  modelKey: LaneModelKey | null;
  serverPid: number;
  /** Null when the machine could not be held awake; the rest still works. */
  awakePid: number | null;
  logFile: string;
  startedAt: string;
}

export interface LanesState {
  startedAt: string;
  lanes: LaneProcess[];
}

export async function readLanesState(path = STATE_PATH): Promise<LanesState | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as LanesState;
  } catch {
    return null;
  }
}

export async function writeLanesState(state: LanesState, path = STATE_PATH): Promise<void> {
  await Bun.write(path, JSON.stringify(state, null, 2) + "\n");
}

export async function clearLanesState(path = STATE_PATH): Promise<void> {
  await unlink(path).catch(() => undefined);
}

// ------------------------------------------------------------------ up

/** Asks an endpoint what it is serving. Null when it does not answer. */
export type ModelLister = (baseUrl: string, timeoutMs: number) => Promise<string[] | null>;

export const fetchModelIds: ModelLister = async (baseUrl, timeoutMs) => {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return extractModelIds(await response.json());
  } catch {
    return null;
  }
};

export interface UpOptions {
  targets: LaneTargets;
  run?: RemoteRunner;
  list?: ModelLister;
  /** How long to wait for the endpoint to list the model. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** How long the machine is held awake. */
  holdSeconds?: number;
  statePath?: string;
  log?: (message: string) => void;
  /** Test seams for the wake-it-up retry. */
  ping?: Pinger;
  sleep?: (ms: number) => Promise<void>;
}

export interface LaneUpResult {
  label: string;
  ok: boolean;
  process: LaneProcess | null;
  detail: string;
}

/**
 * Starts one lane and waits until its endpoint lists the model.
 *
 * A lane that never lists it is stopped again, both the server and the hold:
 * leaving a half-started machine behind is how a later run inherits a mystery.
 */
async function bringOneUp(lane: LaneTarget, opts: UpOptions): Promise<LaneUpResult> {
  const run = opts.run ?? runRemote;
  const list = opts.list ?? fetchModelIds;
  const log = opts.log ?? (() => {});

  // First contact, which is where a sleeping machine bites: this wakes it and
  // tries again rather than failing on a timeout that is not a fault.
  const reached = await reachLane(lane.target, {
    run,
    ping: opts.ping,
    sleep: opts.sleep,
    log: (message) => log(`  ${lane.label}: ${message}`),
  });
  if (!reached.ok) {
    return { label: lane.label, ok: false, process: null, detail: reached.detail };
  }
  if (reached.wokeIt) log(`  ${lane.label}: awake now, carrying on.`);

  const { warning } = await checkSleep(lane.target, run);
  if (warning) log(`! ${lane.label}: ${warning}`);

  let hold: AwakeHold | null = null;
  const stopHold = async () => {
    if (hold) await hold.release();
  };

  hold = await holdAwake({ target: lane.target, seconds: opts.holdSeconds ?? 8 * 60 * 60, run });
  if (hold.note) log(`  ${lane.label}: ${hold.note}`);

  const logFile = laneLogFile(lane.target.port);
  const started = await run(
    lane.target,
    startServerCommand({
      target: lane.target,
      modelId: lane.model,
      promptCacheSize: 0,
      chatTemplateArgs: THINKING_OFF_ARGS,
      logFile,
    }),
    { timeoutMs: 60_000 },
  );

  const serverPid = parsePid(started.stdout);
  if (serverPid === null) {
    await stopHold();
    return {
      label: lane.label,
      ok: false,
      process: null,
      detail: `no pid came back from the server command: ${(started.stderr || started.stdout).trim().slice(0, 200) || "nothing"}`,
    };
  }

  const process: LaneProcess = {
    label: lane.label,
    host: lane.target.host,
    port: lane.target.port,
    model: lane.model,
    displayModel: lane.displayModel,
    modelKey: lane.modelKey,
    serverPid,
    awakePid: hold.pid,
    logFile,
    startedAt: new Date().toISOString(),
  };
  log(`  ${lane.label}: server pid ${serverPid}, loading the model.`);

  // Up means "serving what the race will ask for", not "a process started".
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10 * 60_000);
  let lastSeen: string[] = [];
  while (Date.now() < deadline) {
    const ids = await list(lane.baseUrl, 10_000);
    if (ids && ids.length > 0) {
      lastSeen = ids;
      // Exact id first. Otherwise the same folder name: mlx_lm.server lists the
      // path it resolved, so a symlinked model folder (for example
      // ~/bench-models/X -> ~/.lmstudio/models/mlx-community/X) comes back as
      // the target, not the link. Record the served id: the race sends that
      // string, so the server keeps the model it loaded instead of loading a
      // second copy under a new name. (Without this, every model switch hung.)
      const served = servedModelId(ids, lane.model);
      if (served !== undefined) {
        process.model = served;
        return { label: lane.label, ok: true, process, detail: `serving ` };
      }
    }
    await Bun.sleep(opts.pollMs ?? 3000);
  }

  await run(lane.target, stopPidCommand(serverPid), { timeoutMs: 60_000 }).catch(() => undefined);
  await stopHold();
  return {
    label: lane.label,
    ok: false,
    process: null,
    detail:
      lastSeen.length > 0
        ? `the endpoint answered but never listed "${lane.model}". It is serving: ${lastSeen.join(", ")}. ` +
          `The race refuses an id it cannot see, so fix the model in race.config.json to one of those.`
        : `the endpoint never answered on ${lane.baseUrl}. Its log is at ${logFile} on that machine.`,
  };
}

export interface UpReport {
  results: LaneUpResult[];
  state: LanesState | null;
  skipped: string[];
}

export async function bringLanesUp(opts: UpOptions): Promise<UpReport> {
  const statePath = opts.statePath ?? STATE_PATH;
  const already = await readLanesState(statePath);
  if (already !== null && already.lanes.length > 0) {
    throw new LanesError(
      `Lanes are already recorded as up (${already.lanes.map((l) => `${l.label} pid ${l.serverPid}`).join(", ")}). ` +
        `Run \`bun run lanes down\` first, or delete ${statePath} if you know they are gone.`,
    );
  }

  // The machines are independent, so they start at the same time: each one is
  // loading tens of gigabytes of weights and waiting for them in turn doubles
  // the wait for no reason.
  const results = await Promise.all(opts.targets.lanes.map((lane) => bringOneUp(lane, opts)));
  const up = results.filter((r) => r.process !== null).map((r) => r.process!);

  const state = up.length > 0 ? { startedAt: new Date().toISOString(), lanes: up } : null;
  if (state) await writeLanesState(state, statePath);

  return { results, state, skipped: opts.targets.local };
}

// ------------------------------------------------------------------ down

export interface DownOptions {
  run?: RemoteRunner;
  statePath?: string;
  log?: (message: string) => void;
}

export interface DownResult {
  label: string;
  serverStopped: boolean;
  awakeStopped: boolean | null;
  detail: string;
}

/**
 * Stops exactly what `up` started, by pid, on the machine it started it on.
 */
export async function takeLanesDown(opts: DownOptions = {}): Promise<DownResult[]> {
  const statePath = opts.statePath ?? STATE_PATH;
  const run = opts.run ?? runRemote;
  const state = await readLanesState(statePath);

  if (state === null || state.lanes.length === 0) {
    throw new LanesError(
      `Nothing to stop: no lanes are recorded as up. If a server is still running from an earlier session, ` +
        `find its pid on that machine and stop that pid -- never a pattern match, because these machines run other things.`,
    );
  }

  const results: DownResult[] = [];
  for (const lane of state.lanes) {
    const target: SshTarget = { host: lane.host, binDir: DEFAULT_BIN_DIR, port: lane.port };

    const stopped = await run(target, stopPidCommand(lane.serverPid), { timeoutMs: 60_000 }).catch(() => null);
    const serverStopped = stopped !== null && stopped.stdout.includes("STOPPED");

    let awakeStopped: boolean | null = null;
    if (lane.awakePid !== null) {
      const let_go = await run(target, stopPidCommand(lane.awakePid), { timeoutMs: 60_000 }).catch(() => null);
      awakeStopped = let_go !== null && let_go.stdout.includes("STOPPED");
    }

    results.push({
      label: lane.label,
      serverStopped,
      awakeStopped,
      detail:
        `server pid ${lane.serverPid} ${serverStopped ? "stopped" : "NOT confirmed stopped"}` +
        (lane.awakePid === null
          ? ", no keep-awake was held"
          : `, keep-awake pid ${lane.awakePid} ${awakeStopped ? "stopped" : "NOT confirmed stopped"}`),
    });
  }

  // The record goes only when everything in it is accounted for, so a failed
  // stop cannot be forgotten by the next `up`.
  if (results.every((r) => r.serverStopped && r.awakeStopped !== false)) await clearLanesState(statePath);
  return results;
}

// ------------------------------------------------------------------ status

export interface StatusResult {
  label: string;
  baseUrl: string;
  serverPid: number;
  running: boolean;
  /** The model id this lane was started on, which is the one the race asks for. */
  model: string;
  /** That model's name on the page. */
  displayModel: string;
  serving: string[] | null;
  ready: boolean;
}

export async function lanesStatus(opts: DownOptions & { list?: ModelLister } = {}): Promise<StatusResult[]> {
  const run = opts.run ?? runRemote;
  const list = opts.list ?? fetchModelIds;
  const state = await readLanesState(opts.statePath ?? STATE_PATH);
  if (state === null) return [];

  return await Promise.all(
    state.lanes.map(async (lane) => {
      const target: SshTarget = { host: lane.host, binDir: DEFAULT_BIN_DIR, port: lane.port };
      const alive = await run(target, `kill -0 ${lane.serverPid} 2>/dev/null && echo ALIVE || echo GONE`, {
        timeoutMs: 30_000,
      }).catch(() => null);
      const baseUrl = `http://${lane.host}:${lane.port}`;
      const serving = await list(baseUrl, 10_000);
      return {
        label: lane.label,
        baseUrl,
        serverPid: lane.serverPid,
        running: alive !== null && alive.stdout.includes("ALIVE"),
        model: lane.model,
        displayModel: lane.displayModel ?? defaultDisplayModel(lane.model),
        serving,
        ready: serving !== null && serving.includes(lane.model),
      };
    }),
  );
}

// ------------------------------------------------------------------ what is served

/**
 * A race config whose lanes carry the model `lanes up` actually started.
 *
 * The page and the race both read this, so the name in the lane header, the id
 * preflight checks for, and the model the request asks for are one fact rather
 * than three that can drift apart. With no record -- nothing started by this
 * tool, or `lanes down` since -- every lane falls back to race.config.json,
 * which is what happened before there was a record at all.
 *
 * Lanes are matched by label, which the config already makes unique because it
 * is what the scoreboard names.
 */
export function withServedModels(config: RaceConfig, state: LanesState | null): RaceConfig {
  if (state === null || state.lanes.length === 0) return config;
  const served = new Map(state.lanes.map((lane) => [lane.label, lane]));
  return {
    ...config,
    lanes: config.lanes.map((lane) => {
      const record = served.get(lane.label);
      if (record === undefined) return lane;
      return {
        ...lane,
        model: record.model,
        // A record written before this field existed still names its model.
        displayModel: record.displayModel ?? defaultDisplayModel(record.model),
      };
    }),
  };
}

/**
 * Which listed id is the requested model. Exact match first. Otherwise the
 * same folder name, because mlx_lm.server lists the path it resolved and a
 * machine's ~/bench-models entries can be symlinks: into LM Studio's folder
 * (same folder name) or into a cache that names each folder
 * `mlx-community--<name>`. Returns the served id, which is the string the race
 * must send so the server keeps the copy it already loaded.
 */
export function servedModelId(ids: string[], requested: string): string | undefined {
  const exact = ids.find((id) => id === requested);
  if (exact !== undefined) return exact;
  const want = basename(requested);
  return ids.find((id) => {
    const have = basename(id);
    return have === want || have.endsWith(`--${want}`);
  });
}

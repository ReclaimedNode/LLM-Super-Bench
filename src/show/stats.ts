/**
 * The live strip under each lane: what that Mac's chip is doing, right now,
 * while the camera is on it.
 *
 * One `macmon pipe` runs on each machine for as long as somebody has the tests
 * page open, printing a JSON object twice a second. This file turns one of
 * those lines into the six numbers the strip shows, and owns the rule that
 * matters more than any of them: the streams start when the first page
 * connects and are killed when the last one goes away, so a reload cannot
 * leave an ssh process behind on this Mac or a macmon running on theirs.
 *
 * None of this touches the tests. The strip is a second, separate stream; it
 * never takes the run lock, never waits on a run, and a lane whose stats will
 * not start -- asleep, no macmon, ssh refused -- shows dashes and costs the
 * run nothing.
 *
 * Everything above `startMacmon` is a function of its input: the command, the
 * parsing, and the start/stop counting are all proven without a Mac.
 */

import { remoteArg, sshArgs } from "../bench/ssh.ts";
import type { SshTarget } from "../bench/types.ts";

// ------------------------------------------------------------------ command

/**
 * Where macmon is, written out in full.
 *
 * It is NOT on the login PATH on either machine, and a non-interactive ssh
 * shell has even less of a PATH than a login one, so a bare `macmon` finds
 * nothing. The M5 Ultra has no Homebrew and no developer tools either, which is
 * why nothing else is assumed to be there.
 */
export const MACMON_BIN = "~/.local/bin/macmon";

/** Twice a second, which is what the strip is asked to update at. */
export const MACMON_INTERVAL_MS = 500;

/** A machine that is asleep should say so in seconds, not in a minute. */
export const MACMON_CONNECT_TIMEOUT_SEC = 10;

/** The remote command: one JSON object per line, for as long as it is left running. */
export function macmonCommand(intervalMs: number = MACMON_INTERVAL_MS): string {
  const bin = remoteArg(MACMON_BIN, "macmon");
  return `${bin} pipe -i '${Math.max(1, Math.trunc(intervalMs))}'`;
}

// ------------------------------------------------------------------ parsing

/** The six numbers one lane's strip shows, rounded the way they are shown. */
export interface LaneStats {
  /** The GPU's active ratio as a whole percent. */
  gpuPct: number;
  gpuWatts: number;
  /** The CPU's usage as a whole percent. */
  cpuPct: number;
  ramUsedGb: number;
  ramTotalGb: number;
  /** The Neural Engine's draw. Expected to sit at zero, which is the point. */
  aneWatts: number;
  gpuTempC: number;
}

/**
 * A gigabyte here is 1024 three times over, not 1000.
 *
 * A 256GB machine reports 274,877,906,944 bytes. Divided the other way that
 * reads 274.9 GB on a strip under a lane labelled 256GB, which on camera looks
 * like the tool is wrong about the machine it is measuring.
 */
const BYTES_PER_GB = 1024 ** 3;

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(ratio: number): number {
  return Math.min(100, Math.max(0, Math.round(ratio * 100)));
}

function numberAt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One macmon line as the strip's numbers, or null.
 *
 * Null covers everything that is not a reading: a half-written line, a warning
 * macmon printed on its way up, a future version that renamed a field. The
 * caller keeps the stream open and waits for the next line, because one line
 * this tool cannot read is not a reason to stop showing a machine that is
 * plainly still talking.
 *
 * Two of the fields are ratios in spite of their names: `gpu_usage` is a pair
 * of frequency and active ratio, and `cpu_usage_pct` is 0 to 1, not 0 to 100.
 */
export function parseMacmonLine(line: string): LaneStats | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const gpu = raw.gpu_usage;
  const gpuRatio = Array.isArray(gpu) ? numberAt(gpu[1]) : null;
  const gpuWatts = numberAt(raw.gpu_power);
  const cpuRatio = numberAt(raw.cpu_usage_pct);
  const aneWatts = numberAt(raw.ane_power);

  const memory = typeof raw.memory === "object" && raw.memory !== null ? (raw.memory as Record<string, unknown>) : {};
  const ramUsed = numberAt(memory.ram_usage);
  const ramTotal = numberAt(memory.ram_total);

  const temp = typeof raw.temp === "object" && raw.temp !== null ? (raw.temp as Record<string, unknown>) : {};
  const gpuTemp = numberAt(temp.gpu_temp_avg);

  if (
    gpuRatio === null ||
    gpuWatts === null ||
    cpuRatio === null ||
    aneWatts === null ||
    ramUsed === null ||
    ramTotal === null ||
    gpuTemp === null
  ) {
    return null;
  }

  return {
    gpuPct: percent(gpuRatio),
    gpuWatts: oneDecimal(gpuWatts),
    cpuPct: percent(cpuRatio),
    ramUsedGb: oneDecimal(ramUsed / BYTES_PER_GB),
    ramTotalGb: oneDecimal(ramTotal / BYTES_PER_GB),
    aneWatts: oneDecimal(aneWatts),
    gpuTempC: Math.round(gpuTemp),
  };
}

// ------------------------------------------------------------------ the hub

export type StatsEvent =
  | { type: "stats"; laneId: string; stats: LaneStats }
  | { type: "stats-gone"; laneId: string; reason: string };

export interface StatsLaneRef {
  laneId: string;
  label: string;
}

export interface StatsHandlers {
  /** One line off that machine, exactly as it printed it. */
  onLine: (line: string) => void;
  /** The stream is over, and why. Never called for a stop we asked for. */
  onEnd: (reason: string) => void;
}

/** Starts one lane's stream and hands back the way to stop it. A seam, for tests. */
export type StartStats = (lane: StatsLaneRef, handlers: StatsHandlers) => () => void;

/**
 * One stream per lane, shared by every page that is open.
 *
 * The counting is the whole point. Two Macs and any number of browser tabs
 * means one macmon each, not one per tab, and -- because the page is reloaded
 * constantly on a filming day -- the children have to go the moment the last
 * page does. A lane that dies on its own is dropped rather than retried in
 * place; the next page to connect starts it again, which is what a reload
 * already does.
 */
export class StatsHub {
  readonly #lanes: StatsLaneRef[];
  readonly #start: StartStats;
  readonly #log: (message: string) => void;
  /** The lanes with a stream, and the way to stop each one. */
  readonly #stops = new Map<string, () => void>();
  readonly #subscribers = new Set<(event: StatsEvent) => void>();
  /** The last reading per lane, so a page that has just opened is not blank. */
  readonly #latest = new Map<string, LaneStats>();

  constructor(lanes: StatsLaneRef[], start: StartStats, log: (message: string) => void = () => {}) {
    this.#lanes = lanes;
    this.#start = start;
    this.#log = log;
  }

  /** How many pages are watching. */
  get subscribers(): number {
    return this.#subscribers.size;
  }

  /** The lanes with a stream running right now. */
  get running(): string[] {
    return [...this.#stops.keys()];
  }

  /**
   * One page starts watching. The first one starts the streams; every one of
   * them is handed whatever is already known so the strip fills in at once.
   */
  subscribe(send: (event: StatsEvent) => void): () => void {
    const first = this.#subscribers.size === 0;
    this.#subscribers.add(send);
    for (const [laneId, stats] of this.#latest) send({ type: "stats", laneId, stats });
    if (first || this.#stops.size < this.#lanes.length) this.#startAll();
    return () => this.#drop(send);
  }

  #drop(send: (event: StatsEvent) => void): void {
    // Idempotent: a stream that is both cancelled and aborted must not count
    // as two pages leaving, which would stop the streams under a page that is
    // still open.
    if (!this.#subscribers.delete(send)) return;
    if (this.#subscribers.size === 0) this.stop();
  }

  /** Stops every stream. Called when the last page goes, and on the way down. */
  stop(): void {
    const stops = [...this.#stops.values()];
    this.#stops.clear();
    this.#latest.clear();
    for (const stop of stops) {
      try {
        stop();
      } catch {
        /* a child that is already gone is the outcome we wanted anyway */
      }
    }
  }

  #startAll(): void {
    for (const lane of this.#lanes) {
      if (this.#stops.has(lane.laneId)) continue;
      // Marked as running before it starts, so a stream that fails inside the
      // call -- ssh refusing at once -- is still recognised when it reports.
      this.#stops.set(lane.laneId, () => {});
      const stop = this.#start(lane, {
        onLine: (line) => this.#line(lane, line),
        onEnd: (reason) => this.#ended(lane, reason),
      });
      if (this.#stops.has(lane.laneId)) this.#stops.set(lane.laneId, stop);
      else stop();
    }
  }

  #line(lane: StatsLaneRef, line: string): void {
    const stats = parseMacmonLine(line);
    // A line this tool cannot read is skipped, not fatal: the next one is 500
    // milliseconds away.
    if (stats === null) return;
    this.#latest.set(lane.laneId, stats);
    this.#send({ type: "stats", laneId: lane.laneId, stats });
  }

  #ended(lane: StatsLaneRef, reason: string): void {
    if (!this.#stops.has(lane.laneId)) return;
    this.#stops.delete(lane.laneId);
    this.#latest.delete(lane.laneId);
    this.#log(`stats: ${lane.label} stopped reporting -- ${reason}`);
    this.#send({ type: "stats-gone", laneId: lane.laneId, reason });
  }

  #send(event: StatsEvent): void {
    for (const send of [...this.#subscribers]) {
      try {
        send(event);
      } catch {
        // A page that cannot be written to is a page that has gone. It is
        // dropped here rather than being allowed to throw into the reader.
        this.#drop(send);
      }
    }
  }
}

// ------------------------------------------------------------------ the ssh

/**
 * One lane's macmon, over ssh, line by line.
 *
 * The only part of this file that needs a Mac. The connect timeout is short on
 * purpose: a machine that is asleep says so in ten seconds and the strip shows
 * dashes, rather than the page waiting the best part of a minute for ssh to
 * admit it.
 */
export function startMacmon(
  target: SshTarget,
  handlers: StatsHandlers,
  opts: { intervalMs?: number; connectTimeoutSec?: number } = {},
): () => void {
  const command = macmonCommand(opts.intervalMs ?? MACMON_INTERVAL_MS);
  const proc = Bun.spawn(sshArgs(target, command, opts.connectTimeoutSec ?? MACMON_CONNECT_TIMEOUT_SEC), {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let asked = false;
  let ended = false;
  const end = (reason: string) => {
    if (ended || asked) return;
    ended = true;
    handlers.onEnd(reason);
  };

  // Drained as it arrives rather than at the end: a pipe nobody is reading
  // fills up and blocks the process writing into it.
  let why = "";
  void (async () => {
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        why = `${why}${new TextDecoder().decode(chunk)}`.slice(-400);
      }
    } catch {
      /* nothing more to read */
    }
  })();

  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          if (line !== "") handlers.onLine(line);
        }
        // A reading is a few thousand characters. Anything this long is not
        // one, and holding on to it would grow for as long as the page is up.
        if (buffer.length > 1_000_000) buffer = "";
      }
    } catch {
      /* the stream ended under us; the exit code below says what happened */
    }
    const code = await proc.exited;
    const last = why.trim().split("\n").filter(Boolean).at(-1);
    end(`it exited ${code}${last ? `: ${last}` : ""}`);
  })();

  return () => {
    asked = true;
    proc.kill();
  };
}

/**
 * Memory, sampled on each machine while a sweep runs.
 *
 * A sweep can say that eight streams were slower than four, or that two of
 * sixteen failed. It cannot say why. This file adds the reading that usually
 * answers it: how much host memory and GPU memory the machine was using while
 * each race ran, against how much it has.
 *
 * One small shell loop runs on each machine for as long as the sweep does, over
 * ssh (or directly, for a machine that is this one). Once a second it prints
 * what the operating system itself reports: /proc/meminfo and nvidia-smi on
 * Linux, vm_stat and sysctl on macOS. Nothing is installed and nothing is
 * guessed from a model's size. The parsing happens here, not there, so the
 * remote side is a handful of commands with no quoting to get wrong.
 *
 * Like the live strip on the tests page, this is a second stream beside the
 * race. It never delays a request, and a machine whose sampler will not start
 * (asleep, no key, not Linux or macOS) costs the sweep nothing: its memory
 * columns are blank and a line says why.
 *
 * What the numbers are:
 *   host used   Linux: MemTotal - MemAvailable. macOS: (active + wired +
 *               compressor pages) x page size, the usual reading of "memory used".
 *   GPU used    the sum of nvidia-smi's memory.used over every card. Blank on a
 *               machine without nvidia-smi; on Apple silicon GPU memory is host memory.
 *   swap used   SwapTotal - SwapFree, or vm.swapusage's "used".
 * Each is the PEAK over the samples taken while one race ran.
 */

import { sshArgs } from "./bench/ssh.ts";
import type { SshTarget } from "./bench/types.ts";
import type { LaneConfig } from "./types.ts";

/** Seconds between samples. */
export const MEMORY_INTERVAL_SEC = 1;
/** The remote loop ends itself after this long even if nobody stops it. */
export const MEMORY_MAX_SEC = 12 * 60 * 60;
/** A machine that is asleep should say so in seconds. */
export const MEMORY_CONNECT_TIMEOUT_SEC = 10;

const BEGIN = "LSB-MEM-BEGIN";
const END = "LSB-MEM-END";
const BYTES_PER_GB = 1024 ** 3;

/**
 * The loop each machine runs, fed to `sh -s` on its standard input so nothing
 * in it passes through a remote shell's quoting. It only reads: no file is
 * written and nothing is installed. When the connection closes, the next echo
 * fails and the loop ends.
 */
export function memoryScript(intervalSec: number = MEMORY_INTERVAL_SEC, maxSec: number = MEMORY_MAX_SEC): string {
  const every = Math.max(1, Math.trunc(intervalSec));
  const limit = Math.max(1, Math.trunc(maxSec));
  return [
    "os=$(uname -s)",
    `end=$(( $(date +%s) + ${limit} ))`,
    'while [ "$(date +%s)" -lt "$end" ]; do',
    `  echo "${BEGIN} $os" || exit 0`,
    '  if [ "$os" = Linux ]; then',
    "    grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    "    if command -v nvidia-smi >/dev/null 2>&1; then",
    "      nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | sed 's/^/GPU: /'",
    "    fi",
    '  elif [ "$os" = Darwin ]; then',
    '    echo "MemSize: $(sysctl -n hw.memsize)"',
    "    vm_stat",
    '    echo "Swap: $(sysctl -n vm.swapusage)"',
    "  fi",
    `  echo "${END}" || exit 0`,
    `  sleep ${every}`,
    "done",
    "",
  ].join("\n");
}

// ------------------------------------------------------------------ parsing

/** One sample: what a machine said about its memory at one moment, in bytes. */
export interface MemoryReading {
  os: "linux" | "darwin";
  hostTotalBytes: number;
  hostUsedBytes: number;
  /** Null when the machine did not say. */
  swapUsedBytes: number | null;
  /** One entry per card nvidia-smi listed. Empty when there is no nvidia-smi. */
  gpus: { usedBytes: number; totalBytes: number }[];
}

const KB = 1024;
const MIB = 1024 * 1024;

function wholeNumber(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number(text.replace(/[.,]$/, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseLinux(lines: string[]): MemoryReading | null {
  const kb: Record<string, number> = {};
  const gpus: MemoryReading["gpus"] = [];
  for (const line of lines) {
    const mem = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s*kB/.exec(line);
    if (mem) {
      kb[mem[1]!] = Number(mem[2]);
      continue;
    }
    const gpu = /^GPU:\s*(\d+)\s*,\s*(\d+)\s*$/.exec(line);
    if (gpu) gpus.push({ usedBytes: Number(gpu[1]) * MIB, totalBytes: Number(gpu[2]) * MIB });
  }
  const total = kb.MemTotal;
  const available = kb.MemAvailable;
  if (total === undefined || available === undefined || total <= 0 || available > total) return null;
  const swap =
    kb.SwapTotal !== undefined && kb.SwapFree !== undefined && kb.SwapFree <= kb.SwapTotal
      ? (kb.SwapTotal - kb.SwapFree) * KB
      : null;
  return { os: "linux", hostTotalBytes: total * KB, hostUsedBytes: (total - available) * KB, swapUsedBytes: swap, gpus };
}

/** "1024.00M", "2.50G", "0.00K" as bytes. */
function sizeWithSuffix(text: string): number | null {
  const m = /^([\d.]+)([KMGT])$/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return n * 1024 ** (["K", "M", "G", "T"].indexOf(m[2]!) + 1);
}

function parseDarwin(lines: string[]): MemoryReading | null {
  let total: number | null = null;
  let page: number | null = null;
  let active: number | null = null;
  let wired: number | null = null;
  let compressor: number | null = null;
  let swap: number | null = null;
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = /^MemSize:\s*(\d+)/.exec(line))) total = Number(m[1]);
    else if ((m = /page size of (\d+) bytes/.exec(line))) page = Number(m[1]);
    else if ((m = /^Pages active:\s+(\d+)\.?/.exec(line))) active = wholeNumber(m[1]);
    else if ((m = /^Pages wired down:\s+(\d+)\.?/.exec(line))) wired = wholeNumber(m[1]);
    else if ((m = /^Pages occupied by compressor:\s+(\d+)\.?/.exec(line))) compressor = wholeNumber(m[1]);
    else if ((m = /^Swap:.*\bused = (\S+)/.exec(line))) swap = sizeWithSuffix(m[1]!);
  }
  if (total === null || total <= 0 || page === null || active === null || wired === null || compressor === null) return null;
  const used = (active + wired + compressor) * page;
  if (used > total * 1.05) return null;
  return { os: "darwin", hostTotalBytes: total, hostUsedBytes: Math.min(used, total), swapUsedBytes: swap, gpus: [] };
}

/**
 * One block of the loop's output (the lines between its BEGIN and END markers)
 * as a reading, or null when it is not one: a half-written block, an operating
 * system this does not read, a format that changed. The caller skips it and
 * waits for the next.
 */
export function parseMemoryBlock(os: string, lines: string[]): MemoryReading | null {
  if (os === "Linux") return parseLinux(lines);
  if (os === "Darwin") return parseDarwin(lines);
  return null;
}

/** Feeds on the loop's output a line at a time and calls back once per complete block. */
export function memoryLineReader(onReading: (reading: MemoryReading) => void, onUnreadable: (os: string) => void = () => {}) {
  let os: string | null = null;
  let block: string[] = [];
  return (line: string): void => {
    if (line.startsWith(BEGIN)) {
      os = line.slice(BEGIN.length).trim();
      block = [];
      return;
    }
    if (os === null) return;
    if (line === END) {
      const reading = parseMemoryBlock(os, block);
      if (reading) onReading(reading);
      else onUnreadable(os);
      os = null;
      block = [];
      return;
    }
    // A block is a few dozen lines. Anything longer is not one.
    if (block.length < 400) block.push(line);
  };
}

// ------------------------------------------------------------------ peaks

/** The most a machine used while one race (or one sweep cell) ran, in GB of 1024 x 1024 x 1024 bytes. */
export interface MemoryPeak {
  /** How many samples this is the peak of. One or two means a short race, not a thorough reading. */
  samples: number;
  hostPeakGb: number;
  hostTotalGb: number;
  /** Every card together. Null on a machine with no nvidia-smi. */
  gpuPeakGb: number | null;
  gpuTotalGb: number | null;
  /** How many cards that is. */
  gpus: number;
  swapPeakGb: number | null;
}

const gb = (bytes: number): number => Math.round((bytes / BYTES_PER_GB) * 100) / 100;

export function peakOf(readings: MemoryReading[]): MemoryPeak | null {
  if (readings.length === 0) return null;
  const withGpu = readings.filter((r) => r.gpus.length > 0);
  const swaps = readings.map((r) => r.swapUsedBytes).filter((v): v is number => v !== null);
  const gpuUsed = (r: MemoryReading) => r.gpus.reduce((sum, g) => sum + g.usedBytes, 0);
  const gpuTotal = (r: MemoryReading) => r.gpus.reduce((sum, g) => sum + g.totalBytes, 0);
  return {
    samples: readings.length,
    hostPeakGb: gb(Math.max(...readings.map((r) => r.hostUsedBytes))),
    hostTotalGb: gb(Math.max(...readings.map((r) => r.hostTotalBytes))),
    gpuPeakGb: withGpu.length > 0 ? gb(Math.max(...withGpu.map(gpuUsed))) : null,
    gpuTotalGb: withGpu.length > 0 ? gb(Math.max(...withGpu.map(gpuTotal))) : null,
    gpus: withGpu.length > 0 ? Math.max(...withGpu.map((r) => r.gpus.length)) : 0,
    swapPeakGb: swaps.length > 0 ? gb(Math.max(...swaps)) : null,
  };
}

/** Several races' peaks as one: the highest of each, over all their samples. */
export function mergePeaks(peaks: (MemoryPeak | null | undefined)[]): MemoryPeak | null {
  const real = peaks.filter((p): p is MemoryPeak => !!p);
  if (real.length === 0) return null;
  const maxOf = (pick: (p: MemoryPeak) => number | null): number | null => {
    const values = real.map(pick).filter((v): v is number => v !== null);
    return values.length > 0 ? Math.max(...values) : null;
  };
  return {
    samples: real.reduce((sum, p) => sum + p.samples, 0),
    hostPeakGb: maxOf((p) => p.hostPeakGb) as number,
    hostTotalGb: maxOf((p) => p.hostTotalGb) as number,
    gpuPeakGb: maxOf((p) => p.gpuPeakGb),
    gpuTotalGb: maxOf((p) => p.gpuTotalGb),
    gpus: Math.max(...real.map((p) => p.gpus)),
    swapPeakGb: maxOf((p) => p.swapPeakGb),
  };
}

/** "41.2 of 128.0 GB (32%)". */
function usedOf(used: number, total: number): string {
  const pct = total > 0 ? ` (${Math.round((used / total) * 100)}%)` : "";
  return `${used.toFixed(1)} of ${total.toFixed(1)} GB${pct}`;
}

/** One peak in words, for the log, the table and the sustained-streams sentence. */
export function peakText(p: MemoryPeak): string {
  const parts = [`host ${usedOf(p.hostPeakGb, p.hostTotalGb)}`];
  if (p.gpuPeakGb !== null && p.gpuTotalGb !== null) {
    parts.push(`GPU ${usedOf(p.gpuPeakGb, p.gpuTotalGb)}${p.gpus > 1 ? ` over ${p.gpus} cards` : ""}`);
  }
  if (p.swapPeakGb !== null && p.swapPeakGb >= 0.1) parts.push(`swap ${p.swapPeakGb.toFixed(1)} GB`);
  return parts.join(", ");
}

// ------------------------------------------------------------------ the watch

export interface MemoryLaneRef {
  laneId: string;
  label: string;
}

export interface MemoryHandlers {
  /** One line off that machine, exactly as it printed it. */
  onLine: (line: string) => void;
  /** The stream is over, and why. Never called for a stop we asked for. */
  onEnd: (reason: string) => void;
}

/** Starts one machine's loop and hands back the way to stop it. A seam, for tests. */
export type StartMemory = (lane: MemoryLaneRef, handlers: MemoryHandlers) => () => void;

export interface MemoryStatus {
  laneId: string;
  label: string;
  /** True once the machine has sent a reading. */
  ok: boolean;
  /** Plain words. Never an address or a host name: this goes to the page. */
  message: string;
}

/**
 * Every picked machine's loop, and the samples they have sent.
 *
 * The sweep takes a mark before a race and asks for the peaks since that mark
 * after it. Samples are stamped as they ARRIVE, on this machine's clock, so two
 * machines whose own clocks disagree are still read over the same window.
 */
export class MemoryWatch {
  readonly #lanes: MemoryLaneRef[];
  readonly #now: () => number;
  readonly #stops = new Map<string, () => void>();
  readonly #samples = new Map<string, { at: number; reading: MemoryReading }[]>();
  readonly #ended = new Map<string, string>();
  readonly #unreadable = new Map<string, string>();
  #waiters: (() => void)[] = [];

  constructor(lanes: MemoryLaneRef[], start: StartMemory, now: () => number = () => performance.now()) {
    this.#lanes = lanes;
    this.#now = now;
    for (const lane of lanes) {
      this.#samples.set(lane.laneId, []);
      const read = memoryLineReader(
        (reading) => {
          this.#samples.get(lane.laneId)!.push({ at: this.#now(), reading });
          this.#wake();
        },
        (os) => {
          this.#unreadable.set(lane.laneId, os);
          this.#wake();
        },
      );
      let stop: () => void = () => {};
      try {
        stop = start(lane, {
          onLine: read,
          onEnd: (reason) => {
            this.#ended.set(lane.laneId, reason);
            this.#stops.delete(lane.laneId);
            this.#wake();
          },
        });
      } catch (err) {
        this.#ended.set(lane.laneId, err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!this.#ended.has(lane.laneId)) this.#stops.set(lane.laneId, stop);
      else stop();
    }
  }

  #wake(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  #settled(laneId: string): boolean {
    return this.#samples.get(laneId)!.length > 0 || this.#ended.has(laneId) || this.#unreadable.has(laneId);
  }

  /** Waits until every machine has either sent a reading or given up, or until the time is up. */
  async ready(timeoutMs = 8000): Promise<MemoryStatus[]> {
    const deadline = Date.now() + timeoutMs;
    while (!this.#lanes.every((l) => this.#settled(l.laneId))) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.status();
  }

  status(): MemoryStatus[] {
    return this.#lanes.map(({ laneId, label }) => {
      const count = this.#samples.get(laneId)!.length;
      if (count > 0) {
        const p = peakOf([this.#samples.get(laneId)!.at(-1)!.reading])!;
        return { laneId, label, ok: true, message: `Memory sampling is on for ${label}: ${peakText(p)} in use now.` };
      }
      const ended = this.#ended.get(laneId);
      const os = this.#unreadable.get(laneId);
      const why = ended !== undefined
        ? ended
        : os !== undefined
          ? os === "Linux" || os === "Darwin"
            ? "its memory report was not in a form this tool reads"
            : `it runs ${os || "an operating system"} this tool does not read memory from (Linux and macOS only)`
          : "it has not answered yet";
      return { laneId, label, ok: false, message: `No memory reading from ${label}: ${why}. Its memory columns will be blank; the sweep is not affected.` };
    });
  }

  /** A mark to hand back to `peaksSince` once the race is over. */
  mark(): number {
    return this.#now();
  }

  /** Each machine's peak over the samples that arrived since the mark. Null where there were none. */
  peaksSince(mark: number): Record<string, MemoryPeak | null> {
    const out: Record<string, MemoryPeak | null> = {};
    for (const { laneId } of this.#lanes) {
      const window = this.#samples.get(laneId)!.filter((s) => s.at >= mark).map((s) => s.reading);
      out[laneId] = peakOf(window);
    }
    return out;
  }

  /** Stops every loop. Safe to call twice. */
  stop(): void {
    const stops = [...this.#stops.values()];
    this.#stops.clear();
    for (const stop of stops) {
      try {
        stop();
      } catch {
        /* a child that is already gone is the outcome we wanted anyway */
      }
    }
  }
}

// ------------------------------------------------------------------ the ssh

/** Where one machine's loop runs: over ssh, or on this machine. */
export type MemoryTarget = { kind: "local" } | { kind: "ssh"; target: SshTarget };

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Where a lane's machine is. The host comes from the lane's own address, as it
 * does for `bun run lanes`; a lane's `ssh` block can name a different host, a
 * user or a port.
 */
export function memoryTargetFor(lane: Pick<LaneConfig, "baseUrl" | "ssh">): MemoryTarget {
  const url = new URL(lane.baseUrl);
  const ssh = lane.ssh ?? {};
  if (ssh.host === undefined && isLoopback(url.hostname)) return { kind: "local" };
  const target: SshTarget = { host: ssh.host ?? url.hostname, binDir: "~", port: 0 };
  if (ssh.user !== undefined) target.user = ssh.user;
  if (ssh.sshPort !== undefined) target.sshPort = ssh.sshPort;
  return { kind: "ssh", target };
}

/**
 * Why an ssh ended, in words that carry no address. ssh's own message names the
 * host, and what this returns is shown on the page, which is never sent one.
 */
export function plainSshReason(code: number | null, stderr: string): string {
  const text = stderr.toLowerCase();
  if (/permission denied|no more authentication methods|too many authentication failures/.test(text)) {
    return "ssh could not sign in to it (this machine's key is not accepted there)";
  }
  if (/timed out|timeout/.test(text)) return "ssh timed out reaching it (it may be asleep or off the network)";
  if (/could not resolve|name or service not known|nodename nor servname/.test(text)) return "its host name did not resolve";
  if (/connection refused/.test(text)) return "it refused the ssh connection (Remote Login may be off)";
  if (/host key verification failed|remote host identification has changed/.test(text)) return "its ssh host key is not the one this machine remembers";
  if (/no route to host|network is unreachable/.test(text)) return "there is no network route to it";
  if (code === 127 || /command not found|not recognized/.test(text)) return "it has no `sh` to run the sampler with";
  return `the sampler stopped (exit ${code ?? "unknown"})`;
}

/** One machine's loop, line by line. The only part of this file that starts a process. */
export function startMemoryStream(
  where: MemoryTarget,
  handlers: MemoryHandlers,
  opts: { intervalSec?: number; maxSec?: number; connectTimeoutSec?: number } = {},
): () => void {
  const argv =
    where.kind === "local"
      ? ["sh", "-s"]
      : sshArgs(where.target, "sh -s", opts.connectTimeoutSec ?? MEMORY_CONNECT_TIMEOUT_SEC);
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

  let asked = false;
  let ended = false;
  const end = (reason: string) => {
    if (ended || asked) return;
    ended = true;
    handlers.onEnd(reason);
  };

  try {
    proc.stdin.write(memoryScript(opts.intervalSec, opts.maxSec));
    proc.stdin.end();
  } catch {
    /* the process is already gone; its exit below says why */
  }

  let why = "";
  void (async () => {
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        why = `${why}${new TextDecoder().decode(chunk)}`.slice(-600);
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
        if (buffer.length > 1_000_000) buffer = "";
      }
    } catch {
      /* the stream ended under us; the exit code below says what happened */
    }
    const code = await proc.exited;
    end(plainSshReason(code, why));
  })();

  return () => {
    asked = true;
    proc.kill();
  };
}

/** A watch over the picked lanes of a race config, with real processes. */
export function watchMemory(lanes: Pick<LaneConfig, "label" | "baseUrl" | "ssh">[], laneIds: string[]): MemoryWatch {
  const byId = new Map(lanes.map((lane, i) => [`lane-${i}`, lane]));
  const picked = laneIds.filter((id) => byId.has(id)).map((laneId) => ({ laneId, label: byId.get(laneId)!.label }));
  return new MemoryWatch(picked, (ref, handlers) => {
    let where: MemoryTarget;
    try {
      where = memoryTargetFor(byId.get(ref.laneId)!);
    } catch {
      throw new Error("its address or ssh settings could not be read");
    }
    try {
      return startMemoryStream(where, handlers);
    } catch {
      // sshArgs refuses a host or user with characters a remote shell could act on.
      throw new Error("its ssh settings contain characters that are not allowed (letters, digits and _ . / ~ - only)");
    }
  });
}

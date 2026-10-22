/**
 * Reaching a lane that may be asleep.
 *
 * A Mac set to sleep after a minute is not reachable by ssh while it sleeps:
 * the first attempt dies with "Operation timed out" after the TCP connect gets
 * no answer. Wake on network access is on, so a ping wakes the machine and a
 * retry a few seconds later works -- but the first attempt has already failed,
 * and on camera that failure looks like a broken tool rather than a sleeping
 * computer.
 *
 * So every managed operation's FIRST contact with a lane comes through here: a
 * probe, and on a failure that looks like sleep, a ping and another go, up to
 * four attempts over about thirty seconds, saying plainly what it is doing.
 *
 * What it must not do is retry a real fault. A wrong key, a wrong user, a host
 * that does not resolve: none of those get better by waiting, and retrying
 * them turns a five-second "your key is not authorised" into a half-minute of
 * false hope. Those fail on the first attempt with the error ssh gave.
 */

import { assertRemoteSafe } from "./config.ts";
import { runRemote } from "./ssh.ts";
import type { RemoteResult, RemoteRunner } from "./ssh.ts";
import type { SshTarget } from "./types.ts";

/** Attempts in total, including the first. Four over roughly 30 seconds. */
export const REACH_ATTEMPTS = 4;
/** How long to wait after a ping before trying ssh again. */
export const REACH_WAIT_MS = 4000;
/**
 * How long one probe may take before it counts as no answer.
 *
 * A machine on the same network answers in a tenth of a second when it is
 * awake, so anything beyond a few seconds is a machine that is not there. The
 * connect timeout does the real work -- without it ssh sits on a sleeping host
 * for the best part of a minute and four tries take a minute and a half.
 */
export const REACH_PROBE_TIMEOUT_MS = 8000;
export const REACH_CONNECT_TIMEOUT_SEC = 5;

/**
 * The ping, as an argument array: two packets, two seconds of patience.
 *
 * Waking the machine is the whole job -- the reply is not interesting, and a
 * machine that never replies to ping may still answer ssh once it is awake.
 */
export function pingArgs(host: string): string[] {
  assertRemoteSafe(host, "ping host");
  return ["ping", "-c", "2", "-t", "1", host];
}

/** Sends the wake-up packets. Whether they were answered does not matter. */
export type Pinger = (host: string) => Promise<void>;

export const pingHost: Pinger = async (host) => {
  const proc = Bun.spawn(pingArgs(host), { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 5000);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
};

const ASLEEP_SIGNS = [
  "operation timed out",
  "connection timed out",
  "connection refused",
  "no route to host",
  "host is down",
  "network is unreachable",
  "timed out after",
];

const REAL_FAULT_SIGNS = [
  "permission denied",
  "publickey",
  "host key verification failed",
  "could not resolve hostname",
  "name or service not known",
  "no such host",
  "remote host identification has changed",
  "too many authentication failures",
];

/**
 * Whether a failure is the kind a sleeping machine produces.
 *
 * Read in this order on purpose: a machine whose key is wrong AND whose
 * connection timed out is still a key problem, and the key problem is the one
 * worth printing.
 */
export function looksAsleep(result: RemoteResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  if (REAL_FAULT_SIGNS.some((sign) => text.includes(sign))) return false;
  return ASLEEP_SIGNS.some((sign) => text.includes(sign));
}

/** Whether a failure is one that waiting cannot fix. */
export function isRealFault(result: RemoteResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return REAL_FAULT_SIGNS.some((sign) => text.includes(sign));
}

/** What to say while waking a machine. The caller puts the lane name on it. */
export function wakingLine(attempt: number, attempts: number): string {
  return `not answering yet, it may be asleep; waking it, try ${attempt} of ${attempts}`;
}

/** What to say when it never woke. It names what a person can do about it. */
export function unreachableLine(host: string, attempts: number, lastError: string, seconds: number): string {
  return (
    `could not reach ${host} after ${attempts} tries over ${Math.round(seconds)} seconds. ` +
    `If that Mac is asleep, press a key on it, or turn automatic sleep off in System Settings > Energy while it is a lane. ` +
    `If it is awake, check Remote Login is on in System Settings > General > Sharing and that your key is authorised. ` +
    `ssh said: ${lastError.trim().slice(0, 200) || "nothing"}`
  );
}

export interface ReachOptions {
  run?: RemoteRunner;
  ping?: Pinger;
  attempts?: number;
  waitMs?: number;
  probeTimeoutMs?: number;
  /** One plain line per retry. The caller adds the lane's name. */
  log?: (message: string) => void;
  /** Test seam, so a test does not sit through the real wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReachResult {
  ok: boolean;
  /** How many probes were made, including the one that worked. */
  attempts: number;
  /** True when a ping was sent, which means the machine was probably asleep. */
  wokeIt: boolean;
  /** Empty when it answered. */
  detail: string;
}

/**
 * Gets a lane answering, waking it if that is what it takes.
 *
 * The probe is `echo READY`: the cheapest thing that proves ssh works end to
 * end, rather than that a TCP port is open.
 */
export async function reachLane(target: SshTarget, opts: ReachOptions = {}): Promise<ReachResult> {
  const run = opts.run ?? runRemote;
  const ping = opts.ping ?? pingHost;
  const attempts = opts.attempts ?? REACH_ATTEMPTS;
  const waitMs = opts.waitMs ?? REACH_WAIT_MS;
  const pause = opts.sleep ?? ((ms: number) => Bun.sleep(ms));

  let wokeIt = false;
  let last: RemoteResult = { ok: false, code: null, stdout: "", stderr: "" };
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await run(target, "echo READY", {
      timeoutMs: opts.probeTimeoutMs ?? REACH_PROBE_TIMEOUT_MS,
      connectTimeoutSec: REACH_CONNECT_TIMEOUT_SEC,
    });
    if (last.ok && last.stdout.includes("READY")) {
      return { ok: true, attempts: attempt, wokeIt, detail: "" };
    }

    // A key or a hostname does not get better by waiting, and pretending it
    // might costs half a minute before saying the thing that was true at once.
    if (isRealFault(last)) {
      return {
        ok: false,
        attempts: attempt,
        wokeIt,
        detail: `ssh to this lane failed: ${(last.stderr || last.stdout).trim().slice(0, 200)}`,
      };
    }

    if (attempt === attempts) break;

    if (looksAsleep(last)) {
      opts.log?.(wakingLine(attempt + 1, attempts));
      wokeIt = true;
      await ping(target.host).catch(() => undefined);
      await pause(waitMs);
      continue;
    }

    // Something else went wrong. Worth one more go -- a single dropped packet
    // should not end a two-hour run -- but not worth pinging over.
    opts.log?.(`no answer yet; trying again, try ${attempt + 1} of ${attempts}`);
    await pause(waitMs);
  }

  return {
    ok: false,
    attempts,
    wokeIt,
    detail: unreachableLine(target.host, attempts, last.stderr || last.stdout, (Date.now() - startedAt) / 1000),
  };
}

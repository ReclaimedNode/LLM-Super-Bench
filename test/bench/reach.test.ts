/**
 * Reaching a lane that may be asleep.
 *
 * A Mac set to sleep after a minute refuses the first ssh of the day with
 * "Operation timed out", and a ping wakes it. That is a machine being asleep,
 * not a fault, and the tool should say so and try again rather than stopping
 * on camera.
 *
 * The line this draws is the interesting part: sleep-shaped failures are
 * retried, and failures that waiting cannot fix -- a key, a user, a hostname
 * -- are not. Retrying those would turn an immediate, accurate "your key is
 * not authorised" into half a minute of false hope and then the same message.
 */

import { describe, expect, test } from "bun:test";
import {
  REACH_ATTEMPTS,
  REACH_PROBE_TIMEOUT_MS,
  isRealFault,
  looksAsleep,
  pingArgs,
  reachLane,
  unreachableLine,
  wakingLine,
} from "../../src/bench/reach.ts";
import type { RemoteResult } from "../../src/bench/ssh.ts";
import type { SshTarget } from "../../src/bench/types.ts";

const TARGET: SshTarget = { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 };

const READY: RemoteResult = { ok: true, code: 0, stdout: "READY\n", stderr: "" };
const ASLEEP: RemoteResult = {
  ok: false,
  code: 255,
  stdout: "",
  stderr: "ssh: connect to host box.local port 22: Operation timed out",
};
const NO_KEY: RemoteResult = {
  ok: false,
  code: 255,
  stdout: "",
  stderr: "someone@box.local: Permission denied (publickey).",
};
const NO_HOST: RemoteResult = {
  ok: false,
  code: 255,
  stdout: "",
  stderr: "ssh: Could not resolve hostname box.locl: nodename nor servname provided",
};

/** A machine that answers after N failed probes, and counts the pings. */
function machine(answers: RemoteResult[]) {
  const probes: string[] = [];
  const pings: string[] = [];
  const waits: number[] = [];
  return {
    probes,
    pings,
    waits,
    run: async (_t: unknown, command: string): Promise<RemoteResult> => {
      probes.push(command);
      return answers[Math.min(probes.length - 1, answers.length - 1)]!;
    },
    ping: async (host: string) => void pings.push(host),
    sleep: async (ms: number) => void waits.push(ms),
  };
}

// ------------------------------------------------------------------ the ping

describe("the ping", () => {
  test("is an argument array, never a shell string, and the host is checked", () => {
    expect(pingArgs("192.0.2.1")).toEqual(["ping", "-c", "2", "-t", "1", "192.0.2.1"]);
    // The same strict validator the ssh calls use: no shell metacharacters get
    // near a spawn, even one that never sees a shell.
    expect(() => pingArgs("192.0.2.1; rm -rf /")).toThrow();
    expect(() => pingArgs("$(whoami)")).toThrow();
  });
});

// ------------------------------------------------------------------ telling them apart

describe("what a failure means", () => {
  test("a timeout, a refusal and no route all look like sleep", () => {
    for (const stderr of [
      "ssh: connect to host box port 22: Operation timed out",
      "ssh: connect to host box port 22: Connection refused",
      "ssh: connect to host box port 22: No route to host",
      "[timed out after 15000ms]",
    ]) {
      expect(looksAsleep({ ok: false, code: 255, stdout: "", stderr })).toBe(true);
    }
  });

  test("a key, a changed host key and an unknown hostname are real faults", () => {
    for (const result of [NO_KEY, NO_HOST]) {
      expect(isRealFault(result)).toBe(true);
      expect(looksAsleep(result)).toBe(false);
    }
    expect(isRealFault({ ok: false, code: 255, stdout: "", stderr: "REMOTE HOST IDENTIFICATION HAS CHANGED!" })).toBe(true);
  });

  test("a real fault wins over a timeout in the same message", () => {
    const both = { ok: false, code: 255, stdout: "", stderr: "Permission denied (publickey).\nOperation timed out" };
    expect(looksAsleep(both)).toBe(false);
    expect(isRealFault(both)).toBe(true);
  });
});

// ------------------------------------------------------------------ reaching

describe("reaching a lane", () => {
  test("a machine that is awake is not pinged at all", async () => {
    const m = machine([READY]);
    const result = await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep });

    expect(result).toEqual({ ok: true, attempts: 1, wokeIt: false, detail: "" });
    expect(m.probes).toEqual(["echo READY"]);
    expect(m.pings).toEqual([]);
    expect(m.waits).toEqual([]);
  });

  test("asleep on the first try, awake on the second: one ping, one line, and it carries on", async () => {
    const m = machine([ASLEEP, READY]);
    const lines: string[] = [];

    const result = await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep, log: (l) => lines.push(l) });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.wokeIt).toBe(true);
    expect(m.pings).toEqual(["box.local"]);
    // One line, said once, in plain words.
    expect(lines).toEqual(["not answering yet, it may be asleep; waking it, try 2 of 4"]);
    // And it waited before trying again, rather than hammering it.
    expect(m.waits).toHaveLength(1);
  });

  test("a machine that never wakes gives up after the last try and says what to do", async () => {
    const m = machine([ASLEEP]);
    const lines: string[] = [];

    const result = await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep, log: (l) => lines.push(l) });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(REACH_ATTEMPTS);
    expect(m.probes).toHaveLength(REACH_ATTEMPTS);
    // A ping before each retry, not after the last failure.
    expect(m.pings).toHaveLength(REACH_ATTEMPTS - 1);
    expect(lines).toEqual([
      "not answering yet, it may be asleep; waking it, try 2 of 4",
      "not answering yet, it may be asleep; waking it, try 3 of 4",
      "not answering yet, it may be asleep; waking it, try 4 of 4",
    ]);

    // The message is for a person standing near the machine.
    expect(result.detail).toContain("box.local");
    expect(result.detail).toContain("press a key on it");
    expect(result.detail).toContain("System Settings");
    expect(result.detail).toContain("Remote Login");
    expect(result.detail).toContain("Operation timed out");
  });

  test("a key that is not authorised fails at once, with the real error", async () => {
    const m = machine([NO_KEY]);
    const lines: string[] = [];

    const result = await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep, log: (l) => lines.push(l) });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.wokeIt).toBe(false);
    // Not retried, not pinged, not slept on: waiting cannot fix a key.
    expect(m.probes).toHaveLength(1);
    expect(m.pings).toEqual([]);
    expect(m.waits).toEqual([]);
    expect(lines).toEqual([]);
    expect(result.detail).toContain("Permission denied");
    expect(result.detail).not.toContain("asleep");
  });

  test("a hostname that does not resolve fails at once too", async () => {
    const m = machine([NO_HOST]);
    const result = await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep });
    expect(result.attempts).toBe(1);
    expect(m.pings).toEqual([]);
    expect(result.detail).toContain("Could not resolve hostname");
  });

  test("the whole thing is over in about thirty seconds", async () => {
    const m = machine([ASLEEP]);
    await reachLane(TARGET, { run: m.run, ping: m.ping, sleep: m.sleep });
    // Three waits between four tries, and each probe gives up quickly, so the
    // worst case is about half a minute rather than a minute and a half.
    const total = m.waits.reduce((sum, ms) => sum + ms, 0) + REACH_ATTEMPTS * REACH_PROBE_TIMEOUT_MS;
    expect(total).toBeLessThanOrEqual(45_000);
  });

  test("the lines carry no lane name, because every caller already prints one", () => {
    expect(wakingLine(2, 4)).not.toMatch(/lane|Studio/i);
    expect(unreachableLine("box.local", 4, "Operation timed out", 31)).toContain("box.local");
    // The duration is the real elapsed time, not a sum of the waits: it said
    // "about 12 seconds" for a live run that took 35.
    expect(unreachableLine("box.local", 4, "x", 31)).toContain("over 31 seconds");
  });
});

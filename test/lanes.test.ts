/**
 * Starting and stopping the race's model servers.
 *
 * All of it against a fake ssh layer and a fake endpoint, because the cases
 * worth proving are the ones that are hard to arrange on real hardware: a
 * server that starts but serves the wrong model, an endpoint that never
 * answers, a stop that has to hit two exact pids on two machines.
 *
 * The property that matters most: everything started is stopped BY PID. These
 * machines run other things -- one of them is a node in a cluster -- so a
 * pattern match like `pkill -f mlx_lm.server` would be a way to take down
 * somebody else's work. No test here may ever see one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BIN_DIR,
  LANE_MODELS,
  LANE_MODELS_ROOT,
  LANE_MODEL_ORDER,
  LanesError,
  bringLanesUp,
  laneModelFor,
  laneModelPath,
  lanesStatus,
  laneLogFile,
  readLanesState,
  takeLanesDown,
  targetsFromRaceConfig,
  withServedModels,
  servedModelId,
} from "../src/lanes.ts";
import type { LaneModel, LaneTargets, LanesState, ModelLister } from "../src/lanes.ts";
import { THINKING_OFF_ARGS, startServerCommand } from "../src/bench/ssh.ts";
import type { RemoteResult } from "../src/bench/ssh.ts";
import { preflightLane } from "../src/preflight.ts";
import { runRace } from "../src/race.ts";
import type { RaceConfig } from "../src/types.ts";

const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });

const statePaths: string[] = [];
function freshStatePath(): string {
  const path = join(tmpdir(), `lanes-test-${process.pid}-${Date.now()}-${statePaths.length}.json`);
  statePaths.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(statePaths.splice(0).map((p) => rm(p, { force: true })));
});

/** Two machines that answer ssh, and remember every command. */
class FakeMachines {
  commands: { host: string; command: string }[] = [];
  livePids = new Set<number>();
  nextPid = 1000;
  sleepMinutes = 1;
  /** A host named here refuses to start a server. */
  refuseStart: string | null = null;
  /** How many reach probes time out before the machine answers. */
  asleepUntil = 0;
  probes = 0;

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push({ host: target.host, command });

    if (command === "echo READY") {
      return this.asleepUntil > 0 && this.probes++ < this.asleepUntil
        ? { ok: false, code: 255, stdout: "", stderr: `ssh: connect to host ${target.host} port 22: Operation timed out` }
        : ok("READY\n");
    }

    if (command.includes("caffeinate")) {
      const pid = this.nextPid++;
      this.livePids.add(pid);
      return ok(`AWAKE_PID:${pid}\n`);
    }
    if (command.includes("pmset")) return ok(` sleep   ${this.sleepMinutes}\n`);
    if (command.includes("mlx_lm.server")) {
      if (this.refuseStart === target.host) return { ok: false, code: 1, stdout: "", stderr: "no such file" };
      const pid = this.nextPid++;
      this.livePids.add(pid);
      return ok(`PID:${pid}\n`);
    }
    const killed = /^kill (\d+) /.exec(command);
    if (killed) {
      this.livePids.delete(Number(killed[1]));
      return ok("STOPPED\n");
    }
    if (command.includes("kill -0")) return ok(this.livePids.size > 0 ? "ALIVE\n" : "GONE\n");
    return ok("");
  };

  all(): string[] {
    return this.commands.map((c) => c.command);
  }
  forHost(host: string): string[] {
    return this.commands.filter((c) => c.host === host).map((c) => c.command);
  }
  usedPkill(): boolean {
    return this.all().some((c) => c.includes("pkill") || c.includes("killall"));
  }
}

const RACE_CONFIG = {
  port: 9500,
  maxTokens: 512,
  lanes: [
    { label: "First", baseUrl: "http://192.0.2.1:8090", model: "/home/x/models/Some-Model-4bit" },
    { label: "Second", baseUrl: "http://192.0.2.2:8090", model: "/home/x/bench-models/Some-Model-4bit" },
  ],
};

function targets(): LaneTargets {
  return targetsFromRaceConfig(RACE_CONFIG);
}

/** An endpoint that serves the right thing after a few polls. */
function listerServing(ids: Record<string, string[]>, readyAfter = 0): ModelLister {
  let calls = 0;
  return async (baseUrl) => {
    calls += 1;
    if (calls <= readyAfter) return null;
    const host = new URL(baseUrl).hostname;
    return ids[host] ?? null;
  };
}

// ------------------------------------------------------------------ the config

describe("reading the machines out of a race config", () => {
  test("host and port come from the lane's own baseUrl", () => {
    const { lanes } = targets();
    expect(lanes.map((l) => l.target.host)).toEqual(["192.0.2.1", "192.0.2.2"]);
    expect(lanes.map((l) => l.target.port)).toEqual([8090, 8090]);
    expect(lanes.map((l) => l.target.binDir)).toEqual([DEFAULT_BIN_DIR, DEFAULT_BIN_DIR]);
    // The model is carried through exactly: it is what the endpoint must list.
    expect(lanes[0]!.model).toBe("/home/x/models/Some-Model-4bit");
  });

  test("a lane on this Mac is named and skipped, not started over ssh", () => {
    const { lanes, local } = targetsFromRaceConfig({
      lanes: [
        { label: "Mock", baseUrl: "http://localhost:9001", model: "mock-model" },
        { label: "Real", baseUrl: "http://192.0.2.1:8090", model: "m" },
      ],
    });
    expect(local).toEqual(["Mock"]);
    expect(lanes.map((l) => l.label)).toEqual(["Real"]);
  });

  test("a lane may override the binaries, the user and the ssh port", () => {
    const { lanes } = targetsFromRaceConfig({
      lanes: [
        {
          label: "Odd one",
          baseUrl: "http://192.0.2.3:8091",
          model: "m",
          ssh: { binDir: "~/other/bin", user: "someone", sshPort: 2222 },
        },
      ],
    });
    expect(lanes[0]!.target).toEqual({ host: "192.0.2.3", binDir: "~/other/bin", port: 8091, user: "someone", sshPort: 2222 });
  });

  test("a config with no lanes, or a lane with no URL, says so rather than half-working", () => {
    expect(() => targetsFromRaceConfig({ lanes: [] })).toThrow(LanesError);
    expect(() => targetsFromRaceConfig({ lanes: [{ label: "Bad", baseUrl: "not a url", model: "m" }] })).toThrow(/not a URL/);
    expect(() => targetsFromRaceConfig({ lanes: [{ label: "Bad", baseUrl: "http://x:1" }] })).toThrow(/needs a baseUrl and a model/);
  });
});

// ------------------------------------------------------------------ up

describe("bringing the lanes up", () => {
  test("each server binds every interface, with the prompt cache and thinking off, and a log", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();

    await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
      }),
      statePath,
      pollMs: 1,
    });

    const start = machines.all().find((c) => c.includes("mlx_lm.server"))!;
    expect(start).toContain("--host '0.0.0.0'");
    expect(start).toContain("--port '8090'");
    expect(start).toContain("--prompt-cache-size '0'");
    expect(start).toContain('"enable_thinking":false');
    expect(start).toContain(laneLogFile(8090));
    expect(start).toContain("nohup");
    // Started from the lane's own binaries, not whatever is on the PATH.
    expect(start).toContain("bench-envs/llm/bin/mlx_lm.server");
  });

  test("both machines are held awake, and both pids are written down", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();

    const report = await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
      }),
      statePath,
      pollMs: 1,
    });

    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(machines.all().filter((c) => c.includes("caffeinate"))).toHaveLength(2);

    const state = (await readLanesState(statePath))!;
    expect(state.lanes.map((l) => l.label)).toEqual(["First", "Second"]);
    for (const lane of state.lanes) {
      expect(lane.serverPid).toBeGreaterThan(0);
      expect(lane.awakePid).toBeGreaterThan(0);
      expect(lane.serverPid).not.toBe(lane.awakePid);
      expect(lane.logFile).toBe(laneLogFile(8090));
    }
    // Four live processes: a server and a hold on each machine.
    expect(machines.livePids.size).toBe(4);
  });

  test("a lane is not up until the endpoint lists the exact model the race will ask for", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();

    // The second machine serves something else entirely.
    const report = await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/A-Different-Model"],
      }),
      statePath,
      pollMs: 1,
      readyTimeoutMs: 30,
    });

    const second = report.results.find((r) => r.label === "Second")!;
    expect(second.ok).toBe(false);
    expect(second.detail).toContain("never listed");
    expect(second.detail).toContain("A-Different-Model");

    // It was stopped again, server and hold, by pid: a half-started machine is
    // how a later run inherits a mystery.
    expect(machines.usedPkill()).toBe(false);
    const secondHost = machines.forHost("192.0.2.2");
    expect(secondHost.filter((c) => c.startsWith("kill ")).length).toBe(2);
    expect(machines.livePids.size).toBe(2); // only the first machine's pair

    // And the state file holds the lane that IS up, so it can still be stopped.
    const state = (await readLanesState(statePath))!;
    expect(state.lanes.map((l) => l.label)).toEqual(["First"]);
  });

  test("a server that never starts leaves nothing behind", async () => {
    const machines = new FakeMachines();
    machines.refuseStart = "192.0.2.2";
    const statePath = freshStatePath();

    const report = await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({ "192.0.2.1": ["/home/x/models/Some-Model-4bit"] }),
      statePath,
      pollMs: 1,
      readyTimeoutMs: 30,
    });

    expect(report.results.find((r) => r.label === "Second")!.detail).toContain("no pid came back");
    // The hold it took first was let go.
    expect(machines.forHost("192.0.2.2").filter((c) => c.startsWith("kill ")).length).toBe(1);
  });

  test("an endpoint that never answers names the log to read", async () => {
    const machines = new FakeMachines();
    const report = await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: async () => null,
      statePath: freshStatePath(),
      pollMs: 1,
      readyTimeoutMs: 30,
    });
    expect(report.results.every((r) => !r.ok)).toBe(true);
    expect(report.results[0]!.detail).toContain(laneLogFile(8090));
  });

  test("it refuses to start a second set on top of one already recorded", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();
    const list = listerServing({
      "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
      "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
    });

    await bringLanesUp({ targets: targets(), run: machines.run, list, statePath, pollMs: 1 });
    const again = bringLanesUp({ targets: targets(), run: machines.run, list, statePath, pollMs: 1 });
    await expect(again).rejects.toThrow(/already recorded as up/);
  });

  test("the one-minute machine is called out before anything is started", async () => {
    const machines = new FakeMachines();
    const lines: string[] = [];
    await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
      }),
      statePath: freshStatePath(),
      pollMs: 1,
      log: (m) => lines.push(m),
    });
    expect(lines.join("\n")).toContain("set to sleep after 1 minute");
    expect(lines.join("\n")).toContain("holding this machine awake");
  });
});

// ------------------------------------------------------------------ down

describe("taking the lanes down", () => {
  async function upThenState(machines: FakeMachines, statePath: string) {
    await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
      }),
      statePath,
      pollMs: 1,
    });
    return (await readLanesState(statePath))!;
  }

  test("exactly the four pids it started, and never a pattern", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();
    const state = await upThenState(machines, statePath);
    const started = state.lanes.flatMap((l) => [l.serverPid, l.awakePid!]);

    // Somebody else's process on the same machine, which must survive.
    machines.livePids.add(52415);

    const results = await takeLanesDown({ run: machines.run, statePath });

    expect(results.every((r) => r.serverStopped && r.awakeStopped)).toBe(true);
    expect(machines.usedPkill()).toBe(false);
    for (const pid of started) {
      expect(machines.all().some((c) => c.startsWith(`kill ${pid} `))).toBe(true);
      expect(machines.livePids.has(pid)).toBe(false);
    }
    expect(machines.livePids.has(52415)).toBe(true);

    // The record is gone, so the next `up` is not blocked by a stale file.
    expect(await readLanesState(statePath)).toBeNull();
  });

  test("each pid is stopped on the machine it was started on", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();
    const state = await upThenState(machines, statePath);
    machines.commands.length = 0;

    await takeLanesDown({ run: machines.run, statePath });

    for (const lane of state.lanes) {
      const host = lane.host;
      expect(machines.forHost(host).some((c) => c.startsWith(`kill ${lane.serverPid} `))).toBe(true);
      // and not on the other machine
      const other = host === "192.0.2.1" ? "192.0.2.2" : "192.0.2.1";
      expect(machines.forHost(other).some((c) => c.startsWith(`kill ${lane.serverPid} `))).toBe(false);
    }
  });

  test("a stop that cannot be confirmed keeps the record rather than forgetting it", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();
    await upThenState(machines, statePath);

    const stubborn = async (target: { host: string }, command: string) => {
      if (/^kill \d+ /.test(command)) return ok("STILL_RUNNING\n");
      return machines.run(target, command);
    };

    const results = await takeLanesDown({ run: stubborn, statePath });
    expect(results.every((r) => !r.serverStopped)).toBe(true);
    expect(await readLanesState(statePath)).not.toBeNull();
  });

  test("with nothing recorded it says so, and does not go hunting", async () => {
    const machines = new FakeMachines();
    const failing = takeLanesDown({ run: machines.run, statePath: freshStatePath() });
    await expect(failing).rejects.toThrow(/Nothing to stop/);
    expect(machines.all()).toEqual([]);
  });
});

// ------------------------------------------------------------------ status

describe("status", () => {
  test("says what is running and whether it is serving what the race asks for", async () => {
    const machines = new FakeMachines();
    const statePath = freshStatePath();
    await bringLanesUp({
      targets: targets(),
      run: machines.run,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
      }),
      statePath,
      pollMs: 1,
    });

    const rows = await lanesStatus({
      run: machines.run,
      statePath,
      list: listerServing({
        "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
        "192.0.2.2": ["something-else"],
      }),
    });

    expect(rows.map((r) => r.running)).toEqual([true, true]);
    expect(rows.map((r) => r.ready)).toEqual([true, false]);
    expect(rows[1]!.serving).toEqual(["something-else"]);
  });
});


// ------------------------------------------------------------------ --model

/**
 * Starting the lanes on a model named on the command line.
 *
 * The thing worth proving is that the flag changes exactly one thing. With it,
 * every lane starts the same named model and the record says so. Without it,
 * the command that reaches the machine is the one the config has always
 * produced, character for character -- because this flag exists to be used on
 * camera, and a flag that quietly moves something else is worse than no flag.
 */
describe("starting the lanes on a named model", () => {
  /** The start command a given model id produces. Neither lane's differs by host. */
  function expectedStart(modelId: string): string {
    return startServerCommand({
      target: { host: "192.0.2.1", binDir: DEFAULT_BIN_DIR, port: 8090 },
      modelId,
      promptCacheSize: 0,
      chatTemplateArgs: THINKING_OFF_ARGS,
      logFile: laneLogFile(8090),
    });
  }

  function startCommandFor(machines: FakeMachines, host: string): string {
    return machines.forHost(host).find((c) => c.includes("mlx_lm.server"))!;
  }

  async function up(model: LaneModel | null, serving: Record<string, string[]>, statePath: string) {
    const machines = new FakeMachines();
    const report = await bringLanesUp({
      targets: targetsFromRaceConfig(RACE_CONFIG, model),
      run: machines.run,
      list: listerServing(serving),
      statePath,
      pollMs: 1,
    });
    return { machines, report };
  }

  const CONFIG_SERVING = {
    "192.0.2.1": ["/home/x/models/Some-Model-4bit"],
    "192.0.2.2": ["/home/x/bench-models/Some-Model-4bit"],
  };

  test("every key names a folder under the one models root, with a name for the screen", () => {
    expect(LANE_MODEL_ORDER).toEqual(["14b", "27b", "31b", "122b", "35b"]);
    expect(LANE_MODEL_ORDER.map((k) => LANE_MODELS[k].dir)).toEqual([
      "Qwen3-14B-4bit",
      "Qwen3.8-27B-4bit",
      "gemma-4-31b-it-bf16",
      "Qwen3.5-122B-A10B-4bit",
      "Qwen3.6-35B-A3B-4bit",
    ]);
    expect(LANE_MODEL_ORDER.map((k) => LANE_MODELS[k].displayModel)).toEqual([
      "Qwen3 14B 4-bit",
      "Qwen3.8 27B 4-bit",
      "Gemma 4 31B 16-bit",
      "Qwen3.5 122B-A10B 4-bit",
      "Qwen3.6 35B-A3B 4-bit",
    ]);

    for (const key of LANE_MODEL_ORDER) {
      const model = laneModelFor(key);
      expect(model.key).toBe(key);
      // A folder name, so one key is the same weights on every machine.
      expect(model.dir).not.toContain("/");
      expect(laneModelPath(model)).toBe(`${LANE_MODELS_ROOT}/${model.dir}`);
      // Absolute, because that is what the endpoint lists and preflight compares.
      expect(laneModelPath(model).startsWith("/")).toBe(true);
    }
  });

  test("a key it does not know is refused, and the refusal names all five", () => {
    for (const bad of ["70b", "14", "qwen3", "toString"]) {
      expect(() => laneModelFor(bad)).toThrow(LanesError);
      expect(() => laneModelFor(bad)).toThrow(/14b, 27b, 31b, 122b, 35b/);
    }
    expect(() => laneModelFor("70b")).toThrow(/I do not know the model "70b"/);
  });

  test("--model with nothing after it is refused the same way, naming the five", () => {
    expect(() => laneModelFor(undefined)).toThrow(/--model needs one of these after it/);
    expect(() => laneModelFor(undefined)).toThrow(/14b, 27b, 31b, 122b, 35b/);
    expect(() => laneModelFor("   ")).toThrow(/--model needs one of these after it/);
  });

  test("the key is read the way a person types it", () => {
    expect(laneModelFor("14B").key).toBe("14b");
    expect(laneModelFor(" 122b ").key).toBe("122b");
  });

  test("with --model, every lane's server command carries that model's path", async () => {
    const statePath = freshStatePath();
    const path14 = laneModelPath(LANE_MODELS["14b"]);
    const { machines, report } = await up(LANE_MODELS["14b"], { "192.0.2.1": [path14], "192.0.2.2": [path14] }, statePath);

    expect(report.results.every((r) => r.ok)).toBe(true);
    // Both machines were started on the same weights: that is the whole point.
    expect(startCommandFor(machines, "192.0.2.1")).toBe(expectedStart(path14));
    expect(startCommandFor(machines, "192.0.2.2")).toBe(expectedStart(path14));
    expect(startCommandFor(machines, "192.0.2.1")).toContain("Qwen3-14B-4bit");
  });

  test("without the flag the command is byte for byte the one the config asks for", async () => {
    const statePath = freshStatePath();
    const { machines, report } = await up(null, CONFIG_SERVING, statePath);

    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(startCommandFor(machines, "192.0.2.1")).toBe(expectedStart("/home/x/models/Some-Model-4bit"));
    expect(startCommandFor(machines, "192.0.2.2")).toBe(expectedStart("/home/x/bench-models/Some-Model-4bit"));
  });

  test("the record says what was started, what to call it, and which key it came from", async () => {
    const statePath = freshStatePath();
    const path14 = laneModelPath(LANE_MODELS["14b"]);
    await up(LANE_MODELS["14b"], { "192.0.2.1": [path14], "192.0.2.2": [path14] }, statePath);

    const state = (await readLanesState(statePath))!;
    expect(state.lanes.map((l) => l.model)).toEqual([path14, path14]);
    expect(state.lanes.map((l) => l.displayModel)).toEqual(["Qwen3 14B 4-bit", "Qwen3 14B 4-bit"]);
    expect(state.lanes.map((l) => l.modelKey)).toEqual(["14b", "14b"]);
  });

  test("without the flag the record matches the config exactly", async () => {
    const statePath = freshStatePath();
    await up(null, CONFIG_SERVING, statePath);

    const state = (await readLanesState(statePath))!;
    expect(state.lanes.map((l) => l.model)).toEqual([
      "/home/x/models/Some-Model-4bit",
      "/home/x/bench-models/Some-Model-4bit",
    ]);
    // No key, because nothing overrode the config.
    expect(state.lanes.map((l) => l.modelKey)).toEqual([null, null]);
    // And the screen name is the config's default: the last path segment.
    expect(state.lanes.map((l) => l.displayModel)).toEqual(["Some-Model-4bit", "Some-Model-4bit"]);
  });

  test("a config that names its own displayModel keeps it, until --model replaces it", () => {
    const named = {
      lanes: [{ label: "First", baseUrl: "http://192.0.2.1:8090", model: "/m/Thing-4bit", displayModel: "Thing 4-bit" }],
    };
    expect(targetsFromRaceConfig(named).lanes[0]!.displayModel).toBe("Thing 4-bit");
    const overridden = targetsFromRaceConfig(named, LANE_MODELS["31b"]).lanes[0]!;
    expect(overridden.displayModel).toBe("Gemma 4 31B 16-bit");
    expect(overridden.model).toBe(laneModelPath(LANE_MODELS["31b"]));
    expect(overridden.modelKey).toBe("31b");
  });

  test("status prints the model each lane was started on", async () => {
    const statePath = freshStatePath();
    const path14 = laneModelPath(LANE_MODELS["14b"]);
    const { machines } = await up(LANE_MODELS["14b"], { "192.0.2.1": [path14], "192.0.2.2": [path14] }, statePath);

    const rows = await lanesStatus({
      run: machines.run,
      statePath,
      list: listerServing({ "192.0.2.1": [path14], "192.0.2.2": ["something-else"] }),
    });
    expect(rows.map((r) => r.model)).toEqual([path14, path14]);
    expect(rows.map((r) => r.displayModel)).toEqual(["Qwen3 14B 4-bit", "Qwen3 14B 4-bit"]);
    expect(rows.map((r) => r.ready)).toEqual([true, false]);
  });

  test("down clears the record, so the next page load falls back to the config", async () => {
    const statePath = freshStatePath();
    const path14 = laneModelPath(LANE_MODELS["14b"]);
    const { machines } = await up(LANE_MODELS["14b"], { "192.0.2.1": [path14], "192.0.2.2": [path14] }, statePath);

    const config = raceConfig();
    expect(withServedModels(config, await readLanesState(statePath)).lanes.map((l) => l.displayModel)).toEqual([
      "Qwen3 14B 4-bit",
      "Qwen3 14B 4-bit",
    ]);

    await takeLanesDown({ run: machines.run, statePath });
    expect(await readLanesState(statePath)).toBeNull();
    expect(withServedModels(config, await readLanesState(statePath))).toEqual(config);
  });
});

// ------------------------------------------------------------------ what is served

/** A race config shaped like the one the page and the race are handed. */
function raceConfig(): RaceConfig {
  return {
    port: 9500,
    maxTokens: 512,
    temperature: 0,
    charsPerToken: 4,
    promptFile: "prompts/sample.txt",
    requestTimeoutMs: 180_000,
    preflightTimeoutMs: 30_000,
    lanes: [
      {
        label: "First",
        baseUrl: "http://192.0.2.1:8090",
        model: "/home/x/models/Some-Model-4bit",
        displayModel: "Some Model 4-bit",
      },
      {
        label: "Second",
        baseUrl: "http://192.0.2.2:8090",
        model: "/home/x/bench-models/Some-Model-4bit",
        displayModel: "Some Model 4-bit",
      },
    ],
  };
}

/** A record of lanes recorded as up, without going near a machine to make one. */
function stateFor(entries: { label: string; model: string; displayModel: string }[]): LanesState {
  return {
    startedAt: "2026-09-21T00:00:00.000Z",
    lanes: entries.map((entry, i) => ({
      label: entry.label,
      host: `192.0.2.${i + 1}`,
      port: 8090,
      model: entry.model,
      displayModel: entry.displayModel,
      modelKey: null,
      serverPid: 1000 + i,
      awakePid: 2000 + i,
      logFile: laneLogFile(8090),
      startedAt: "2026-09-21T00:00:00.000Z",
    })),
  };
}

/** An endpoint that lists exactly these ids and streams one word. */
function endpointServing(ids: string[], asked: string[] = []): typeof fetch {
  const stream = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  return (async (input: unknown, init?: { body?: unknown }) => {
    if (String(input).endsWith("/v1/models")) {
      return new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }));
    }
    asked.push((JSON.parse(String(init?.body)) as { model: string }).model);
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

describe("the model the page and the race read", () => {
  const path14 = laneModelPath(LANE_MODELS["14b"]);

  function servedBoth(): RaceConfig {
    return withServedModels(
      raceConfig(),
      stateFor([
        { label: "First", model: path14, displayModel: "Qwen3 14B 4-bit" },
        { label: "Second", model: path14, displayModel: "Qwen3 14B 4-bit" },
      ]),
    );
  }

  test("the record wins over the config, lane by lane", () => {
    const served = servedBoth();
    expect(served.lanes.map((l) => l.model)).toEqual([path14, path14]);
    expect(served.lanes.map((l) => l.displayModel)).toEqual(["Qwen3 14B 4-bit", "Qwen3 14B 4-bit"]);
    // Everything else about the lane is left alone.
    expect(served.lanes.map((l) => l.baseUrl)).toEqual(["http://192.0.2.1:8090", "http://192.0.2.2:8090"]);
    expect(served.maxTokens).toBe(512);
  });

  test("with nothing recorded, every lane is the config's", () => {
    const config = raceConfig();
    expect(withServedModels(config, null)).toEqual(config);
    expect(withServedModels(config, { startedAt: "x", lanes: [] })).toEqual(config);
  });

  test("a lane with no record of its own keeps the config's model", () => {
    const served = withServedModels(
      raceConfig(),
      stateFor([{ label: "Second", model: path14, displayModel: "Qwen3 14B 4-bit" }]),
    );
    expect(served.lanes[0]!.model).toBe("/home/x/models/Some-Model-4bit");
    expect(served.lanes[0]!.displayModel).toBe("Some Model 4-bit");
    expect(served.lanes[1]!.model).toBe(path14);
  });

  test("a record written before display names existed still names its model", () => {
    const state = stateFor([{ label: "First", model: path14, displayModel: "Qwen3 14B 4-bit" }]);
    delete (state.lanes[0]! as { displayModel?: string }).displayModel;
    expect(withServedModels(raceConfig(), state).lanes[0]!.displayModel).toBe("Qwen3-14B-4bit");
  });

  test("preflight checks the served model, not the config's", async () => {
    const config = raceConfig();
    const served = servedBoth();
    // An endpoint that has ONLY what was started. The config's id is not on it.
    const fetchImpl = endpointServing([path14]);

    const byConfig = await preflightLane({ lane: config.lanes[0]!, timeoutMs: 1000, fetchImpl, skipUsageProbe: true });
    expect(byConfig.ok).toBe(false);
    expect(byConfig.message).toContain("does not have the configured model");

    const byServed = await preflightLane({ lane: served.lanes[0]!, timeoutMs: 1000, fetchImpl, skipUsageProbe: true });
    expect(byServed.ok).toBe(true);
  });

  test("the race asks each endpoint for the served model, not the config's", async () => {
    const asked: string[] = [];
    await runRace({
      config: servedBoth(),
      preset: "short",
      sourceText: "the quick brown fox. ".repeat(50),
      emit: () => {},
      logPath: null,
      skipUsageProbe: true,
      tickMs: 50,
      fetchImpl: endpointServing([path14], asked),
    });
    expect(asked).toEqual([path14, path14]);
  });
});

describe("servedModelId", () => {
  test("exact id wins", () => {
    expect(servedModelId(["/a/Qwen3-14B-4bit", "/b/Qwen3-14B-4bit"], "/b/Qwen3-14B-4bit")).toBe("/b/Qwen3-14B-4bit");
  });
  test("a symlink resolved into LM Studio's folder matches by folder name", () => {
    const ids = ["Qwen/Qwen3.5-4B-Base", "/home/x/.lmstudio/models/mlx-community/Qwen3-14B-4bit"];
    expect(servedModelId(ids, "/home/x/bench-models/Qwen3-14B-4bit")).toBe(ids[1]);
  });
  test("a symlink resolved into an org--name cache matches through the mlx-community-- prefix", () => {
    const ids = ["/home/x/.cache/models/mlx-community--gemma-4-31b-it-bf16"];
    expect(servedModelId(ids, "/home/x/bench-models/gemma-4-31b-it-bf16")).toBe(ids[0]);
  });
  test("a different model is not served", () => {
    expect(servedModelId(["/home/x/.cache/models/mlx-community--Qwen3.6-35B-A3B-4bit"], "/home/x/bench-models/Qwen3-14B-4bit")).toBeUndefined();
  });
});

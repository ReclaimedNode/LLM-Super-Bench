/**
 * Keeping a borrowed machine awake for the length of an operation.
 *
 * The bug this prevents is invisible while it happens: a freshly set up Mac
 * can be set to sleep after ONE minute, and neither an open ssh session nor a
 * running download counts as activity, so the machine drops off the network
 * partway through and every symptom points at the network instead. There is no
 * way to reproduce that on demand against real hardware, so all of this runs
 * against the fake ssh layer, where a machine can be made to answer any way at
 * all.
 *
 * Two properties matter more than the rest and are asserted everywhere:
 * exactly the pid we started is stopped (never a pattern match -- `pkill -f
 * caffeinate` on a shared machine would stop somebody else's hold), and the
 * hold is let go on every way out, including a failure and an interrupt.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { rm } from "node:fs/promises";
import {
  HOLD_MARGIN_SECONDS,
  MAX_HOLD_SECONDS,
  caffeinateCommand,
  checkSleep,
  holdAwake,
  parseAwakePid,
  parseSleepSetting,
  sleepSettingCommand,
  sleepWarning,
  whileAwake,
} from "../../src/bench/awake.ts";
import { validateBenchConfig } from "../../src/bench/config.ts";
import { DEFAULT_IMAGE_SETTINGS, imageSettingsFrom, planImageGrid } from "../../src/bench/image.ts";
import { runImageGrid } from "../../src/bench/imagerunner.ts";
import { holdPassAwake } from "../../src/bench/power.ts";
import { runGrid } from "../../src/bench/runner.ts";
import { planLaneSetup, runLaneSetup } from "../../src/bench/setup.ts";
import { startMockLane } from "../../src/mock.ts";
import { DEFAULT_VIDEO_SETTINGS, planVideoGrid } from "../../src/bench/video.ts";
import { runVideoGrid } from "../../src/bench/videocli.ts";
import { runDir } from "../../src/bench/store.ts";
import type { RemoteResult } from "../../src/bench/ssh.ts";
import type { SshTarget } from "../../src/bench/types.ts";

const TARGET: SshTarget = { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 };

const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });

/**
 * A machine that answers caffeinate and pmset, and remembers every command.
 *
 * `livePids` is the point of it: a hold that is never released leaves a pid
 * behind, which is what a test for "did you clean up" has to be able to see.
 */
class FakeMachine {
  commands: string[] = [];
  livePids = new Set<number>();
  sleepMinutes: number | null = 1;
  nextPid = 4242;
  caffeinatePrints: string | null = null;
  unreachable = false;

  run = async (target: unknown, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    if (this.unreachable) return { ok: false, code: 255, stdout: "", stderr: "no route to host" };
    return this.answer(target, command);
  };

  /** Overridable, unlike the arrow above. */
  async answer(_target: unknown, command: string): Promise<RemoteResult> {
    if (command === "echo READY") return ok("READY\n");
    if (command.includes("caffeinate")) {
      if (this.caffeinatePrints !== null) return ok(this.caffeinatePrints);
      const pid = this.nextPid++;
      this.livePids.add(pid);
      return ok(`AWAKE_PID:${pid}\n`);
    }
    if (command.includes("pmset")) {
      if (this.sleepMinutes === null) return ok("NO_PMSET\n");
      return ok(` sleep                    ${this.sleepMinutes}\n`);
    }
    const killed = /^kill (\d+) /.exec(command);
    if (killed) {
      this.livePids.delete(Number(killed[1]));
      return ok("STOPPED\n");
    }
    return ok("");
  }

  /** The one command shape that must never appear, on any machine, ever. */
  usedPkill(): boolean {
    return this.commands.some((c) => c.includes("pkill"));
  }

  caffeinates(): string[] {
    return this.commands.filter((c) => c.includes("caffeinate"));
  }
}

// ------------------------------------------------------------------ the command

describe("the caffeinate command", () => {
  test("holds display, idle, disk, system and user, and expires on its own", () => {
    const command = caffeinateCommand(600);
    expect(command).toContain("caffeinate -dimsu");
    // -t is the safety net: a runner that dies without cleaning up cannot
    // leave a borrowed machine awake indefinitely.
    expect(command).toContain("-t 600");
    expect(command).toContain("AWAKE_PID:$!");
    // Backgrounded and detached, or the ssh call would never return.
    expect(command).toContain("nohup");
    expect(command).toMatch(/&\s*echo/);
    // No sudo, and nothing that changes the machine's own settings.
    expect(command).not.toContain("sudo");
    expect(command).not.toContain("pmset -a");
    expect(command).not.toContain("systemsetup");
  });

  test("a silly request is clamped, in both directions", () => {
    expect(caffeinateCommand(5)).toContain("-t 60");
    expect(caffeinateCommand(MAX_HOLD_SECONDS * 10)).toContain(`-t ${MAX_HOLD_SECONDS}`);
    expect(caffeinateCommand(1800.6)).toContain("-t 1801");
  });

  test("the pid comes back out, and nothing else passes for one", () => {
    expect(parseAwakePid("AWAKE_PID:8123\n")).toBe(8123);
    expect(parseAwakePid("some warning\nAWAKE_PID:8123\n")).toBe(8123);
    expect(parseAwakePid("")).toBeNull();
    expect(parseAwakePid("AWAKE_PID:\n")).toBeNull();
    expect(parseAwakePid("caffeinate: command not found\n")).toBeNull();
    // pid 1 is launchd. Stopping it would be memorable.
    expect(parseAwakePid("AWAKE_PID:1\n")).toBeNull();
    expect(parseAwakePid("AWAKE_PID:0\n")).toBeNull();
  });
});

// ------------------------------------------------------------------ reading the setting

describe("reading the sleep setting", () => {
  test("the command is a read, and survives a machine without pmset", () => {
    const command = sleepSettingCommand();
    expect(command).toContain("pmset -g");
    expect(command).not.toContain("pmset -a");
    expect(command).not.toContain("sudo");
    expect(command).toContain("NO_PMSET");
  });

  test("minutes are read out of real pmset output", () => {
    const real = [
      "System-wide power settings:",
      "Currently in use:",
      " standbydelayhigh     86400",
      " sleep                1",
      " hibernatemode        3",
      " displaysleep         10",
    ].join("\n");
    expect(parseSleepSetting(real).minutes).toBe(1);
    // displaysleep must not be mistaken for sleep.
    expect(parseSleepSetting(real).minutes).not.toBe(10);
    expect(parseSleepSetting(" sleep                0\n").minutes).toBe(0);
    expect(parseSleepSetting("NO_PMSET\n").minutes).toBeNull();
  });

  test("a machine already being held awake says so", () => {
    const held = " sleep                1 (sleep prevented by caffeinate)\n";
    expect(parseSleepSetting(held).prevented).toBe(true);
    expect(parseSleepSetting(" sleep                0\n").prevented).toBe(false);
  });
});

describe("the warning", () => {
  test("says nothing when the machine never sleeps", () => {
    expect(sleepWarning({ minutes: 0, prevented: false })).toBeNull();
  });

  test("names the number of minutes and what it looks like when it bites", () => {
    const warning = sleepWarning({ minutes: 1, prevented: false });
    // No lane label in the message itself: a caller that already prints one
    // would say it twice, which is what it used to do on the image runner.
    expect(warning).not.toContain("Studio");
    expect(warning).toContain("1 minute");
    expect(warning).not.toContain("1 minutes");
    expect(warning).toContain("network fault");
    // And that we deal with it ourselves rather than asking for a settings change.
    expect(warning).toContain("caffeinate");
    expect(sleepWarning({ minutes: 20, prevented: false })).toContain("20 minutes");
  });

  test("an unreadable setting warns rather than assuming the best", () => {
    expect(sleepWarning({ minutes: null, prevented: false })).toContain("could not read");
  });

  test("checkSleep reads the machine, and an unreachable one still warns", async () => {
    const machine = new FakeMachine();
    machine.sleepMinutes = 0;
    expect((await checkSleep(TARGET, machine.run)).warning).toBeNull();

    machine.sleepMinutes = 1;
    expect((await checkSleep(TARGET, machine.run)).warning).toContain("1 minute");

    const thrown = async () => {
      throw new Error("ssh: connect to host box.local port 22: Operation timed out");
    };
    expect((await checkSleep(TARGET, thrown)).warning).toContain("could not read");
  });
});

// ------------------------------------------------------------------ holding

describe("holding a machine awake", () => {
  test("the hold outlives the work it was asked to cover", async () => {
    const machine = new FakeMachine();
    await holdAwake({ target: TARGET, seconds: 600, run: machine.run });
    expect(machine.caffeinates()[0]).toContain(`-t ${600 + HOLD_MARGIN_SECONDS}`);
  });

  test("exactly the pid we started is stopped, and never a pattern", async () => {
    const machine = new FakeMachine();
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: machine.run });

    expect(hold.pid).toBe(4242);
    expect(machine.livePids.has(4242)).toBe(true);
    expect(hold.note).toContain("4242");
    expect(hold.note).not.toContain("Studio");

    await hold.release();
    expect(machine.livePids.size).toBe(0);
    expect(machine.commands.some((c) => c.startsWith("kill 4242 "))).toBe(true);
    expect(machine.usedPkill()).toBe(false);
    expect(machine.commands.some((c) => c.includes("killall"))).toBe(false);
  });

  test("releasing twice stops it once", async () => {
    const machine = new FakeMachine();
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: machine.run });
    await hold.release();
    await hold.release();
    expect(machine.commands.filter((c) => c.startsWith("kill ")).length).toBe(1);
  });

  test("somebody else's caffeinate is left alone", async () => {
    const machine = new FakeMachine();
    machine.livePids.add(999); // a hold somebody else started
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: machine.run });
    await hold.release();
    expect(machine.livePids.has(999)).toBe(true);
  });

  test("a machine that cannot be held awake says so and does not fail the work", async () => {
    const machine = new FakeMachine();
    machine.caffeinatePrints = "sh: caffeinate: command not found\n";
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: machine.run });
    expect(hold.pid).toBeNull();
    expect(hold.note).toContain("may sleep mid-run");
    // Releasing a hold that was never taken must not try to stop anything.
    await hold.release();
    expect(machine.commands.some((c) => c.startsWith("kill "))).toBe(false);
  });

  test("ssh falling over is a note, not an exception", async () => {
    const thrown = async () => {
      throw new Error("no route to host");
    };
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: thrown });
    expect(hold.pid).toBeNull();
    expect(hold.note).toContain("no route to host");
    await hold.release();
  });

  test("a dry run touches nothing", async () => {
    const machine = new FakeMachine();
    const hold = await holdAwake({ target: TARGET, seconds: 60, run: machine.run, dryRun: true });
    expect(hold.pid).toBeNull();
    expect(machine.commands).toEqual([]);
  });
});

// ------------------------------------------------------------------ around the work

describe("whileAwake", () => {
  test("holds first, works, then lets go", async () => {
    const machine = new FakeMachine();
    const order: string[] = [];

    const result = await whileAwake({ target: TARGET, seconds: 60, run: machine.run }, async () => {
      order.push("work");
      expect(machine.livePids.size).toBe(1); // held while the work runs
      return "done";
    });

    expect(result).toBe("done");
    expect(order).toEqual(["work"]);
    expect(machine.livePids.size).toBe(0);
    const kinds = machine.commands.map((c) => (c.includes("caffeinate") ? "hold" : c.startsWith("kill ") ? "release" : "other"));
    expect(kinds).toEqual(["hold", "release"]);
  });

  test("lets go when the work throws, and the failure still reaches the caller", async () => {
    const machine = new FakeMachine();
    const failing = whileAwake({ target: TARGET, seconds: 60, run: machine.run }, async () => {
      throw new Error("out of memory");
    });
    await expect(failing).rejects.toThrow("out of memory");
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);
  });

  test("lets go when the run is interrupted", async () => {
    const machine = new FakeMachine();
    let release: () => void = () => {};
    const stuck = new Promise<void>((r) => (release = r));

    const running = whileAwake({ target: TARGET, seconds: 60, run: machine.run }, async () => {
      // Ctrl-C arrives in the middle of a long cell.
      process.emit("SIGINT");
      await stuck;
    });

    // The hold is dropped on the signal, without waiting for the work.
    await Bun.sleep(5);
    expect(machine.livePids.size).toBe(0);

    release();
    await running;
    expect(machine.commands.filter((c) => c.startsWith("kill ")).length).toBe(1);
  });

  test("the signal handlers do not pile up run after run", async () => {
    const machine = new FakeMachine();
    const before = process.listenerCount("SIGINT");
    for (let i = 0; i < 5; i++) {
      await whileAwake({ target: TARGET, seconds: 60, run: machine.run }, async () => {});
    }
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test("the work still runs when the machine cannot be held awake", async () => {
    const machine = new FakeMachine();
    machine.caffeinatePrints = "sh: caffeinate: command not found\n";
    const notes: string[] = [];
    const ran = await whileAwake(
      { target: TARGET, seconds: 60, run: machine.run, log: (m) => notes.push(m) },
      async () => "ran anyway",
    );
    expect(ran).toBe("ran anyway");
    expect(notes.join(" ")).toContain("may sleep mid-run");
  });
});

// ------------------------------------------------------------------ the operations that use it

describe("setting a lane up", () => {
  function setupConfig() {
    return validateBenchConfig({
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [{ name: "Small", dir: "Small-4bit", hfRepo: "vendor/Small-4bit", approxGb: 8 }],
      lanes: [{ label: "Studio", baseUrl: "http://box.local:8090", ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 } }],
    });
  }

  /** The setup machine: answers enough to get through, and can be made to fail. */
  class FakeSetupMachine extends FakeMachine {
    failEverything = false;

    async answer(target: unknown, command: string): Promise<RemoteResult> {
      if (command.includes("caffeinate") || command.includes("pmset") || /^kill \d+ /.test(command)) {
        return super.answer(target, command);
      }
      if (command === "echo READY") return ok("READY\n");
      if (this.failEverything) return { ok: false, code: 1, stdout: "", stderr: "disk full" };
      if (command.includes("UV_MISSING")) return ok("uv 0.9.9\n");
      if (command.includes("ENV_MISSING")) return ok("ENV_PRESENT\n");
      if (command.includes("uv pip list")) return ok("mlx==0.32.2\nmlx-lm==0.31.3\n");
      if (command.includes("MODEL_MISSING")) return ok("MODEL_PRESENT 3\n");
      if (command.includes("FREE_KB")) return ok(`FREE_KB ${900 * 1024 * 1024}\n`);
      if (command.includes('echo "UV ')) return ok("UV uv 0.9.9\n");
      return ok("");
    }
  }

  test("a setup holds the machine awake from the moment it answers until it is done", async () => {
    const machine = new FakeSetupMachine();
    const config = setupConfig();
    const plan = planLaneSetup(config, "Studio");
    const notes: string[] = [];

    await runLaneSetup({ plan, run: machine.run, onStep: (s) => notes.push(`${s.what}: ${s.detail}`) });

    // Held, and let go.
    expect(machine.caffeinates()).toHaveLength(1);
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);

    // The one-minute machine is called out in the steps, in words.
    expect(notes.join("\n")).toContain("set to sleep after 1 minute");

    // And the hold starts only after the machine has answered -- a download
    // that begins before the hold is a download that can be cut off.
    const first = machine.commands.indexOf("echo READY");
    const held = machine.commands.findIndex((c) => c.includes("caffeinate"));
    const worked = machine.commands.findIndex((c) => c.includes("bench-models"));
    expect(first).toBeLessThan(held);
    expect(held).toBeLessThan(worked);
  });

  test("an unreachable lane fails on ssh, without trailing a caffeinate", async () => {
    const machine = new FakeSetupMachine();
    machine.unreachable = true;
    const config = setupConfig();
    const plan = planLaneSetup(config, "Studio");

    const pinged: string[] = [];
    const report = await runLaneSetup({
      plan,
      run: machine.run,
      ping: async (host) => void pinged.push(host),
      sleep: async () => {},
    });

    expect(report.ok).toBe(false);
    expect(machine.caffeinates()).toHaveLength(0);
    // Four probes, because a machine that does not answer might be asleep, and
    // a ping before each retry.
    expect(machine.commands).toEqual(["echo READY", "echo READY", "echo READY", "echo READY"]);
    expect(pinged).toEqual(["box.local", "box.local", "box.local"]);
  });

  test("a setup that falls over still lets the machine go", async () => {
    const machine = new FakeSetupMachine();
    machine.failEverything = true;
    const config = setupConfig();
    const plan = planLaneSetup(config, "Studio");

    const report = await runLaneSetup({ plan, run: machine.run });

    expect(report.ok).toBe(false);
    expect(machine.caffeinates()).toHaveLength(1);
    expect(machine.livePids.size).toBe(0);
  });

  test("a dry run does not caffeinate a machine it is not going to touch", async () => {
    const machine = new FakeSetupMachine();
    const config = setupConfig();
    const plan = planLaneSetup(config, "Studio");

    await runLaneSetup({ plan, run: machine.run, dryRun: true });

    expect(machine.caffeinates()).toHaveLength(0);
    // It still reads the setting, because a plan is where the warning belongs.
    expect(machine.commands.some((c) => c.includes("pmset"))).toBe(true);
  });
});

describe("the image grid", () => {
  const runNames: string[] = [];
  afterEach(async () => {
    await Promise.all(runNames.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
  });

  /** The image machine, plus the caffeinate and pmset answers. */
  class FakeImageMachine extends FakeMachine {
    async answer(target: unknown, command: string): Promise<RemoteResult> {
      if (command.includes("caffeinate") || command.includes("pmset") || /^kill \d+ /.test(command)) {
        return super.answer(target, command);
      }
      if (command === "echo READY") return ok("READY\n");
      if (command.includes("mflux_bench.py")) {
        const lines = [
          JSON.stringify({ event: "versions", mflux: "0.19.2", mlx: "0.32.2" }),
          JSON.stringify({ event: "loaded", seconds: 0.5 }),
          JSON.stringify({ event: "image", index: 0, warmup: true, seconds: 7, path: "/tmp/a.png", sha256: "aa" }),
          JSON.stringify({ event: "image", index: 1, warmup: false, seconds: 7, path: "/tmp/b.png", sha256: "aa" }),
          JSON.stringify({ event: "done", peak_memory_gb: 22.5 }),
        ];
        return ok(lines.join("\n") + "\n");
      }
      return ok("");
    }

    sendShim = async (): Promise<RemoteResult> => ok("SHIM_WRITTEN\n");
    fetchFile = async (): Promise<Uint8Array | null> => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }

  test("an image run holds the machine awake for its cells and lets go after", async () => {
    const machine = new FakeImageMachine();
    const config = validateBenchConfig({
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [
        { name: "FLUX.2 klein 4B", dir: "FLUX.2-klein-4B", kind: "image", hfRepo: "black-forest-labs/FLUX.2-klein-4B", approxGb: 12 },
      ],
      lanes: [{ label: "Studio", baseUrl: "http://box.local:8090", ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 } }],
    });
    const settings = imageSettingsFrom(config, { ...DEFAULT_IMAGE_SETTINGS, measuredImages: 1, warmupImages: 1, restSeconds: 0 });
    const runName = `awaketest-${process.pid}-${Date.now()}`;
    runNames.push(runName);

    await runImageGrid({
      runName,
      plan: planImageGrid(config, settings),
      emit: () => {},
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
      force: true,
    });

    expect(machine.caffeinates()).toHaveLength(1);
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);
    // Held before the first image, released after the last.
    const held = machine.commands.findIndex((c) => c.includes("caffeinate"));
    const generated = machine.commands.findIndex((c) => c.includes("mflux_bench.py"));
    const let_go = machine.commands.findIndex((c) => c.startsWith("kill "));
    expect(held).toBeLessThan(generated);
    expect(generated).toBeLessThan(let_go);
  });
});

describe("the benchmark grid", () => {
  const servers: Server[] = [];
  const runNames: string[] = [];

  afterEach(async () => {
    for (const s of servers.splice(0)) s.stop(true);
    await Promise.all(runNames.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
  });

  /** A managed lane: a real mock endpoint over HTTP, a fake machine over ssh. */
  class FakeGridMachine extends FakeMachine {
    async answer(target: unknown, command: string): Promise<RemoteResult> {
      if (command.includes("caffeinate") || command.includes("pmset") || /^kill \d+ /.test(command)) {
        return super.answer(target, command);
      }
      if (command === "echo READY") return ok("READY\n");
      if (command.includes("mlx_lm.server")) return ok("PID:7777\n");
      return ok("");
    }
  }

  test("a managed lane is held awake for its whole share of the grid", async () => {
    const machine = new FakeGridMachine();
    const server = startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 40, includeUsage: true, charsPerToken: 4 });
    servers.push(server);
    const runName = `awakegrid-${process.pid}-${Date.now()}`;
    runNames.push(runName);

    const config = validateBenchConfig({
      outputCap: 20,
      measuredRuns: 1,
      warmupRuns: 1,
      restSeconds: 0,
      engineBenchmark: false,
      requestTimeoutMs: 30_000,
      serverStartTimeoutMs: 20_000,
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [{ name: "Mock model", id: "mock-model" }],
      lanes: [
        {
          label: "Studio",
          baseUrl: `http://localhost:${server.port}`,
          ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: server.port },
        },
      ],
    });

    const notes: string[] = [];
    await runGrid({
      config,
      runName,
      sourceText: "the quick brown fox jumps over the lazy dog. ".repeat(600),
      emit: (e) => {
        if (e.type === "note") notes.push(e.message);
      },
      run: machine.run as never,
    });

    // Held once for the lane, not once per cell, and let go at the end.
    expect(machine.caffeinates()).toHaveLength(1);
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);

    // The one-minute machine is called out where the run log will keep it.
    expect(notes.join("\n")).toContain("set to sleep after 1 minute");

    // Held before the model server was started, let go after it was stopped,
    // and the server's own pid is not the pid the hold stops.
    const held = machine.commands.findIndex((c) => c.includes("caffeinate"));
    const startedServer = machine.commands.findIndex((c) => c.includes("mlx_lm.server"));
    const kills = machine.commands.filter((c) => c.startsWith("kill "));
    expect(held).toBeLessThan(startedServer);
    expect(kills.some((c) => c.startsWith("kill 7777 "))).toBe(true);
    expect(kills.some((c) => c.startsWith("kill 4242 "))).toBe(true);
    expect(machine.commands.lastIndexOf(kills.at(-1)!)).toBeGreaterThan(startedServer);
  }, 60_000);
});

describe("the video grid", () => {
  const runNames: string[] = [];
  afterEach(async () => {
    await Promise.all(runNames.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
  });

  /** The video port's machine, plus the caffeinate and pmset answers. */
  class FakeVideoMachine extends FakeMachine {
    async answer(target: unknown, command: string): Promise<RemoteResult> {
      if (command.includes("caffeinate") || command.includes("pmset") || /^kill \d+ /.test(command)) {
        return super.answer(target, command);
      }
      if (command === "echo READY") return ok("READY\n");
      if (command.includes("git clone")) return ok("PORT_INSTALLED\n");
      if (command.includes("git rev-parse --short HEAD")) return ok("c952c8f\n");
      if (command.includes("ltx-2-mlx generate")) {
        return ok("Saved to: /home/x/bench-video/r/ltx-2.5-mlx-q8/clip_0.mp4\nTime: 84.3s\n");
      }
      return ok("");
    }
  }

  test("a video run holds the machine awake for its clips and lets go after", async () => {
    const machine = new FakeVideoMachine();
    const runName = `awakevid-${process.pid}-${Date.now()}`;
    runNames.push(runName);

    const config = validateBenchConfig({
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [
        { name: "LTX-2.5 q8", dir: "ltx-2.5-mlx-q8", kind: "video", hfRepo: "mlx-community/ltx-2.5-mlx-q8", approxGb: 24 },
      ],
      lanes: [{ label: "Studio", baseUrl: "http://box.local:8090", ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 } }],
    });

    const logs: string[] = [];
    await runVideoGrid({
      plan: planVideoGrid(config, { ...DEFAULT_VIDEO_SETTINGS, measuredClips: 1, restSeconds: 0 }),
      runName,
      log: (m) => logs.push(m),
      run: machine.run as never,
      fetchFile: (async () => new Uint8Array([0, 0, 0, 24])) as never,
    });

    expect(machine.caffeinates()).toHaveLength(1);
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);
    expect(logs.join("\n")).toContain("set to sleep after 1 minute");

    // Cloning the port can outlast a minute on its own, but the clips are the
    // long part, so the hold covers them and is let go afterwards.
    const held = machine.commands.findIndex((c) => c.includes("caffeinate"));
    const generated = machine.commands.findIndex((c) => c.includes("ltx-2-mlx generate"));
    const let_go = machine.commands.findIndex((c) => c.startsWith("kill "));
    expect(held).toBeLessThan(generated);
    expect(generated).toBeLessThan(let_go);
  }, 30_000);
});

describe("the power pass", () => {
  const lanes = validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [{ name: "Small", dir: "Small-4bit", hfRepo: "vendor/Small-4bit", approxGb: 8 }],
    lanes: [
      { label: "Studio", baseUrl: "http://box.local:8090", ssh: { host: "box.local", binDir: "~/bench-envs/llm/bin", port: 8090 } },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
  }).lanes;

  const jobs = [
    { lane: lanes[0]!, model: null, kind: "idle" },
    { lane: lanes[0]!, model: { name: "Small", id: "~/bench-models/Small-4bit" }, kind: "load" },
    { lane: lanes[1]!, model: null, kind: "idle" },
  ] as never;

  test("each managed lane is held once for the whole pass, and let go at the end", async () => {
    const machine = new FakeMachine();
    const logs: string[] = [];

    const held = await holdPassAwake(jobs, { run: machine.run, log: (m) => logs.push(m), seconds: 600 });

    // One hold for the managed lane, and none for the lane nobody can ssh to.
    expect(machine.caffeinates()).toHaveLength(1);
    expect(held.holds).toHaveLength(1);
    expect(machine.livePids.size).toBe(1);

    // A reading taken with the display asleep would not be comparable to one
    // taken with it on, so the pass says out loud that it holds the display.
    expect(logs.join("\n")).toContain("display stays on");
    expect(logs.join("\n")).toContain("set to sleep after 1 minute");

    await held.release();
    expect(machine.livePids.size).toBe(0);
    expect(machine.usedPkill()).toBe(false);
  });

  test("a pass over machines that never sleep says nothing about sleep", async () => {
    const machine = new FakeMachine();
    machine.sleepMinutes = 0;
    const logs: string[] = [];
    const held = await holdPassAwake(jobs, { run: machine.run, log: (m) => logs.push(m), seconds: 600 });
    expect(logs.some((l) => l.startsWith("!"))).toBe(false);
    await held.release();
  });
});

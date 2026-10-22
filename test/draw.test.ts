/**
 * `bun run draw` -- the on-camera picture race.
 *
 * The parts worth proving here are the ones that are wrong silently: an
 * argument read the wrong way, a command that quotes a path badly and draws
 * nothing, a verdict line that overstates which Mac won, and a failure that
 * exits zero and tells a script everything was fine. All of those are
 * functions of their input, so none of them needs a Mac.
 *
 * The one end-to-end shape is driven against a fake machine, the same way the
 * image benchmark's tests are: two lanes, one of which falls over, because
 * that cannot be arranged on real hardware on demand and is exactly the case
 * that must not take the other lane down with it.
 */

import { describe, expect, test } from "bun:test";
import { validateBenchConfig } from "../src/bench/config.ts";
import {
  DRAW_MODELS,
  DRAW_SEED,
  DrawError,
  drawCommand,
  drawExitCode,
  drawLanes,
  laneReport,
  laneSlug,
  localDrawPath,
  openArgs,
  parseDrawArgs,
  remoteDrawDir,
  runDraw,
  verdictLine,
} from "../src/bench/draw.ts";
import type { DrawLaneResult } from "../src/bench/draw.ts";
import type { RemoteResult } from "../src/bench/ssh.ts";

// ------------------------------------------------------------------ fixtures

const STAMP = "20260920-183045";

function config() {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [{ name: "Text", dir: "Text-4bit", hfRepo: "vendor/Text-4bit" }],
    lanes: [
      {
        label: "M3 Ultra 512GB",
        baseUrl: "http://one.local:8090",
        ssh: { host: "one.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      {
        label: "M5 Ultra 256GB",
        baseUrl: "http://two.local:8090",
        ssh: { host: "two.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
  });
}

function result(over: Partial<DrawLaneResult> = {}): DrawLaneResult {
  return { label: "A", ok: true, loadSeconds: 12.8, drawSeconds: 2, localPath: "/tmp/a.png", error: null, ...over };
}

/** A machine that answers the way the timing shim answers. */
class FakeMachine {
  commands: string[] = [];
  fetched: string[] = [];
  written: string[] = [];
  /** Seconds per host, so one machine can be made faster than the other. */
  secondsByHost: Record<string, number> = {};
  /** Hosts that fall over instead of drawing. */
  failHosts: string[] = [];
  /** Hosts that never answer ssh at all. */
  unreachableHosts: string[] = [];

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (this.unreachableHosts.includes(target.host)) {
      return { ok: false, code: 255, stdout: "", stderr: "ssh: connect to host: Operation timed out" };
    }
    if (command === "echo READY") return ok("READY\n");

    if (command.includes("mflux_bench.py")) {
      if (this.failHosts.includes(target.host)) {
        return ok(JSON.stringify({ event: "error", message: "RuntimeError: out of memory" }) + "\n");
      }
      const seconds = this.secondsByHost[target.host] ?? 4;
      return ok(
        [
          JSON.stringify({ event: "versions", mflux: "0.19.2", mlx: "0.31.2" }),
          "Fetching weights: 100%|##########| 12/12",
          JSON.stringify({ event: "loaded", seconds: 31.5 }),
          JSON.stringify({
            event: "image",
            index: 0,
            warmup: false,
            seconds,
            path: `${remoteDrawDir(STAMP)}/img_0.png`,
            sha256: "abc123",
          }),
          JSON.stringify({ event: "done", peak_memory_gb: 41.2 }),
        ].join("\n") + "\n",
      );
    }
    return ok("");
  };

  sendShim = async (): Promise<RemoteResult> => ({ ok: true, code: 0, stdout: "SHIM_WRITTEN\n", stderr: "" });

  fetchFile = async (_t: unknown, path: string): Promise<Uint8Array | null> => {
    this.fetched.push(path);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  };

  write = async (path: string): Promise<void> => {
    this.written.push(path);
  };
}

// ------------------------------------------------------------------ arguments

describe("reading the command line", () => {
  test("the prompt is the first thing that is not a flag", () => {
    const args = parseDrawArgs(["a fox reading in a library"]);
    expect(args.prompt).toBe("a fox reading in a library");
    expect(args.help).toBe(false);
  });

  test("without a prompt it says what to type instead of drawing nothing", () => {
    expect(() => parseDrawArgs([])).toThrow(DrawError);
    expect(() => parseDrawArgs(["--model", "zimage"])).toThrow(/Tell me what to draw/);
  });

  test("an unquoted prompt is caught rather than silently drawing the first word", () => {
    expect(() => parseDrawArgs(["a", "fox"])).toThrow(/one pair of quotes/);
  });

  test("flux is the model unless another is named", () => {
    expect(parseDrawArgs(["a fox"]).model).toBe(DRAW_MODELS.flux);
    expect(parseDrawArgs(["a fox"]).model.dir).toBe("FLUX.2-klein-4B");
    expect(parseDrawArgs(["a fox"]).model.kind).toBe("flux2-klein");
  });

  test("zimage names the other model, however it is spelled", () => {
    for (const spelling of ["zimage", "Z-Image", "z-image-turbo"]) {
      const args = parseDrawArgs(["a fox", "--model", spelling]);
      expect(args.model.dir).toBe("Z-Image-Turbo");
      expect(args.model.kind).toBe("z-image-turbo");
    }
  });

  test("a model nobody has heard of is refused by name", () => {
    expect(() => parseDrawArgs(["a fox", "--model", "dalle"])).toThrow(/either flux or zimage/);
  });

  test("--lane can be given more than once and keeps the order", () => {
    const args = parseDrawArgs(["a fox", "--lane", "M5 Ultra 256GB", "--lane", "M3 Ultra 512GB"]);
    expect(args.lanes).toEqual(["M5 Ultra 256GB", "M3 Ultra 512GB"]);
  });

  test("no --lane means every lane", () => {
    expect(parseDrawArgs(["a fox"]).lanes).toEqual([]);
  });

  test("the seed is 42 unless it is given, and it must be a whole number", () => {
    expect(parseDrawArgs(["a fox"]).seed).toBe(DRAW_SEED);
    expect(parseDrawArgs(["a fox"]).seed).toBe(42);
    expect(parseDrawArgs(["a fox", "--seed", "7"]).seed).toBe(7);
    expect(() => parseDrawArgs(["a fox", "--seed", "banana"])).toThrow(/whole number/);
  });

  test("the pictures open unless --no-open says not to", () => {
    expect(parseDrawArgs(["a fox"]).open).toBe(true);
    expect(parseDrawArgs(["a fox", "--no-open"]).open).toBe(false);
  });

  test("--help needs no prompt, and an unknown option is named", () => {
    expect(parseDrawArgs(["--help"]).help).toBe(true);
    expect(parseDrawArgs(["-h"]).help).toBe(true);
    expect(() => parseDrawArgs(["a fox", "--fast"])).toThrow(/--fast/);
    expect(() => parseDrawArgs(["a fox", "--seed"])).toThrow(/needs a value/);
  });
});

// ------------------------------------------------------------------ the command

describe("what one machine is asked to run", () => {
  const command = drawCommand({ model: DRAW_MODELS.flux, prompt: "a fox reading in a library", seed: 42, stamp: STAMP });

  test("mflux's real flag names, one picture, no warm-up", () => {
    expect(command).toContain("--kind 'flux2-klein'");
    expect(command).toContain(`--model "$HOME"'/bench-models/FLUX.2-klein-4B'`);
    expect(command).toContain("--prompt 'a fox reading in a library'");
    expect(command).toContain("--seed '42'");
    expect(command).toContain("--width '1024'");
    expect(command).toContain("--height '1024'");
    expect(command).toContain("--count '1'");
    expect(command).toContain("--warmup '0'");
  });

  test("the image environment's python runs the shim that is already on the machine", () => {
    expect(command.startsWith(`"$HOME"'/bench-envs/image/bin/python' "$HOME"'/bench-envs/mflux_bench.py'`)).toBe(true);
  });

  test("the picture is written to this run's own folder, with the shim's placeholder intact", () => {
    expect(command).toContain(`--output "$HOME"'/bench-draw/${STAMP}/img_{i}.png'`);
  });

  test("no step count, so mflux uses its own default for that model", () => {
    expect(command).not.toContain("--steps");
  });

  test("the other model routes to the other mflux CLI", () => {
    const z = drawCommand({ model: DRAW_MODELS.zimage, prompt: "a fox", seed: 1, stamp: STAMP });
    expect(z).toContain("--kind 'z-image-turbo'");
    expect(z).toContain(`--model "$HOME"'/bench-models/Z-Image-Turbo'`);
    expect(z).toContain("--seed '1'");
  });

  test("a prompt with a quote in it cannot break out of the command", () => {
    const risky = drawCommand({
      model: DRAW_MODELS.flux,
      prompt: "it's a fox'; rm -rf ~",
      seed: 42,
      stamp: STAMP,
    });
    expect(risky).toContain(`--prompt 'it'\\''s a fox'\\''; rm -rf ~'`);
  });

  test("opening the pictures is an argument array, never a shell string", () => {
    expect(openArgs(["/tmp/a.png", "/tmp/b.png"])).toEqual(["open", "/tmp/a.png", "/tmp/b.png"]);
  });
});

// ------------------------------------------------------------------ names

describe("naming things", () => {
  test("a lane label becomes a file name a person can read", () => {
    expect(laneSlug("M5 Ultra 256GB")).toBe("m5-ultra-256gb");
    expect(laneSlug("M3 Ultra 512GB")).toBe("m3-ultra-512gb");
    expect(laneSlug("  Mac (studio) -- 2  ")).toBe("mac-studio-2");
    expect(laneSlug("!!!")).toBe("lane");
  });

  test("each lane's picture sits under this run's folder, named after the lane", () => {
    const path = localDrawPath(STAMP, "M5 Ultra 256GB");
    expect(path.endsWith(`results/draw/${STAMP}/m5-ultra-256gb.png`)).toBe(true);
  });

  test("the machine writes into a folder of its own, under the home directory", () => {
    expect(remoteDrawDir(STAMP)).toBe(`~/bench-draw/${STAMP}`);
  });
});

// ------------------------------------------------------------------ lanes

describe("choosing the machines", () => {
  test("every lane with a way in, and never a manual one", () => {
    expect(drawLanes(config()).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
  });

  test("--lane restricts to what was named, by label or by file name", () => {
    expect(drawLanes(config(), ["M5 Ultra 256GB"]).map((l) => l.lane.label)).toEqual(["M5 Ultra 256GB"]);
    expect(drawLanes(config(), ["m3-ultra-512gb"]).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB"]);
  });

  test("a lane nobody has is refused, and the real ones are listed", () => {
    expect(() => drawLanes(config(), ["M7 Ultra"])).toThrow(/M3 Ultra 512GB, M5 Ultra 256GB/);
  });
});

// ------------------------------------------------------------------ verdict

describe("the line that compares them", () => {
  test("fastest against slowest, the ratio to one decimal and the seconds to two", () => {
    const line = verdictLine([
      result({ label: "M3 Ultra 512GB", drawSeconds: 7 }),
      result({ label: "M5 Ultra 256GB", drawSeconds: 1.77 }),
    ]);
    // 7.00 / 1.77 is 3.95, which to one decimal is 4.0.
    expect(line).toBe("M5 Ultra 256GB drew it 4.0x faster than M3 Ultra 512GB (1.77 s against 7.00 s).");
  });

  test("two machines that are level are not dressed up as a win", () => {
    const line = verdictLine([
      result({ label: "A", drawSeconds: 1.77 }),
      result({ label: "B", drawSeconds: 1.8 }),
    ]);
    expect(line).toBe("A and B drew it in about the same time (1.77 s against 1.80 s).");
  });

  test("with more than two, it is the fastest against the slowest", () => {
    const line = verdictLine([
      result({ label: "A", drawSeconds: 4 }),
      result({ label: "B", drawSeconds: 2 }),
      result({ label: "C", drawSeconds: 8 }),
    ]);
    expect(line).toBe("B drew it 4.0x faster than C (2.00 s against 8.00 s).");
  });

  test("one picture is nothing to compare, so there is no line at all", () => {
    expect(verdictLine([result()])).toBeNull();
    expect(verdictLine([result(), result({ ok: false, drawSeconds: null, error: "it fell over" })])).toBeNull();
    expect(verdictLine([])).toBeNull();
  });

  test("a lane's block says the load, the draw and where the picture is", () => {
    const lines = laneReport(result({ label: "M5 Ultra 256GB", loadSeconds: 31.5, drawSeconds: 1.77 }));
    expect(lines[0]).toBe("  M5 Ultra 256GB");
    expect(lines.join("\n")).toContain("loaded the model in 31.5 s");
    expect(lines.join("\n")).toContain("drew the picture in 1.77 s");
    expect(lines.join("\n")).toContain("picture: /tmp/a.png");
  });
});

// ------------------------------------------------------------------ exit code

describe("what the command exits with", () => {
  test("zero only when every lane drew something", () => {
    expect(drawExitCode([result(), result({ label: "B" })])).toBe(0);
  });

  test("non-zero when any lane failed, even though the others drew", () => {
    expect(drawExitCode([result(), result({ label: "B", ok: false, error: "out of memory" })])).toBe(1);
  });

  test("non-zero when nothing ran at all", () => {
    expect(drawExitCode([])).toBe(1);
  });
});

// ------------------------------------------------------------------ a run

describe("a run against fake machines", () => {
  test("both lanes draw, the pictures come back, and the faster one wins", async () => {
    const machine = new FakeMachine();
    machine.secondsByHost = { "one.local": 7, "two.local": 1.77 };

    const results = await runDraw({
      lanes: drawLanes(config()),
      model: DRAW_MODELS.flux,
      prompt: "a fox reading in a library",
      seed: 42,
      stamp: STAMP,
      shimSource: "# shim",
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
      ping: async () => {},
      sleepFor: async () => {},
    });

    expect(results.map((r) => r.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]!.drawSeconds).toBe(1.77);
    // The weight load is reported and is not inside the drawing time.
    expect(results[1]!.loadSeconds).toBe(31.5);
    expect(machine.written.some((p) => p.endsWith("m5-ultra-256gb.png"))).toBe(true);
    expect(machine.written.some((p) => p.endsWith("m3-ultra-512gb.png"))).toBe(true);
    expect(verdictLine(results)).toBe(
      "M5 Ultra 256GB drew it 4.0x faster than M3 Ultra 512GB (1.77 s against 7.00 s).",
    );
    expect(drawExitCode(results)).toBe(0);
  });

  test("every machine is asked at the same time, not one after the other", async () => {
    const machine = new FakeMachine();
    let drawing = 0;
    let atOnce = 0;
    const slowRun = async (target: { host: string }, command: string): Promise<RemoteResult> => {
      if (command.includes("mflux_bench.py")) {
        drawing++;
        atOnce = Math.max(atOnce, drawing);
        await Bun.sleep(20);
        const answer = await machine.run(target, command);
        drawing--;
        return answer;
      }
      return await machine.run(target, command);
    };

    await runDraw({
      lanes: drawLanes(config()),
      model: DRAW_MODELS.flux,
      prompt: "a fox",
      seed: 42,
      stamp: STAMP,
      shimSource: "# shim",
      run: slowRun as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
      ping: async () => {},
      sleepFor: async () => {},
    });

    expect(atOnce).toBe(2);
  });

  test("one machine falling over costs that lane its picture and nothing else", async () => {
    const machine = new FakeMachine();
    machine.failHosts = ["one.local"];

    const results = await runDraw({
      lanes: drawLanes(config()),
      model: DRAW_MODELS.flux,
      prompt: "a fox",
      seed: 42,
      stamp: STAMP,
      shimSource: "# shim",
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
      ping: async () => {},
      sleepFor: async () => {},
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    const fine = results.find((r) => r.label === "M5 Ultra 256GB")!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("out of memory");
    expect(fine.ok).toBe(true);
    expect(fine.localPath).not.toBeNull();
    expect(drawExitCode(results)).toBe(1);
  });

  test("a machine that never wakes says so in words a person can act on", async () => {
    const machine = new FakeMachine();
    machine.unreachableHosts = ["one.local"];
    const lines: string[] = [];

    const results = await runDraw({
      lanes: drawLanes(config()),
      model: DRAW_MODELS.flux,
      prompt: "a fox",
      seed: 42,
      stamp: STAMP,
      shimSource: "# shim",
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
      ping: async () => {},
      sleepFor: async () => {},
      log: (label, message) => lines.push(`${label}: ${message}`),
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    expect(lines.join(" ")).toContain("it may be asleep; waking it");
    expect(broken.error).toContain("could not reach");
    expect(broken.error).toContain("press a key on it");
    expect(results.find((r) => r.label === "M5 Ultra 256GB")!.ok).toBe(true);
    expect(drawExitCode(results)).toBe(1);
  });

  test("a picture that draws but will not copy back keeps its timing and still counts as a failure", async () => {
    const machine = new FakeMachine();
    const results = await runDraw({
      lanes: drawLanes(config(), ["M5 Ultra 256GB"]),
      model: DRAW_MODELS.flux,
      prompt: "a fox",
      seed: 42,
      stamp: STAMP,
      shimSource: "# shim",
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: (async () => null) as never,
      write: machine.write,
      ping: async () => {},
      sleepFor: async () => {},
    });

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.drawSeconds).toBe(4);
    expect(results[0]!.error).toContain("would not copy back");
    expect(machine.written).toEqual([]);
  });
});

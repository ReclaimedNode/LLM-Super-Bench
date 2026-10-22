/**
 * `bun run clip` -- the on-camera video race.
 *
 * The parts worth proving here are the ones that are wrong silently: an
 * argument read the wrong way, a command that quotes a path badly and renders
 * nothing, a missing PATH line that leaves the port unable to find ffmpeg, a
 * verdict line that overstates which Mac won, and a failure that exits zero
 * and tells a script everything was fine. All of those are functions of their
 * input, so none of them needs a Mac.
 *
 * The one end-to-end shape is driven against a fake machine, the same way the
 * picture race's tests are: two lanes, one of which falls over, because that
 * cannot be arranged on real hardware on demand and is exactly the case that
 * must not take the other lane down with it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIP_SEED,
  CLIP_SIZES,
  ClipError,
  clipCommand,
  clipExitCode,
  clipFailureDetail,
  clipImageExt,
  clipLanes,
  clipSeconds,
  laneReport,
  loadStartImage,
  localClipPath,
  openArgs,
  parseClipArgs,
  remoteClipDir,
  remoteClipPath,
  remoteStartImagePath,
  runClip,
  verdictLine,
} from "../src/bench/clip.ts";
import type { ClipLaneResult } from "../src/bench/clip.ts";
import { validateBenchConfig } from "../src/bench/config.ts";
import type { RemoteResult } from "../src/bench/ssh.ts";
import { parseClipSeconds } from "../src/bench/video.ts";

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

function result(over: Partial<ClipLaneResult> = {}): ClipLaneResult {
  return { label: "A", ok: true, seconds: 24.3, localPath: "/tmp/a.mp4", error: null, ...over };
}

/** A machine that answers the way the LTX port answers. */
class FakeMachine {
  commands: string[] = [];
  fetched: string[] = [];
  written: string[] = [];
  /** Seconds per host, so one machine can be made faster than the other. */
  secondsByHost: Record<string, number> = {};
  /** Hosts that fall over instead of rendering. */
  failHosts: string[] = [];
  /** Hosts that never answer ssh at all. */
  unreachableHosts: string[] = [];
  /** Every picture copied out, in the order the lanes copied them. */
  sent: { host: string; path: string; bytes: number }[] = [];
  /** Hosts the picture will not copy onto. */
  refuseImageHosts: string[] = [];

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (this.unreachableHosts.includes(target.host)) {
      return { ok: false, code: 255, stdout: "", stderr: "ssh: connect to host: Operation timed out" };
    }
    if (command === "echo READY") return ok("READY\n");

    if (command.includes("ltx-2-mlx generate")) {
      if (this.failHosts.includes(target.host)) {
        return {
          ok: false,
          code: 1,
          stdout: "Loading weights: 100%|##########| 9/9\n",
          stderr: "Traceback (most recent call last):\nRuntimeError: [metal::malloc] Attempting to allocate too much\n",
        };
      }
      const seconds = this.secondsByHost[target.host] ?? 24.3;
      return ok(
        [
          "Loading weights: 100%|##########| 9/9",
          "Denoising: 100%|##########| 8/8",
          `Saved to: ${remoteClipPath(STAMP)}`,
          `Time: ${seconds}s`,
        ].join("\n") + "\n",
      );
    }
    return ok("");
  };

  sendFile = async (
    target: { host: string },
    path: string,
    bytes: Uint8Array,
  ): Promise<RemoteResult> => {
    this.sent.push({ host: target.host, path, bytes: bytes.byteLength });
    if (this.refuseImageHosts.includes(target.host)) {
      return { ok: false, code: 1, stdout: "", stderr: "cat: /home/x: Read-only file system" };
    }
    return { ok: true, code: 0, stdout: "FILE_WRITTEN\n", stderr: "" };
  };

  fetchFile = async (_t: unknown, path: string): Promise<Uint8Array | null> => {
    this.fetched.push(path);
    return new Uint8Array([0x00, 0x00, 0x00, 0x18]);
  };

  write = async (path: string): Promise<void> => {
    this.written.push(path);
  };
}

// ------------------------------------------------------------------ arguments

describe("reading the command line", () => {
  test("the prompt is the first thing that is not a flag", () => {
    const args = parseClipArgs(["a paper plane over a city at night"]);
    expect(args.prompt).toBe("a paper plane over a city at night");
    expect(args.help).toBe(false);
  });

  test("without a prompt it says what to type instead of filming nothing", () => {
    expect(() => parseClipArgs([])).toThrow(ClipError);
    expect(() => parseClipArgs(["--size", "big"])).toThrow(/Tell me what to film/);
  });

  test("an unquoted prompt is caught rather than silently filming the first word", () => {
    expect(() => parseClipArgs(["a", "paper", "plane"])).toThrow(/one pair of quotes/);
  });

  test("small is the size unless another is named: 512x256, 49 frames, two seconds", () => {
    const args = parseClipArgs(["a paper plane"]);
    expect(args.size).toBe(CLIP_SIZES.small);
    expect(args.size.width).toBe(512);
    expect(args.size.height).toBe(256);
    expect(args.size.frames).toBe(49);
    expect(clipSeconds(args.size)).toBe(2);
  });

  test("big is 704x480, 97 frames, four seconds", () => {
    const args = parseClipArgs(["a paper plane", "--size", "big"]);
    expect(args.size.width).toBe(704);
    expect(args.size.height).toBe(480);
    expect(args.size.frames).toBe(97);
    expect(clipSeconds(args.size)).toBe(4);
  });

  test("both sizes are 8k+1 frames, which is the only shape the model can make", () => {
    for (const size of [CLIP_SIZES.small, CLIP_SIZES.big]) {
      expect((size.frames - 1) % 8).toBe(0);
    }
  });

  test("a size nobody has heard of is refused by name", () => {
    expect(() => parseClipArgs(["a paper plane", "--size", "huge"])).toThrow(/either small or big/);
  });

  test("--lane can be given more than once and keeps the order", () => {
    const args = parseClipArgs(["a paper plane", "--lane", "M5 Ultra 256GB", "--lane", "M3 Ultra 512GB"]);
    expect(args.lanes).toEqual(["M5 Ultra 256GB", "M3 Ultra 512GB"]);
  });

  test("no --lane means every lane", () => {
    expect(parseClipArgs(["a paper plane"]).lanes).toEqual([]);
  });

  test("the seed is 42 unless it is given, and it must be a whole number", () => {
    expect(parseClipArgs(["a paper plane"]).seed).toBe(CLIP_SEED);
    expect(parseClipArgs(["a paper plane"]).seed).toBe(42);
    expect(parseClipArgs(["a paper plane", "--seed", "7"]).seed).toBe(7);
    expect(() => parseClipArgs(["a paper plane", "--seed", "banana"])).toThrow(/whole number/);
  });

  test("no --image means a clip from nothing, which is what it has always been", () => {
    expect(parseClipArgs(["a paper plane"]).image).toBeNull();
  });

  test("--image names a picture on this Mac, and only a png or a jpg", () => {
    expect(parseClipArgs(["a paper plane", "--image", "/tmp/fox.png"]).image).toBe("/tmp/fox.png");
    expect(parseClipArgs(["a paper plane", "--image", "/tmp/fox.JPEG"]).image).toBe("/tmp/fox.JPEG");
    // Refused at the keyboard rather than twenty minutes later on the machine.
    expect(() => parseClipArgs(["a paper plane", "--image", "/tmp/fox.tiff"])).toThrow(/png or a .jpg/);
    expect(() => parseClipArgs(["a paper plane", "--image"])).toThrow(/needs a value/);
  });

  test("the clips open unless --no-open says not to", () => {
    expect(parseClipArgs(["a paper plane"]).open).toBe(true);
    expect(parseClipArgs(["a paper plane", "--no-open"]).open).toBe(false);
  });

  test("--help needs no prompt, and an unknown option is named", () => {
    expect(parseClipArgs(["--help"]).help).toBe(true);
    expect(parseClipArgs(["-h"]).help).toBe(true);
    expect(() => parseClipArgs(["a paper plane", "--fast"])).toThrow(/--fast/);
    expect(() => parseClipArgs(["a paper plane", "--seed"])).toThrow(/needs a value/);
  });
});

// ------------------------------------------------------------------ the command

describe("what one machine is asked to run", () => {
  const command = clipCommand({
    prompt: "a paper plane over a city at night",
    seed: 42,
    size: CLIP_SIZES.small,
    stamp: STAMP,
  });

  test("the whole command, exactly, because every character of it matters", () => {
    expect(command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `mkdir -p "$HOME"'/bench-clips/${STAMP}' && ` +
        `cd "$HOME"'/bench-envs/ltx-2-mlx' && ` +
        `.venv/bin/ltx-2-mlx generate ` +
        `--model "$HOME"'/bench-models/ltx-2.5-mlx-q8' ` +
        `--prompt 'a paper plane over a city at night' ` +
        `--seed '42' --width '512' --height '256' --frames '49' --frame-rate '24' --distilled ` +
        `--output "$HOME"'/bench-clips/${STAMP}/clip.mp4'`,
    );
  });

  test("the PATH line is there, because without it the port cannot find ffmpeg", () => {
    // One Mac keeps ffmpeg in ~/.local/bin and the other in /opt/homebrew/bin,
    // and a plain ssh shell has neither.
    expect(command.startsWith("export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH;")).toBe(true);
  });

  test("big changes the geometry and nothing else", () => {
    const big = clipCommand({ prompt: "a paper plane", seed: 1, size: CLIP_SIZES.big, stamp: STAMP });
    expect(big).toContain("--width '704'");
    expect(big).toContain("--height '480'");
    expect(big).toContain("--frames '97'");
    expect(big).toContain("--frame-rate '24'");
    expect(big).toContain("--seed '1'");
    expect(big).toContain("--distilled");
  });

  test("no step count, so the port uses its own default for these weights", () => {
    expect(command).not.toContain("--steps");
  });

  test("a clip from nothing carries no --image at all", () => {
    expect(command).not.toContain("--image");
    expect(
      clipCommand({
        prompt: "a paper plane over a city at night",
        seed: 42,
        size: CLIP_SIZES.small,
        stamp: STAMP,
        imagePath: null,
      }),
    ).toBe(command);
  });

  test("a clip from a picture is the same command with --image on the end", () => {
    const fromPicture = clipCommand({
      prompt: "a paper plane over a city at night",
      seed: 42,
      size: CLIP_SIZES.small,
      stamp: STAMP,
      imagePath: remoteStartImagePath(STAMP, "png"),
    });
    expect(fromPicture).toBe(`${command} --image "$HOME"'/bench-clips/${STAMP}/start.png'`);
  });

  test("a jpg starting frame is named as one", () => {
    expect(remoteStartImagePath(STAMP, "jpg")).toBe(`~/bench-clips/${STAMP}/start.jpg`);
    expect(clipCommand({ prompt: "a plane", seed: 1, size: CLIP_SIZES.big, stamp: STAMP, imagePath: remoteStartImagePath(STAMP, "jpg") })).toContain(
      `--image "$HOME"'/bench-clips/${STAMP}/start.jpg'`,
    );
  });

  test("the picture the port is given is left at whatever size it is", () => {
    // The port resizes and centre crops the starting frame to the clip's own
    // geometry itself, so a square 1024 picture is handed over untouched and
    // nothing here has to know what shape the clip is.
    const fromPicture = clipCommand({
      prompt: "a plane",
      seed: 42,
      size: CLIP_SIZES.big,
      stamp: STAMP,
      imagePath: remoteStartImagePath(STAMP, "png"),
    });
    expect(fromPicture).not.toContain("sips");
    expect(fromPicture).toContain("--width '704'");
  });

  test("a prompt with a quote in it cannot break out of the command", () => {
    const risky = clipCommand({
      prompt: "it's a plane'; rm -rf ~",
      seed: 42,
      size: CLIP_SIZES.small,
      stamp: STAMP,
    });
    expect(risky).toContain(`--prompt 'it'\\''s a plane'\\''; rm -rf ~'`);
  });

  test("opening the clips is an argument array, never a shell string", () => {
    expect(openArgs(["/tmp/a.mp4", "/tmp/b.mp4"])).toEqual(["open", "/tmp/a.mp4", "/tmp/b.mp4"]);
  });
});

// ------------------------------------------------------------------ names

describe("naming things", () => {
  test("each lane's clip sits under this run's folder, named after the lane", () => {
    const path = localClipPath(STAMP, "M5 Ultra 256GB");
    expect(path.endsWith(`results/clip/${STAMP}/m5-ultra-256gb.mp4`)).toBe(true);
  });

  test("the machine writes into a folder of its own, under the home directory", () => {
    expect(remoteClipDir(STAMP)).toBe(`~/bench-clips/${STAMP}`);
    expect(remoteClipPath(STAMP)).toBe(`~/bench-clips/${STAMP}/clip.mp4`);
  });

  test("the starting picture sits beside the clip it becomes, in this run's folder", () => {
    expect(remoteStartImagePath(STAMP, "png")).toBe(`${remoteClipDir(STAMP)}/start.png`);
  });

  test("which kind of picture a file is comes off its name, in either case", () => {
    expect(clipImageExt("/tmp/a.png")).toBe("png");
    expect(clipImageExt("/tmp/a.PNG")).toBe("png");
    expect(clipImageExt("/tmp/a.jpg")).toBe("jpg");
    expect(clipImageExt("/tmp/a.jpeg")).toBe("jpg");
    expect(() => clipImageExt("/tmp/a.gif")).toThrow(ClipError);
    expect(() => clipImageExt("/tmp/a")).toThrow(/png or a .jpg/);
  });
});

// ------------------------------------------------------------------ lanes

describe("choosing the machines", () => {
  test("every lane with a way in, and never a manual one", () => {
    expect(clipLanes(config()).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
  });

  test("--lane restricts to what was named, by label or by file name", () => {
    expect(clipLanes(config(), ["M5 Ultra 256GB"]).map((l) => l.lane.label)).toEqual(["M5 Ultra 256GB"]);
    expect(clipLanes(config(), ["m3-ultra-512gb"]).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB"]);
  });

  test("a lane nobody has is refused, and the real ones are listed", () => {
    expect(() => clipLanes(config(), ["M7 Ultra"])).toThrow(/M3 Ultra 512GB, M5 Ultra 256GB/);
  });
});

// ------------------------------------------------------------------ the timing

describe("reading the port's timing", () => {
  test("the Time: line is the seconds for the whole invocation", () => {
    expect(parseClipSeconds("Denoising: done\nTime: 24.3s\n")).toBe(24.3);
  });

  test("output with no Time: line at all is a lane that failed", () => {
    expect(parseClipSeconds("Traceback (most recent call last):\nRuntimeError: out of memory\n")).toBeNull();
  });

  test("what a failed lane shows is the END of its output, where the reason is", () => {
    const noisy = [...Array(40).keys()].map((i) => `progress line ${i}`).concat(["RuntimeError: out of memory"]);
    const detail = clipFailureDetail(noisy.join("\n"));
    expect(detail).toContain("RuntimeError: out of memory");
    expect(detail).toContain("progress line 29");
    expect(detail).not.toContain("progress line 28");
    expect(detail.split("\n")).toHaveLength(12);
  });

  test("a machine that printed nothing says so rather than showing an empty block", () => {
    expect(clipFailureDetail("\n  \n")).toBe("it printed nothing at all");
  });
});

// ------------------------------------------------------------------ verdict

describe("the line that compares them", () => {
  test("fastest against slowest, the ratio and the seconds to one decimal", () => {
    const line = verdictLine([
      result({ label: "M3 Ultra 512GB", seconds: 24.3 }),
      result({ label: "M5 Ultra 256GB", seconds: 10.2 }),
    ]);
    // 24.3 / 10.2 is 2.382…, which to one decimal is 2.4.
    expect(line).toBe("M5 Ultra 256GB made it 2.4x faster than M3 Ultra 512GB (10.2 s against 24.3 s).");
  });

  test("two machines that are level are not dressed up as a win", () => {
    const line = verdictLine([result({ label: "A", seconds: 10.2 }), result({ label: "B", seconds: 10.4 })]);
    expect(line).toBe("A and B made it in about the same time (10.2 s against 10.4 s).");
  });

  test("with more than two, it is the fastest against the slowest", () => {
    const line = verdictLine([
      result({ label: "A", seconds: 20 }),
      result({ label: "B", seconds: 10 }),
      result({ label: "C", seconds: 40 }),
    ]);
    expect(line).toBe("B made it 4.0x faster than C (10.0 s against 40.0 s).");
  });

  test("one clip is nothing to compare, so there is no line at all", () => {
    expect(verdictLine([result()])).toBeNull();
    expect(verdictLine([result(), result({ ok: false, seconds: null, error: "it fell over" })])).toBeNull();
    expect(verdictLine([])).toBeNull();
  });

  test("a lane's block says the seconds, that the load is inside them, and where the clip is", () => {
    const lines = laneReport(result({ label: "M5 Ultra 256GB", seconds: 10.24 }));
    expect(lines[0]).toBe("  M5 Ultra 256GB");
    expect(lines.join("\n")).toContain("made the clip in 10.2 s, load and generation together");
    expect(lines.join("\n")).toContain("clip: /tmp/a.mp4");
  });
});

// ------------------------------------------------------------------ exit code

describe("what the command exits with", () => {
  test("zero only when every lane made a clip", () => {
    expect(clipExitCode([result(), result({ label: "B" })])).toBe(0);
  });

  test("non-zero when any lane failed, even though the others filmed", () => {
    expect(clipExitCode([result(), result({ label: "B", ok: false, error: "out of memory" })])).toBe(1);
  });

  test("non-zero when nothing ran at all", () => {
    expect(clipExitCode([])).toBe(1);
  });
});

// ------------------------------------------------------------------ a run

describe("a run against fake machines", () => {
  const base = {
    prompt: "a paper plane over a city at night",
    seed: 42,
    size: CLIP_SIZES.small,
    stamp: STAMP,
    ping: async () => {},
    sleepFor: async () => {},
  };

  test("both lanes film, the clips come back, and the faster one wins", async () => {
    const machine = new FakeMachine();
    machine.secondsByHost = { "one.local": 24.3, "two.local": 10.2 };

    const results = await runClip({
      ...base,
      lanes: clipLanes(config()),
      run: machine.run as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    expect(results.map((r) => r.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]!.seconds).toBe(10.2);
    expect(machine.fetched).toEqual([remoteClipPath(STAMP), remoteClipPath(STAMP)]);
    expect(machine.written.some((p) => p.endsWith("m5-ultra-256gb.mp4"))).toBe(true);
    expect(machine.written.some((p) => p.endsWith("m3-ultra-512gb.mp4"))).toBe(true);
    expect(verdictLine(results)).toBe(
      "M5 Ultra 256GB made it 2.4x faster than M3 Ultra 512GB (10.2 s against 24.3 s).",
    );
    expect(clipExitCode(results)).toBe(0);
  });

  test("every machine is asked at the same time, not one after the other", async () => {
    const machine = new FakeMachine();
    let rendering = 0;
    let atOnce = 0;
    const slowRun = async (target: { host: string }, command: string): Promise<RemoteResult> => {
      if (command.includes("ltx-2-mlx generate")) {
        rendering++;
        atOnce = Math.max(atOnce, rendering);
        await Bun.sleep(20);
        const answer = await machine.run(target, command);
        rendering--;
        return answer;
      }
      return await machine.run(target, command);
    };

    await runClip({
      ...base,
      lanes: clipLanes(config()),
      run: slowRun as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    expect(atOnce).toBe(2);
  });

  test("one machine falling over costs that lane its clip and nothing else", async () => {
    const machine = new FakeMachine();
    machine.failHosts = ["one.local"];

    const results = await runClip({
      ...base,
      lanes: clipLanes(config()),
      run: machine.run as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    const fine = results.find((r) => r.label === "M5 Ultra 256GB")!;
    expect(broken.ok).toBe(false);
    expect(broken.seconds).toBeNull();
    expect(broken.error).toContain("no clip came back");
    expect(broken.error).toContain("Attempting to allocate too much");
    expect(fine.ok).toBe(true);
    expect(fine.localPath).not.toBeNull();
    expect(clipExitCode(results)).toBe(1);
  });

  test("a machine that never wakes says so in words a person can act on", async () => {
    const machine = new FakeMachine();
    machine.unreachableHosts = ["one.local"];
    const lines: string[] = [];

    const results = await runClip({
      ...base,
      lanes: clipLanes(config()),
      run: machine.run as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
      log: (label, message) => lines.push(`${label}: ${message}`),
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    expect(lines.join(" ")).toContain("it may be asleep; waking it");
    expect(broken.error).toContain("could not reach");
    expect(broken.error).toContain("press a key on it");
    expect(results.find((r) => r.label === "M5 Ultra 256GB")!.ok).toBe(true);
    expect(clipExitCode(results)).toBe(1);
  });

  test("the picture goes out to every machine BEFORE it is asked for a clip", async () => {
    const machine = new FakeMachine();
    const order: string[] = [];
    const watched = async (target: { host: string }, command: string): Promise<RemoteResult> => {
      if (command.includes("ltx-2-mlx generate")) order.push(`generate ${target.host}`);
      return await machine.run(target, command);
    };

    const results = await runClip({
      ...base,
      lanes: clipLanes(config()),
      startImage: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a]), ext: "png" },
      run: watched as never,
      sendFile: ((target: { host: string }, path: string, bytes: Uint8Array) => {
        order.push(`picture ${target.host}`);
        return machine.sendFile(target, path, bytes);
      }) as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    expect(results.every((r) => r.ok)).toBe(true);
    // Both pictures land before either machine is asked to render: the
    // command names a file that has to be there when it runs.
    expect(order.filter((step) => step.startsWith("picture"))).toHaveLength(2);
    expect(order.indexOf("generate one.local")).toBeGreaterThan(order.indexOf("picture one.local"));
    expect(order.indexOf("generate two.local")).toBeGreaterThan(order.indexOf("picture two.local"));

    expect(machine.sent.map((s) => s.path)).toEqual([
      remoteStartImagePath(STAMP, "png"),
      remoteStartImagePath(STAMP, "png"),
    ]);
    expect(machine.sent.every((s) => s.bytes === 5)).toBe(true);
    for (const command of machine.commands.filter((c) => c.includes("generate"))) {
      expect(command).toContain(`--image "$HOME"'/bench-clips/${STAMP}/start.png'`);
    }
  });

  test("with no picture the machines are asked exactly what they were asked before", async () => {
    const machine = new FakeMachine();
    await runClip({
      ...base,
      lanes: clipLanes(config()),
      run: machine.run as never,
      sendFile: machine.sendFile as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    expect(machine.sent).toEqual([]);
    expect(machine.commands.filter((c) => c.includes("--image"))).toEqual([]);
  });

  test("a picture that will not copy onto one machine costs that lane only", async () => {
    const machine = new FakeMachine();
    machine.refuseImageHosts = ["one.local"];

    const results = await runClip({
      ...base,
      lanes: clipLanes(config()),
      startImage: { bytes: new Uint8Array([0x89, 0x50]), ext: "png" },
      run: machine.run as never,
      sendFile: machine.sendFile as never,
      fetchFile: machine.fetchFile as never,
      write: machine.write,
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    expect(broken.ok).toBe(false);
    expect(broken.error).toContain("would not copy onto this machine");
    expect(broken.error).toContain("Read-only file system");
    // The machine that refused the picture is never asked to render.
    expect(machine.commands.filter((c) => c.includes("generate"))).toHaveLength(1);
    expect(results.find((r) => r.label === "M5 Ultra 256GB")!.ok).toBe(true);
    expect(clipExitCode(results)).toBe(1);
  });

  test("a clip that renders but will not copy back keeps its timing and still counts as a failure", async () => {
    const machine = new FakeMachine();
    const results = await runClip({
      ...base,
      lanes: clipLanes(config(), ["M5 Ultra 256GB"]),
      run: machine.run as never,
      fetchFile: (async () => null) as never,
      write: machine.write,
    });

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.seconds).toBe(24.3);
    expect(results[0]!.error).toContain("would not copy back");
    expect(machine.written).toEqual([]);
    expect(clipExitCode(results)).toBe(1);
  });
});

// ------------------------------------------------------------------ the picture

describe("reading the picture off this Mac", () => {
  test("a png is read once, as bytes, before any machine is touched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clip-image-"));
    try {
      const path = join(dir, "fox.png");
      await writeFile(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      const loaded = await loadStartImage(path);
      expect(loaded.ext).toBe("png");
      expect([...loaded.bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a picture that is not there says so in a sentence, rather than filming nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clip-image-"));
    try {
      await expect(loadStartImage(join(dir, "missing.png"))).rejects.toThrow(/There is no picture at/);

      const empty = join(dir, "empty.jpg");
      await writeFile(empty, new Uint8Array([]));
      await expect(loadStartImage(empty)).rejects.toThrow(/is empty/);

      await expect(loadStartImage(join(dir, "notes.txt"))).rejects.toThrow(/png or a .jpg/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

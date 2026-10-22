/**
 * The video benchmark.
 *
 * The facts asserted here were read off the port at the pinned commit
 * (xocialize/ltx-2-mlx @ c952c8f, branch ltx-2.5): its cli.py for the flag
 * names and defaults, and its `Time: {elapsed:.1f}s` output line. The licence
 * text was read from the model repo's LICENSE.md.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { validateBenchConfig } from "../../src/bench/config.ts";
import {
  DEFAULT_VIDEO_SETTINGS,
  LTX_BRANCH,
  LTX_COMMIT,
  VIDEO_DISCLOSURE,
  generateClipCommand,
  installPortCommand,
  isValidFrameCount,
  lastOutput,
  nearestFrameCount,
  parseClipSeconds,
  parseSavedPath,
  planVideoGrid,
  summariseVideoCells,
  videoSettingsFrom,
} from "../../src/bench/video.ts";
import type { VideoCell, VideoRunRecord } from "../../src/bench/video.ts";
import { runVideoGrid, readVideoRuns } from "../../src/bench/videocli.ts";
import { buildBoard } from "../../src/bench/board.ts";
import { runDir } from "../../src/bench/store.ts";
import type { RemoteResult } from "../../src/bench/ssh.ts";
import type { RunManifest } from "../../src/bench/types.ts";

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [
      { name: "LTX-2.5 q8", dir: "ltx-2.5-mlx-q8", kind: "video", hfRepo: "mlx-community/ltx-2.5-mlx-q8", approxGb: 24 },
    ],
    lanes: [
      { label: "One", baseUrl: "http://one.local:8090", ssh: { host: "one.local", binDir: "~/bench-envs/llm/bin", port: 8090 } },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
    ...over,
  });
}

const CELL: VideoCell = {
  laneLabel: "One", modelId: "~/bench-models/ltx-2.5-mlx-q8", modelName: "LTX-2.5 q8", dir: "ltx-2.5-mlx-q8", measuredClips: 3,
};

class FakeVideoMachine {
  commands: string[] = [];
  portInstalled = false;
  seconds = 84.3;
  failInstall = false;
  noTiming = false;

  run = async (_t: unknown, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (command === "echo READY") return ok("READY\n");
    if (command.includes("git clone")) {
      if (this.failInstall) return { ok: false, code: 1, stdout: "", stderr: "fatal: could not read from remote" };
      this.portInstalled = true;
      return ok("PORT_INSTALLED\n");
    }
    if (command.includes("git rev-parse --short HEAD")) return ok("c952c8f\n");
    if (command.includes("ltx-2-mlx generate")) {
      if (this.noTiming) return ok("some output but no timing\n");
      return ok(`Saved to: /home/x/bench-video/r/ltx-2.5-mlx-q8/clip_0.mp4\nTime: ${this.seconds}s\n`);
    }
    if (command.startsWith("rm -rf")) return ok("");
    return ok("");
  };

  fetchFile = async (): Promise<Uint8Array | null> => new Uint8Array([0, 0, 0, 24]);
}

const runNames: string[] = [];
function freshRun(): string {
  const name = `vidtest-${process.pid}-${Date.now()}-${runNames.length}`;
  runNames.push(name);
  return name;
}
afterEach(async () => {
  await Promise.all(runNames.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
});

describe("the port is pinned", () => {
  test("to a commit, not to a moving branch", () => {
    expect(LTX_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(LTX_BRANCH).toBe("ltx-2.5");
    const command = installPortCommand();
    expect(command).toContain(LTX_COMMIT);
    expect(command).toContain(`git checkout '${LTX_COMMIT}'`);
    // Never a bare pull: the numbers must not move when the branch does.
    expect(command).not.toMatch(/git pull/);
  });

  test("an existing checkout at that commit is left alone", () => {
    expect(installPortCommand()).toContain("PORT_PRESENT");
  });
});

describe("the generate command", () => {
  test("uses the port's real flags and the uniform model path", () => {
    const command = generateClipCommand({ cell: CELL, settings: DEFAULT_VIDEO_SETTINGS, runName: "r", index: 0 });
    expect(command).toContain("ltx-2-mlx generate");
    expect(command).toContain(`--model "$HOME"'/bench-models/ltx-2.5-mlx-q8'`);
    expect(command).toContain("--width '512'");
    expect(command).toContain("--height '288'");
    expect(command).toContain("--frames '49'");
    expect(command).toContain("--seed '42'");
    expect(command).toContain("--low-ram");
    expect(command).toContain("clip_0.mp4");
  });

  test("uv is told not to sync, because a sync destroys the environment", () => {
    // The port's venv carries a hand-installed mlx-lm built from main. The
    // lockfile does not know about it, so a bare `uv run` puts the locked
    // version back and takes the gemma4_unified text encoder these weights
    // need with it. Seen live on one of the machines.
    const command = generateClipCommand({ cell: CELL, settings: DEFAULT_VIDEO_SETTINGS, runName: "r", index: 0 });
    expect(command).toContain("uv run --no-sync ltx-2-mlx generate");
    expect(command).not.toMatch(/uv run (?!--no-sync)/);
  });

  test("a prompt with a quote cannot break out", () => {
    const command = generateClipCommand({
      cell: CELL,
      settings: { ...DEFAULT_VIDEO_SETTINGS, prompt: "a lamp'; rm -rf ~" },
      runName: "r",
      index: 0,
    });
    expect(command).toContain(`'a lamp'\\''; rm -rf ~'`);
  });

  test("the default clip is small on purpose", () => {
    // Nothing here has been timed, so the default errs small enough to finish
    // in a few minutes rather than large enough to look impressive.
    expect(DEFAULT_VIDEO_SETTINGS.width).toBe(512);
    expect(DEFAULT_VIDEO_SETTINGS.height).toBe(288);
    expect(DEFAULT_VIDEO_SETTINGS.frames).toBe(49);
    expect(DEFAULT_VIDEO_SETTINGS.measuredClips).toBe(3);
    expect(DEFAULT_VIDEO_SETTINGS.warmupClips).toBe(1);
    expect(DEFAULT_VIDEO_SETTINGS.lowRam).toBe(true);
  });
});

describe("frame counts", () => {
  test("must be 8k+1, because the model compresses in eights", () => {
    for (const good of [9, 17, 25, 33, 41, 49, 97, 121]) expect(isValidFrameCount(good)).toBe(true);
    for (const bad of [8, 10, 48, 50, 100, 0, -1, 9.5]) expect(isValidFrameCount(bad)).toBe(false);
  });

  test("the nearest valid count below is suggested", () => {
    expect(nearestFrameCount(50)).toBe(49);
    expect(nearestFrameCount(100)).toBe(97);
    expect(nearestFrameCount(4)).toBe(9);
  });
});

describe("reading the port's output", () => {
  test("its own Time: line is the number", () => {
    expect(parseClipSeconds("Saved to: /a/b.mp4\nTime: 84.3s\n")).toBe(84.3);
    expect(parseSavedPath("Saved to: /a/b.mp4\nTime: 84.3s\n")).toBe("/a/b.mp4");
  });

  test("the last Time: wins when the port printed more than one", () => {
    expect(parseClipSeconds("Time: 10.0s\nTime: 20.5s\n")).toBe(20.5);
  });

  test("no timing means no number, never a zero", () => {
    expect(parseClipSeconds("it crashed")).toBeNull();
    expect(parseSavedPath("it crashed")).toBeNull();
  });
});

describe("running it", () => {
  test("times every clip and brings them back", async () => {
    const machine = new FakeVideoMachine();
    const runName = freshRun();
    const plan = planVideoGrid(config(), { ...DEFAULT_VIDEO_SETTINGS, measuredClips: 2, restSeconds: 0 });
    const cells = await runVideoGrid({
      plan, runName, log: () => {}, run: machine.run as never, fetchFile: machine.fetchFile as never,
    });

    expect(cells).toHaveLength(1);
    expect(cells[0]!.status).toBe("ok");
    expect(cells[0]!.clipsUsed).toBe(2);
    expect(cells[0]!.secondsPerClip!.median).toBe(84.3);
    expect(cells[0]!.portCommit).toBe("c952c8f");

    const records = await readVideoRuns(runName);
    expect(records.filter((r) => r.warmup)).toHaveLength(1);
    expect(records.filter((r) => !r.warmup)).toHaveLength(2);
    expect(records.every((r) => r.portCommit === "c952c8f")).toBe(true);
  }, 30_000);

  test("a port that will not install leaves the rest of the tool alone", async () => {
    const machine = new FakeVideoMachine();
    machine.failInstall = true;
    const runName = freshRun();
    const logs: string[] = [];
    const cells = await runVideoGrid({
      plan: planVideoGrid(config(), { ...DEFAULT_VIDEO_SETTINGS, measuredClips: 1, restSeconds: 0 }),
      runName, log: (m) => logs.push(m), run: machine.run as never, fetchFile: machine.fetchFile as never,
    });
    expect(logs.join(" ")).toContain("would not install");
    expect(logs.join(" ")).toContain("unaffected");
    expect(cells[0]!.status).toBe("not-run");
    // It never tried to generate.
    expect(machine.commands.filter((c) => c.includes("ltx-2-mlx generate"))).toEqual([]);
  }, 30_000);

  test("a clip with no timing is recorded as failed, and the run continues", async () => {
    const machine = new FakeVideoMachine();
    machine.noTiming = true;
    const runName = freshRun();
    const cells = await runVideoGrid({
      plan: planVideoGrid(config(), { ...DEFAULT_VIDEO_SETTINGS, measuredClips: 2, restSeconds: 0 }),
      runName, log: () => {}, run: machine.run as never, fetchFile: machine.fetchFile as never,
    });
    expect(cells[0]!.status).toBe("failed");
    expect((await readVideoRuns(runName)).every((r) => r.error !== null)).toBe(true);
  }, 30_000);

  test("only managed lanes are planned", () => {
    const plan = planVideoGrid(config(), DEFAULT_VIDEO_SETTINGS);
    expect(plan.lanes.map((l) => l.lane.label)).toEqual(["One"]);
  });

  test("settings can be overridden from the config", () => {
    const s = videoSettingsFrom(config(), { width: 704, height: 480, frames: 97, measuredClips: 5, lowRam: false });
    expect(s.width).toBe(704);
    expect(s.frames).toBe(97);
    expect(s.measuredClips).toBe(5);
    expect(s.lowRam).toBe(false);
  });
});

describe("the board's video section", () => {
  const manifest: RunManifest = {
    runName: "r", startedAt: "", finishedAt: "", outputCap: 128, measuredRuns: 5, warmupRuns: 1, restSeconds: 30,
    temperature: 0, promptFile: "p", disableThinking: true, models: [], promptLengths: [],
    lanes: [{ label: "One", managed: true }, { label: "Two", managed: true }],
    fingerprints: [], charsPerToken: {},
  };

  function record(lane: string, seconds: number): VideoRunRecord {
    return {
      ts: "", runName: "r", laneLabel: lane, modelId: "m", modelName: "LTX-2.5 q8", dir: "d",
      runIndex: 1, warmup: false, secondsIncludingLoad: seconds, seed: 42, width: 512, height: 288,
      frames: 49, steps: null, prompt: "p", portCommit: "c952c8f", remotePath: "", localFile: `clips/${lane}.mp4`, error: null,
    };
  }

  test("a bar per lane, the pinned commit, and the licence's disclosure", () => {
    const stats = summariseVideoCells(
      [
        { laneLabel: "One", modelId: "m", modelName: "LTX-2.5 q8", dir: "d", measuredClips: 1 },
        { laneLabel: "Two", modelId: "m", modelName: "LTX-2.5 q8", dir: "d", measuredClips: 1 },
      ],
      [record("One", 84.3), record("Two", 190.1)],
    );
    const board = buildBoard({
      manifest, cells: [], engine: [], power: [], video: stats,
      videoSettings: { width: 512, height: 288, frames: 49, seed: 42 },
    });

    const video = board.video![0]!;
    expect(video.bars.map((b) => b.median)).toEqual([84.3, 190.1]);
    expect(video.portCommit).toBe("c952c8f");
    expect(video.settings).toContain("512x288, 49 frames");
    expect(video.ticks[0]).toBe(0);
    expect(video.max).toBeGreaterThanOrEqual(190.1);
    // Not optional: the licence forbids showing this without saying it.
    expect(video.disclosure).toBe(VIDEO_DISCLOSURE);
    expect(video.disclosure).toContain("machine generated");
  });

  test("a run with no clips has no video section", () => {
    expect(buildBoard({ manifest, cells: [], engine: [], power: [] }).video).toBeNull();
  });
});

describe("what it says when the port will not install", () => {
  // Learnt live: the port does not build at the pinned commit -- its packages
  // declare `readme = "../../README.md"`, outside their own directory, which
  // hatchling refuses. The run failed soft exactly as intended, but the
  // message showed 300 characters of git's detached-HEAD advice and the actual
  // reason, three screens further down, never reached the terminal.
  test("the END of the output is shown, because that is where the error is", () => {
    const noise = "Note: switching to 'c952c8f'.\n".repeat(40);
    const real = "ValueError: Readme path must be within the project directory: ../../README.md";
    const shown = lastOutput(`${noise}${real}`);
    expect(shown).toContain("Readme path must be within");
    expect(shown.startsWith("…")).toBe(true);
  });

  test("short output is shown whole, with no ellipsis", () => {
    expect(lastOutput("it failed")).toBe("it failed");
  });

  test("it does not install the trainer to generate a clip", () => {
    // --all-extras pulls in ltx-trainer-mlx, which is not needed here and is
    // one more package that can fail to build.
    const command = installPortCommand();
    expect(command).toContain("uv sync");
    expect(command).not.toContain("--all-extras");
  });
});

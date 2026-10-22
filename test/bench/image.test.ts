/**
 * The image benchmark.
 *
 * Driven against a fake machine, like the setup command: the shapes worth
 * testing are a model that fails, two lanes that disagree about what the
 * picture looks like, and a resumed run, and none of those can be conjured on
 * real hardware on demand.
 *
 * The flags and step counts asserted here were read off mflux at the pinned
 * version 0.19.2 -- its pyproject console_scripts, its two CLI entry points and
 * its own tests/arg_parser/test_default_steps.py -- not guessed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { validateBenchConfig } from "../../src/bench/config.ts";
import {
  DEFAULT_IMAGE_SETTINGS,
  imageKindFor,
  imageSettingsFrom,
  installShimCommand,
  parseShimOutput,
  planImageGrid,
  remoteImageDir,
  shimCommand,
} from "../../src/bench/image.ts";
import type { ImageCell, ImageRunRecord, ImageSettings } from "../../src/bench/image.ts";
import { checksumDisagreements, summariseImageCell, summariseImageCells } from "../../src/bench/imagestats.ts";
import { imageCellsOwed, readImageRuns, runImageGrid } from "../../src/bench/imagerunner.ts";
import type { ImageEvent } from "../../src/bench/imagerunner.ts";
import { buildBoard } from "../../src/bench/board.ts";
import { runDir } from "../../src/bench/store.ts";
import type { RemoteResult } from "../../src/bench/ssh.ts";
import type { RunManifest } from "../../src/bench/types.ts";

// ------------------------------------------------------------------ fixtures

const IMAGE_MODELS = [
  { name: "FLUX.2 klein 4B", dir: "FLUX.2-klein-4B", kind: "image", hfRepo: "black-forest-labs/FLUX.2-klein-4B", approxGb: 12 },
  { name: "Z-Image Turbo", dir: "Z-Image-Turbo", kind: "image", hfRepo: "Tongyi-MAI/Z-Image-Turbo", approxGb: 16 },
];

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [{ name: "Text", dir: "Text-4bit", hfRepo: "vendor/Text-4bit" }, ...IMAGE_MODELS],
    lanes: [
      {
        label: "One",
        baseUrl: "http://one.local:8090",
        ssh: { host: "one.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      {
        label: "Two",
        baseUrl: "http://two.local:8090",
        ssh: { host: "two.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
    ...over,
  });
}

function settings(over: Partial<ImageSettings> = {}): ImageSettings {
  return { ...DEFAULT_IMAGE_SETTINGS, measuredImages: 2, warmupImages: 1, restSeconds: 0, ...over };
}

/** A machine that runs the shim and answers the way the shim would. */
class FakeImageMachine {
  commands: string[] = [];
  shimInstalled = false;
  /** Per-lane checksum, so two lanes can be made to disagree. */
  checksums: Record<string, string> = {};
  secondsByLane: Record<string, number> = {};
  failFor: string | null = null;
  reachable = true;
  fetched: string[] = [];

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (!this.reachable) return { ok: false, code: 255, stdout: "", stderr: "no route to host" };
    if (command === "echo READY") return ok("READY\n");
    if (command.startsWith("rm -rf")) return ok("");

    if (command.includes("mflux_bench.py")) {
      const dir = /bench-models\/([A-Za-z0-9_.-]+)/.exec(command)?.[1] ?? "?";
      if (this.failFor && command.includes(this.failFor)) {
        return ok(JSON.stringify({ event: "error", message: "RuntimeError: out of memory" }) + "\n");
      }
      const seconds = this.secondsByLane[target.host] ?? 4;
      const sha = this.checksums[target.host] ?? "abc123def456";
      const lines = [
        JSON.stringify({ event: "versions", mflux: "0.19.2", mlx: "0.31.2" }),
        // Real progress noise, to prove the parser tolerates it.
        "Fetching weights: 100%|##########| 12/12",
        JSON.stringify({ event: "loaded", seconds: 31.5 }),
      ];
      const total = 1 + 2;
      for (let i = 0; i < total; i++) {
        lines.push(
          JSON.stringify({
            event: "image",
            index: i,
            warmup: i === 0,
            seconds: seconds + i * 0.1,
            path: `${remoteImageDir("r", dir)}/img_${i}.png`,
            sha256: sha,
          }),
        );
      }
      lines.push(JSON.stringify({ event: "done", peak_memory_gb: 41.2 }));
      return ok(lines.join("\n") + "\n");
    }
    return ok("");
  };

  sendShim = async (_t: unknown, _c: string, _input: string): Promise<RemoteResult> => {
    this.shimInstalled = true;
    return { ok: true, code: 0, stdout: "SHIM_WRITTEN\n", stderr: "" };
  };

  fetchFile = async (_t: unknown, path: string): Promise<Uint8Array | null> => {
    this.fetched.push(path);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  };
}

const runNames: string[] = [];
function freshRun(): string {
  const name = `imgtest-${process.pid}-${Date.now()}-${runNames.length}`;
  runNames.push(name);
  return name;
}

afterEach(async () => {
  await Promise.all(runNames.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
});

// ------------------------------------------------------------------ mflux facts

describe("what mflux actually takes", () => {
  test("each model is routed to the command that drives it", () => {
    // From mflux 0.19.2's pyproject console_scripts:
    //   mflux-generate-flux2         -> mflux.models.flux2.cli.flux2_generate
    //   mflux-generate-z-image-turbo -> mflux.models.z_image.cli.z_image_turbo_generate
    expect(imageKindFor({ name: "a", id: "x", kind: "image", hfRepo: "black-forest-labs/FLUX.2-klein-4B" })).toBe("flux2-klein");
    expect(imageKindFor({ name: "b", id: "y", kind: "image", hfRepo: "Tongyi-MAI/Z-Image-Turbo" })).toBe("z-image-turbo");
    expect(imageKindFor({ name: "c", id: "~/bench-models/Z-Image-Turbo", kind: "image" })).toBe("z-image-turbo");
    expect(imageKindFor({ name: "d", id: "~/bench-models/Something-Else", kind: "image" })).toBeNull();
  });

  test("the command uses mflux's real flag names, and the uniform model path", () => {
    const command = shimCommand({
      cell: { laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z-Image-Turbo", kind: "z-image-turbo", measuredImages: 5 },
      settings: settings({ measuredImages: 5, prompt: "a cat" }),
      runName: "r",
    });
    expect(command).toContain("--kind 'z-image-turbo'");
    expect(command).toContain(`--model "$HOME"'/bench-models/Z-Image-Turbo'`);
    expect(command).toContain("--prompt 'a cat'");
    expect(command).toContain("--seed '42'");
    expect(command).toContain("--width '1024'");
    expect(command).toContain("--height '1024'");
    expect(command).toContain("--count '5'");
    expect(command).toContain("--warmup '1'");
    expect(command).toContain(`"$HOME"'/bench-envs/image/bin/python'`);
  });

  test("with no step count configured, mflux picks its own for each model", () => {
    // mflux's own tests pin 4 for flux2-klein-4b and 9 for z-image-turbo.
    // Carrying a second copy of those numbers here would be a copy that drifts.
    const command = shimCommand({
      cell: { laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 2 },
      settings: settings({ steps: null }),
      runName: "r",
    });
    expect(command).not.toContain("--steps");
  });

  test("a configured step count is passed through", () => {
    const command = shimCommand({
      cell: { laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 2 },
      settings: settings({ steps: 12 }),
      runName: "r",
    });
    expect(command).toContain("--steps '12'");
  });

  test("a prompt with a quote in it cannot break out of the command", () => {
    const command = shimCommand({
      cell: { laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 1 },
      settings: settings({ prompt: "it's a cat'; rm -rf ~" }),
      runName: "r",
    });
    expect(command).toContain(`'it'\\''s a cat'\\''; rm -rf ~'`);
  });

  test("the shim is written through the same ssh, not a second tool", () => {
    expect(installShimCommand()).toContain("cat >");
    expect(installShimCommand()).toContain("SHIM_WRITTEN");
  });
});

describe("reading the shim back", () => {
  const output = [
    '{"event":"versions","mflux":"0.19.2","mlx":"0.31.2"}',
    "Fetching 12 files: 100%|##########|",
    '{"event":"loaded","seconds":31.5}',
    '{"event":"image","index":0,"warmup":true,"seconds":5.2,"path":"/a/0.png","sha256":"aaa"}',
    '{"event":"image","index":1,"warmup":false,"seconds":3.9,"path":"/a/1.png","sha256":"aaa"}',
    '{"event":"done","peak_memory_gb":41.2}',
  ].join("\n");

  test("versions, the load, each image and the peak memory", () => {
    const parsed = parseShimOutput(output);
    expect(parsed.mfluxVersion).toBe("0.19.2");
    expect(parsed.mlxVersion).toBe("0.31.2");
    expect(parsed.loadSeconds).toBe(31.5);
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]!.warmup).toBe(true);
    expect(parsed.peakMemoryGb).toBe(41.2);
    expect(parsed.error).toBeNull();
  });

  test("progress bars and warnings on the stream do not break it", () => {
    expect(parseShimOutput(`warning: something\n${output}\nDone.`).images).toHaveLength(2);
  });

  test("an error line is an error, not silence", () => {
    expect(parseShimOutput('{"event":"error","message":"RuntimeError: out of memory"}').error).toContain("out of memory");
  });

  test("nothing recognisable gives no images rather than a zero", () => {
    const parsed = parseShimOutput("Traceback (most recent call last):\n  File ...");
    expect(parsed.images).toEqual([]);
    expect(parsed.loadSeconds).toBeNull();
  });
});

// ------------------------------------------------------------------ planning

describe("planning the image grid", () => {
  test("every managed lane times every image model; manual lanes are left out", () => {
    const plan = planImageGrid(config(), settings());
    expect(plan.lanes.map((l) => l.lane.label)).toEqual(["One", "Two"]);
    expect(plan.totalCells).toBe(4);
    expect(plan.totalImages).toBe(8);
    // The language model in the config is not an image cell.
    expect(plan.lanes[0]!.cells.every((c) => c.dir !== "Text-4bit")).toBe(true);
  });

  test("a model this tool cannot drive is named, not silently dropped", () => {
    const plan = planImageGrid(
      config({ models: [{ name: "Mystery", dir: "Mystery", kind: "image", hfRepo: "vendor/Mystery" }] }),
      settings(),
    );
    expect(plan.totalCells).toBe(0);
    expect(plan.unsupported[0]!.modelName).toBe("Mystery");
  });

  test("settings default to 1024x1024 with a fixed seed, which is what makes the pictures comparable", () => {
    const s = imageSettingsFrom(config(), undefined);
    expect(s.width).toBe(1024);
    expect(s.height).toBe(1024);
    expect(s.seed).toBe(42);
    expect(s.warmupImages).toBe(1);
    expect(s.measuredImages).toBe(5);
    expect(s.steps).toBeNull();
  });
});

// ------------------------------------------------------------------ running

describe("a run against a fake machine", () => {
  test("times every image, keeps the load separate, and brings the pictures back", async () => {
    const machine = new FakeImageMachine();
    machine.secondsByLane = { "one.local": 4, "two.local": 9 };
    const runName = freshRun();
    const plan = planImageGrid(config(), settings());
    const events: ImageEvent[] = [];

    const cells = await runImageGrid({
      ping: async () => {},
      sleepFor: async () => {},
      plan,
      runName,
      emit: (e) => events.push(e),
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
    });

    expect(cells).toHaveLength(4);
    expect(cells.every((c) => c.status === "ok")).toBe(true);

    const fast = cells.find((c) => c.laneLabel === "One")!;
    const slow = cells.find((c) => c.laneLabel === "Two")!;
    expect(fast.secondsPerImage!.median).toBeLessThan(slow.secondsPerImage!.median);

    // The load is recorded and is NOT inside any image's seconds.
    expect(fast.loadSeconds).toBe(31.5);
    expect(fast.secondsPerImage!.high).toBeLessThan(31.5);
    expect(fast.peakMemoryGb).toBe(41.2);

    // The warm-up is thrown away.
    const records = await readImageRuns(runName);
    expect(records.filter((r) => r.warmup)).toHaveLength(4);
    expect(records.filter((r) => !r.warmup)).toHaveLength(8);
    expect(fast.imagesUsed).toBe(2);

    // Only measured images are copied back.
    expect(machine.fetched.every((p) => !p.endsWith("img_0.png"))).toBe(true);
    expect(cells.every((c) => c.sampleImage !== null)).toBe(true);
    expect(fast.mfluxVersion).toBe("0.19.2");
  }, 30_000);

  test("it cleans up only the folder it wrote, on the machine it wrote it on", async () => {
    const machine = new FakeImageMachine();
    const runName = freshRun();
    await runImageGrid({
      ping: async () => {},
      sleepFor: async () => {},
      plan: planImageGrid(config(), settings()),
      runName,
      emit: () => {},
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
    });
    const removals = machine.commands.filter((c) => c.startsWith("rm -rf"));
    expect(removals.length).toBeGreaterThan(0);
    for (const command of removals) {
      expect(command).toContain(`bench-images/${runName}/`);
      expect(command).not.toMatch(/rm -rf\s+'?~\/?'?\s*$/);
    }
  }, 30_000);

  test("one model failing does not stop the rest of the grid", async () => {
    const machine = new FakeImageMachine();
    machine.failFor = "FLUX.2-klein-4B";
    const runName = freshRun();

    const cells = await runImageGrid({
      ping: async () => {},
      sleepFor: async () => {},
      plan: planImageGrid(config(), settings()),
      runName,
      emit: () => {},
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
    });

    expect(cells.filter((c) => c.dir === "FLUX.2-klein-4B").every((c) => c.status === "failed")).toBe(true);
    expect(cells.filter((c) => c.dir === "Z-Image-Turbo").every((c) => c.status === "ok")).toBe(true);
  }, 30_000);

  test("a lane that cannot be reached fails that lane only", async () => {
    const machine = new FakeImageMachine();
    machine.reachable = false;
    const runName = freshRun();
    const notes: string[] = [];
    const cells = await runImageGrid({
      ping: async () => {},
      sleepFor: async () => {},
      plan: planImageGrid(config(), settings()),
      runName,
      emit: (e) => {
        if (e.type === "note") notes.push(e.message);
      },
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
    });
    // It tries to wake it first, then says plainly that it could not, and what
    // a person can do about it.
    expect(notes.join(" ")).toContain("it may be asleep; waking it, try 2 of 4");
    expect(notes.join(" ")).toContain("could not reach");
    expect(notes.join(" ")).toContain("press a key on it");
    expect(cells.every((c) => c.status === "not-run")).toBe(true);
  }, 30_000);

  test("resuming runs nothing when every cell already has its images", async () => {
    const machine = new FakeImageMachine();
    const runName = freshRun();
    const plan = planImageGrid(config(), settings());
    const opts = {
      plan,
      runName,
      emit: () => {},
      run: machine.run as never,
      sendShim: machine.sendShim as never,
      fetchFile: machine.fetchFile as never,
    };

    await runImageGrid(opts);
    const first = (await readImageRuns(runName)).length;
    machine.commands.length = 0;

    await runImageGrid(opts);
    expect((await readImageRuns(runName)).length).toBe(first);
    expect(machine.commands.filter((c) => c.includes("mflux_bench.py"))).toEqual([]);
  }, 45_000);

  test("owed cells are the ones short of their images", () => {
    const plan = planImageGrid(config(), settings());
    const done: ImageRunRecord[] = plan.lanes[0]!.cells.flatMap((cell) =>
      [1, 2].map((i) => ({ ...blank(cell), runIndex: i })),
    );
    const owed = imageCellsOwed(plan, done, false);
    expect(owed.every((c) => c.laneLabel === "Two")).toBe(true);
    expect(imageCellsOwed(plan, done, true)).toHaveLength(4);
  });
});

function blank(cell: ImageCell): ImageRunRecord {
  return {
    ts: "", runName: "r", laneLabel: cell.laneLabel, modelId: cell.modelId, modelName: cell.modelName,
    dir: cell.dir, kind: cell.kind, runIndex: 1, warmup: false, seconds: 4, loadSeconds: 30, seed: 42,
    width: 1024, height: 1024, steps: null, prompt: "p", remotePath: "", localFile: null,
    sha256: "aaa", checksumOf: "pixels", peakMemoryGb: null, mfluxVersion: null, mlxVersion: null, error: null,
  };
}

// ------------------------------------------------------------------ pictures

describe("the pictures are evidence, so disagreement is shown", () => {
  const cell: ImageCell = {
    laneLabel: "One", modelId: "m", modelName: "Z-Image Turbo", dir: "Z", kind: "z-image-turbo", measuredImages: 3,
  };

  test("images that differ inside one lane, from one seed, are called out", () => {
    const records = [
      { ...blank(cell), sha256: "aaa" },
      { ...blank(cell), sha256: "bbb" },
    ];
    const stat = summariseImageCell(cell, records);
    expect(stat.sha256).toBeNull();
    expect(stat.notes.join(" ")).toContain("not identical despite a fixed seed");
  });

  test("two lanes drawing different pictures is a warning, not a footnote", () => {
    const stats = summariseImageCells(
      [cell, { ...cell, laneLabel: "Two" }],
      [
        { ...blank(cell), sha256: "aaa" },
        { ...blank(cell), laneLabel: "Two", sha256: "zzz" },
      ],
    );
    const problems = checksumDisagreements(stats);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("did not draw the same picture");
  });

  test("lanes that agree produce no warning", () => {
    const stats = summariseImageCells(
      [cell, { ...cell, laneLabel: "Two" }],
      [
        { ...blank(cell), sha256: "aaa" },
        { ...blank(cell), laneLabel: "Two", sha256: "aaa" },
      ],
    );
    expect(checksumDisagreements(stats)).toEqual([]);
  });
});

// ------------------------------------------------------------------ board

describe("the board's image section", () => {
  const manifest: RunManifest = {
    runName: "r", startedAt: "", finishedAt: "", outputCap: 128, measuredRuns: 5, warmupRuns: 1, restSeconds: 30,
    temperature: 0, promptFile: "p", disableThinking: true,
    models: [{ name: "Z-Image Turbo", id: "m", kind: "image" }],
    lanes: [{ label: "One", managed: true }, { label: "Two", managed: true }],
    promptLengths: [], fingerprints: [], charsPerToken: {},
  };

  const stats = summariseImageCells(
    [
      { laneLabel: "One", modelId: "m", modelName: "Z-Image Turbo", dir: "Z", kind: "z-image-turbo", measuredImages: 2 },
      { laneLabel: "Two", modelId: "m", modelName: "Z-Image Turbo", dir: "Z", kind: "z-image-turbo", measuredImages: 2 },
    ],
    [
      { ...blank({ laneLabel: "One", modelId: "m", modelName: "Z-Image Turbo", dir: "Z", kind: "z-image-turbo", measuredImages: 2 }), seconds: 4, localFile: "images/one.png" },
      { ...blank({ laneLabel: "Two", modelId: "m", modelName: "Z-Image Turbo", dir: "Z", kind: "z-image-turbo", measuredImages: 2 }), laneLabel: "Two", seconds: 11, localFile: "images/two.png" },
    ],
  );

  test("one bar per lane, in seconds, with the picture beside it", () => {
    const board = buildBoard({
      manifest, cells: [], engine: [], power: [], images: stats,
      imageSettings: { prompt: "a cat", seed: 42, width: 1024, height: 1024, steps: null },
    });
    const model = board.images!.models[0]!;
    expect(model.bars.map((b) => b.laneLabel)).toEqual(["One", "Two"]);
    expect(model.bars[0]!.median).toBe(4);
    expect(model.bars[1]!.median).toBe(11);
    expect(model.bars[0]!.image).toBe("images/one.png");
    expect(model.ticks[0]).toBe(0);
    expect(model.max).toBeGreaterThanOrEqual(11);
    expect(board.images!.prompt).toBe("a cat");
    expect(board.images!.size).toBe("1024x1024");
  });

  test("a run with no pictures has no image section at all", () => {
    const board = buildBoard({ manifest, cells: [], engine: [], power: [] });
    expect(board.images).toBeNull();
  });

  test("lanes that drew different pictures warn at the top of the board", () => {
    const disagreeing = summariseImageCells(
      [
        { laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 1 },
        { laneLabel: "Two", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 1 },
      ],
      [
        { ...blank({ laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 1 }), sha256: "aaa" },
        { ...blank({ laneLabel: "Two", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 1 }), laneLabel: "Two", sha256: "zzz" },
      ],
    );
    const board = buildBoard({ manifest, cells: [], engine: [], power: [], images: disagreeing });
    expect(board.warnings.join(" ")).toContain("did not draw the same picture");
  });
});

describe("what the checksum is actually of", () => {
  // Found live: mflux embeds an iTXt and an eXIf chunk carrying, among other
  // things, how long the generation took. Two runs of the same seed therefore
  // wrote byte-different PNGs whose pixels were identical -- 0 of 1,048,576
  // pixels differed -- and hashing the file put a false "the lanes did not
  // draw the same picture" warning on the board.
  const cell: ImageCell = {
    laneLabel: "One", modelId: "m", modelName: "Z", dir: "Z", kind: "z-image-turbo", measuredImages: 2,
  };

  test("a pixel checksum that differs is reported as different PICTURES", () => {
    const stat = summariseImageCell(cell, [
      { ...blank(cell), sha256: "aaa", checksumOf: "pixels" },
      { ...blank(cell), sha256: "bbb", checksumOf: "pixels" },
    ]);
    expect(stat.notes.join(" ")).toContain("different pictures");
  });

  test("a file checksum that differs says so, rather than blaming the machine", () => {
    const stat = summariseImageCell(cell, [
      { ...blank(cell), sha256: "aaa", checksumOf: "file" },
      { ...blank(cell), sha256: "bbb", checksumOf: "file" },
    ]);
    expect(stat.notes.join(" ")).toContain("compared by bytes rather than pixels");
  });

  test("the parser carries which kind of checksum it was", () => {
    const pixels = parseShimOutput('{"event":"image","index":0,"warmup":false,"seconds":1,"path":"/a","sha256":"x","checksum_of":"pixels"}');
    expect(pixels.images[0]!.checksumOf).toBe("pixels");
    // An older shim that did not say defaults to the cautious reading.
    const older = parseShimOutput('{"event":"image","index":0,"warmup":false,"seconds":1,"path":"/a","sha256":"x"}');
    expect(older.images[0]!.checksumOf).toBe("file");
  });
});

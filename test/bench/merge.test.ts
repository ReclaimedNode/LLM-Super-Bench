/**
 * Putting two runs on one board.
 *
 * Two machines cannot safely write one run folder at the same time, so the
 * two-machine comparison is two invocations with two run names, and the board
 * that gets filmed is built from both afterwards. Everything here works on
 * real fixture run folders written with the same functions a real run uses, so
 * the read path is the read path.
 *
 * The two properties that matter: a merge that would compare unlike things is
 * refused with both values named, and neither source folder is ever written
 * to -- the sources are the only copy of a two-hour measurement.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { MergeError, checkMerge, mergeRuns, readMergeSource } from "../../src/bench/merge.ts";
import { buildBoard } from "../../src/bench/board.ts";
import { ensureImageManifest } from "../../src/bench/imagerunner.ts";
import type { ImageRunRecord } from "../../src/bench/image.ts";
import {
  FILES,
  appendRun,
  ensureRunDir,
  readCells,
  readManifest,
  readRuns,
  runDir,
  writeCells,
  writeEngine,
  writeManifest,
} from "../../src/bench/store.ts";
import type { BenchRunRecord, CellStat, EngineCell, RunManifest, Stat3 } from "../../src/bench/types.ts";

// ------------------------------------------------------------------ fixtures

const s = (median: number, low = median, high = median, n = 3): Stat3 => ({ median, low, high, n });

const names: string[] = [];
function freshName(what: string): string {
  const name = `mergetest-${what}-${process.pid}-${Date.now()}-${names.length}`;
  names.push(name);
  return name;
}
afterEach(async () => {
  await Promise.all(names.splice(0).map((n) => rm(runDir(n), { recursive: true, force: true })));
});

function cell(over: Partial<CellStat> = {}): CellStat {
  return {
    laneLabel: "Old machine",
    modelId: "~/bench-models/Big-4bit",
    modelKey: "Big-4bit",
    modelName: "Big model",
    nominalLabel: "4K",
    nominalTokens: 4096,
    torture: false,
    status: "ok",
    runsRecorded: 3,
    runsUsed: 3,
    failed: 0,
    cachedInvalid: 0,
    shortOutput: 0,
    readSpeed: s(600),
    writeSpeed: s(40),
    firstWordSec: s(6.8),
    totalSec: s(10),
    truePromptTokens: s(4010),
    trueOutputTokens: s(128),
    firstWordField: "content",
    fingerprints: ["mlx-0.32.2"],
    notes: [],
    ...over,
  };
}

function record(over: Partial<BenchRunRecord> = {}): BenchRunRecord {
  return {
    ts: "2026-09-20T10:00:00.000Z",
    runName: "unset",
    runId: "r1",
    laneLabel: "Old machine",
    modelId: "~/bench-models/Big-4bit",
    modelKey: "Big-4bit",
    modelName: "Big model",
    nominalLabel: "4K",
    nominalTokens: 4096,
    outputCap: 128,
    runIndex: 1,
    warmup: false,
    torture: false,
    firstResponseSec: 6.8,
    firstWordSec: 6.8,
    firstWordField: "content",
    lastWordSec: 9.9,
    totalSec: 10,
    promptTokens: 4010,
    outputTokens: 128,
    cachedTokens: 0,
    chunks: 128,
    promptChars: 16000,
    systemFingerprint: "mlx-0.32.2",
    thinkingDisabled: true,
    error: null,
    invalidReason: null,
    flags: [],
    ...over,
  };
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runName: "unset",
    startedAt: "2026-09-20T10:00:00.000Z",
    finishedAt: "2026-09-20T11:30:00.000Z",
    outputCap: 128,
    measuredRuns: 3,
    warmupRuns: 1,
    restSeconds: 30,
    temperature: 0,
    promptFile: "prompts/sample.txt",
    disableThinking: true,
    models: [{ name: "Big model", id: "~/bench-models/Big-4bit", dir: "Big-4bit", kind: "llm", quantization: "4-bit", fileSize: "65 GB" }],
    lanes: [{ label: "Old machine", managed: true }],
    promptLengths: [
      { label: "512", tokens: 512 },
      { label: "4K", tokens: 4096 },
    ],
    fingerprints: ["mlx-0.32.2"],
    charsPerToken: { "~/bench-models/Big-4bit": 3.62 },
    ...over,
  };
}

function engineCell(over: Partial<EngineCell> = {}): EngineCell {
  return {
    laneLabel: "Old machine",
    modelId: "~/bench-models/Big-4bit",
    nominalLabel: "4K",
    nominalTokens: 4096,
    generationTokens: 128,
    promptTps: s(700),
    generationTps: s(44),
    peakMemoryGb: 70.2,
    trials: 3,
    unavailable: null,
    raw: null,
    ...over,
  };
}

/** Writes a one-lane run folder the way a real run writes one. */
async function writeRun(
  name: string,
  opts: { lane: string; read: number; write: number; first: number; manifestOver?: Partial<RunManifest>; models?: RunManifest["models"] },
): Promise<void> {
  const { lane } = opts;
  await ensureRunDir(name);

  const cells = ["512", "4K"].map((label, i) =>
    cell({
      laneLabel: lane,
      nominalLabel: label,
      nominalTokens: label === "512" ? 512 : 4096,
      readSpeed: s(opts.read * (i === 0 ? 1.4 : 1)),
      writeSpeed: s(opts.write),
      firstWordSec: s(opts.first * (i === 0 ? 0.2 : 1)),
    }),
  );
  await writeCells(name, cells);

  for (const [i, c] of cells.entries()) {
    for (let run = 1; run <= 3; run++) {
      await appendRun(
        name,
        record({
          runName: name,
          laneLabel: lane,
          runId: `${name}-${i}-${run}`,
          nominalLabel: c.nominalLabel,
          nominalTokens: c.nominalTokens,
          runIndex: run,
        }),
      );
    }
  }

  await writeEngine(name, [engineCell({ laneLabel: lane })]);
  await writeManifest(name, {
    ...manifest(),
    runName: name,
    lanes: [{ label: lane, managed: true }],
    ...(opts.models ? { models: opts.models } : {}),
    ...opts.manifestOver,
  });
}

async function twoRuns(): Promise<{ a: string; b: string; into: string }> {
  const a = freshName("old");
  const b = freshName("new");
  const into = freshName("both");
  await writeRun(a, { lane: "Old machine", read: 600, write: 40, first: 6.8 });
  await writeRun(b, {
    lane: "New machine",
    read: 1500,
    write: 92,
    first: 2.6,
    manifestOver: { fingerprints: ["mlx-0.32.2-newer-os"], startedAt: "2026-09-20T10:05:00.000Z" },
  });
  return { a, b, into };
}

/** Every file in a run folder, by content, so "untouched" can be proven. */
async function snapshot(name: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of Object.values(FILES)) {
    const path = resolve(runDir(name), file);
    try {
      out[file] = await readFile(path, "utf8");
    } catch {
      out[file] = "<absent>";
    }
  }
  return out;
}

// ------------------------------------------------------------------ merging

describe("merging two runs", () => {
  test("the merged folder carries both lanes, both sets of cells and both logs", async () => {
    const { a, b, into } = await twoRuns();

    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    expect(result.manifest.lanes.map((l) => l.label)).toEqual(["Old machine", "New machine"]);
    expect(result.cells).toHaveLength(4);
    expect(result.runs).toHaveLength(12);
    expect(result.engine).toHaveLength(2);

    // And it is on disk, readable by everything that reads a run folder.
    const onDisk = await readCells(into);
    expect(onDisk).toHaveLength(4);
    expect(new Set(onDisk!.map((c) => c.laneLabel))).toEqual(new Set(["Old machine", "New machine"]));
    expect(await readRuns(into)).toHaveLength(12);

    // Each run line still says which invocation measured it.
    const runNames = new Set((await readRuns(into)).map((r) => r.runName));
    expect(runNames).toEqual(new Set([a, b]));

    // The manifest says where it came from, so the merge is not invisible.
    const merged = (await readManifest(into))!;
    expect(merged.runName).toBe(into);
    expect(merged.mergedFrom).toEqual([
      { runName: a, lanes: ["Old machine"] },
      { runName: b, lanes: ["New machine"] },
    ]);
    // The earliest start and, since both finished, the latest finish.
    expect(merged.startedAt).toBe("2026-09-20T10:00:00.000Z");
    expect(merged.finishedAt).toBe("2026-09-20T11:30:00.000Z");
    expect(merged.fingerprints).toEqual(["mlx-0.32.2", "mlx-0.32.2-newer-os"]);
  });

  test("neither source folder is written to", async () => {
    const { a, b, into } = await twoRuns();
    const before = { a: await snapshot(a), b: await snapshot(b) };
    const times = {
      a: (await stat(resolve(runDir(a), FILES.runs))).mtimeMs,
      b: (await stat(resolve(runDir(b), FILES.runs))).mtimeMs,
    };

    await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    expect(await snapshot(a)).toEqual(before.a);
    expect(await snapshot(b)).toEqual(before.b);
    expect((await stat(resolve(runDir(a), FILES.runs))).mtimeMs).toBe(times.a);
    expect((await stat(resolve(runDir(b), FILES.runs))).mtimeMs).toBe(times.b);
  });

  test("the board puts both machines under one model heading", async () => {
    const { a, b, into } = await twoRuns();
    await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    const board = buildBoard({
      manifest: (await readManifest(into))!,
      cells: (await readCells(into))!,
      engine: [],
      power: [],
    });

    expect(board.models).toHaveLength(1);
    const model = board.models[0]!;
    expect(model.rows.map((r) => r.nominalLabel)).toEqual(["512", "4K"]);
    for (const row of model.rows) {
      expect(row.reading.bars.map((bar) => bar.laneLabel)).toEqual(["Old machine", "New machine"]);
      expect(row.reading.bars.every((bar) => bar.median !== null)).toBe(true);
    }
  });

  test("report.md has both lanes as columns, and the headline ratio", async () => {
    const { a, b, into } = await twoRuns();
    await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    const report = await readFile(resolve(runDir(into), FILES.report), "utf8");

    expect(report).toContain("## Big model");
    expect(report).toContain("| Prompt | Old machine | New machine |");
    // The two machines are compared in words on the longest prompt they share.
    expect(report).toMatch(/At a 4K prompt: .*New machine.*(faster|×|x)/);
    // And the merge is stated where the settings are.
    expect(report).toContain("**Merged from:**");
    expect(report).toContain(a);
    expect(report).toContain(b);
  });

  test("a model only one machine ran gets a heading with one lane in it", async () => {
    const a = freshName("old");
    const b = freshName("new");
    const into = freshName("both");
    await writeRun(a, { lane: "Old machine", read: 600, write: 40, first: 6.8 });
    await writeRun(b, {
      lane: "New machine",
      read: 1500,
      write: 92,
      first: 2.6,
      models: [
        { name: "Big model", id: "~/bench-models/Big-4bit", dir: "Big-4bit", kind: "llm" },
        { name: "Huge model", id: "~/bench-models/Huge-4bit", dir: "Huge-4bit", kind: "llm" },
      ],
    });
    // One extra cell, on the new machine only.
    const extra = [...(await readCells(b))!, cell({ laneLabel: "New machine", modelId: "~/bench-models/Huge-4bit", modelKey: "Huge-4bit", modelName: "Huge model" })];
    await writeCells(b, extra);

    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    expect(result.manifest.models.map((m) => m.dir)).toEqual(["Big-4bit", "Huge-4bit"]);
    expect(result.differences.join(" ")).toContain("Not every model was run on both");

    const report = await readFile(resolve(runDir(into), FILES.report), "utf8");
    expect(report).toContain("## Huge model");
  });

  test("differences that are only facts about two machines are listed, not refused", async () => {
    const { a, b } = await twoRuns();
    const check = checkMerge(await readMergeSource(a), await readMergeSource(b));

    expect(check.refusals).toEqual([]);
    const said = check.differences.join("\n");
    expect(said).toContain("Old machine");
    expect(said).toContain("New machine");
    expect(said).toContain("Software versions differ");
    expect(said).toContain("Started at different times");
  });
});

// ------------------------------------------------------------------ refusing

describe("refusing a dishonest merge", () => {
  async function refusalFor(over: Partial<RunManifest>): Promise<string> {
    const a = freshName("old");
    const b = freshName("new");
    const into = freshName("both");
    await writeRun(a, { lane: "Old machine", read: 600, write: 40, first: 6.8 });
    await writeRun(b, { lane: "New machine", read: 1500, write: 92, first: 2.6, manifestOver: over });

    let message = "";
    try {
      await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
      throw new Error("the merge was allowed");
    } catch (err) {
      expect(err).toBeInstanceOf(MergeError);
      message = (err as MergeError).message;
    }

    // Nothing was written: no folder, and both sources still readable.
    expect(await Bun.file(resolve(runDir(into), FILES.manifest)).exists()).toBe(false);
    expect(await readCells(a)).toHaveLength(2);
    expect(await readCells(b)).toHaveLength(2);
    return message;
  }

  test("a different output cap", async () => {
    const message = await refusalFor({ outputCap: 256 });
    expect(message).toContain("output cap");
    // Both values, so the next step is obvious.
    expect(message).toContain("128 tokens");
    expect(message).toContain("256 tokens");
  });

  test("a different number of measured runs", async () => {
    expect(await refusalFor({ measuredRuns: 5 })).toContain("measured runs per cell");
  });

  test("a different number of warm-up runs", async () => {
    expect(await refusalFor({ warmupRuns: 0 })).toContain("warm-up runs");
  });

  test("different prompt lengths", async () => {
    const message = await refusalFor({ promptLengths: [{ label: "512", tokens: 512 }] });
    expect(message).toContain("prompt lengths");
    expect(message).toContain("4K (4096)");
  });

  test("a different prompt file", async () => {
    expect(await refusalFor({ promptFile: "prompts/other.txt" })).toContain("prompt source");
  });

  test("a different temperature", async () => {
    expect(await refusalFor({ temperature: 0.7 })).toContain("temperature");
  });

  test("thinking on in one and off in the other", async () => {
    const message = await refusalFor({ disableThinking: false });
    expect(message).toContain("thinking off");
    expect(message).toContain("thinking on");
  });

  test("two lanes with the same name", async () => {
    const a = freshName("old");
    const b = freshName("new");
    const into = freshName("both");
    await writeRun(a, { lane: "Studio", read: 600, write: 40, first: 6.8 });
    await writeRun(b, { lane: "Studio", read: 1500, write: 92, first: 2.6 });

    const failing = mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
    await expect(failing).rejects.toThrow(/lane called "Studio"/);
  });

  test("every refusal is reported at once, not one per attempt", async () => {
    const a = freshName("old");
    const b = freshName("new");
    await writeRun(a, { lane: "Studio", read: 600, write: 40, first: 6.8 });
    await writeRun(b, { lane: "Studio", read: 1500, write: 92, first: 2.6, manifestOver: { outputCap: 256, temperature: 0.7 } });

    const check = checkMerge(await readMergeSource(a), await readMergeSource(b));
    expect(check.refusals).toHaveLength(3);
  });

  test("an --into name that already exists, and a name that is one of the sources", async () => {
    const { a, b, into } = await twoRuns();
    await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    // A second merge into the same name would overwrite a board being filmed.
    const again = mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
    await expect(again).rejects.toThrow(/already exists/);

    const ontoSource = mergeRuns(await readMergeSource(a), await readMergeSource(b), a);
    await expect(ontoSource).rejects.toThrow(/must be a new name/);

    // The first merge is intact.
    expect(await readCells(into)).toHaveLength(4);
  });

  test("a run that is not there says so by name", async () => {
    const missing = readMergeSource("mergetest-no-such-run");
    await expect(missing).rejects.toThrow(/No run called "mergetest-no-such-run"/);
  });

  test("a run with no cells yet is not something to put on a board", async () => {
    const a = freshName("old");
    const b = freshName("empty");
    const into = freshName("both");
    await writeRun(a, { lane: "Old machine", read: 600, write: 40, first: 6.8 });
    await ensureRunDir(b);
    await writeManifest(b, { ...manifest(), runName: b, lanes: [{ label: "New machine", managed: true }] });

    const failing = mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
    await expect(failing).rejects.toThrow(/has no cells yet/);
  });
});

// ------------------------------------------------------------------ carrying media

describe("pictures and clips", () => {
  test("image cells, image runs and the pictures themselves come across", async () => {
    const { a, b, into } = await twoRuns();

    for (const [name, lane] of [
      [a, "Old machine"],
      [b, "New machine"],
    ] as const) {
      await Bun.write(
        resolve(runDir(name), "imagecells.json"),
        JSON.stringify([{ laneLabel: lane, modelId: "FLUX", modelName: "FLUX", sampleImage: `images/${lane}__FLUX__0.png` }], null, 2),
      );
      await Bun.write(resolve(runDir(name), "images.jsonl"), JSON.stringify({ laneLabel: lane, seconds: 7 }) + "\n");
      await Bun.write(resolve(runDir(name), `images/${lane}__FLUX__0.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    }

    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    const cells = (await Bun.file(resolve(runDir(into), "imagecells.json")).json()) as { laneLabel: string }[];
    expect(cells.map((c) => c.laneLabel)).toEqual(["Old machine", "New machine"]);
    expect((await Bun.file(resolve(runDir(into), "images.jsonl")).text()).trim().split("\n")).toHaveLength(2);
    // The picture the board shows is a real file in the merged folder.
    expect(await Bun.file(resolve(runDir(into), "images/Old machine__FLUX__0.png")).exists()).toBe(true);
    expect(await Bun.file(resolve(runDir(into), "images/New machine__FLUX__0.png")).exists()).toBe(true);
    expect(result.carried.join(" ")).toContain("2 picture(s)");
  });

  test("a merge with no pictures carries none and says nothing about them", async () => {
    const { a, b, into } = await twoRuns();
    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
    expect(result.carried).toEqual([]);
    expect(await Bun.file(resolve(runDir(into), "imagecells.json")).exists()).toBe(false);
  });
});

// ------------------------------------------------------------------ image runs

describe("a run of pictures alone", () => {
  function imageRecord(over: Partial<ImageRunRecord> = {}): ImageRunRecord {
    return {
      ts: "2026-09-20T12:00:00.000Z",
      runName: "unset",
      laneLabel: "Old machine",
      modelId: "~/bench-models/FLUX.2-klein-4B",
      modelName: "FLUX.2 klein 4B",
      dir: "FLUX.2-klein-4B",
      kind: "flux2-klein",
      runIndex: 1,
      warmup: false,
      seconds: 7,
      loadSeconds: 0.5,
      seed: 42,
      width: 1024,
      height: 1024,
      steps: null,
      prompt: "a cutaway illustration of a desktop computer",
      remotePath: "/tmp/x.png",
      localFile: "images/Old machine__FLUX.2-klein-4B__1.png",
      sha256: "aaaa",
      checksumOf: "pixels",
      peakMemoryGb: 22.5,
      mfluxVersion: "0.19.2",
      mlxVersion: "0.32.2",
      error: null,
      ...over,
    };
  }

  /** An image-only run folder: pictures and their cells, and no manifest. */
  async function writeImageRun(name: string, lane: string, seconds: number, over: Partial<ImageRunRecord> = {}): Promise<void> {
    await ensureRunDir(name);
    const records = [
      imageRecord({ runName: name, laneLabel: lane, warmup: true, runIndex: 0, seconds: seconds * 3, ...over }),
      ...[1, 2, 3].map((i) =>
        imageRecord({ runName: name, laneLabel: lane, runIndex: i, seconds, ts: `2026-09-20T12:0${i}:00.000Z`, ...over }),
      ),
    ];
    await Bun.write(resolve(runDir(name), "images.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    await Bun.write(
      resolve(runDir(name), "imagecells.json"),
      JSON.stringify(
        [
          {
            laneLabel: lane,
            modelId: "~/bench-models/FLUX.2-klein-4B",
            modelName: "FLUX.2 klein 4B",
            dir: "FLUX.2-klein-4B",
            kind: "flux2-klein",
            status: "ok",
            imagesRecorded: 3,
            imagesUsed: 3,
            secondsPerImage: { median: seconds, low: seconds, high: seconds, n: 3 },
            loadSeconds: 0.5,
            peakMemoryGb: 22.5,
            sha256: over.sha256 ?? "aaaa",
            sampleImage: `images/${lane}__FLUX.2-klein-4B__1.png`,
            mfluxVersion: "0.19.2",
            notes: [],
          },
        ],
        null,
        2,
      ),
    );
    await Bun.write(resolve(runDir(name), `images/${lane}__FLUX.2-klein-4B__1.png`), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }

  test("describes itself with a manifest derived from what it recorded", async () => {
    const name = freshName("pics");
    await writeImageRun(name, "Old machine", 7);

    const manifest = (await ensureImageManifest(name))!;

    expect(manifest.runName).toBe(name);
    expect(manifest.measured).toEqual(["image"]);
    expect(manifest.lanes).toEqual([{ label: "Old machine", managed: true }]);
    expect(manifest.models.map((m) => m.dir)).toEqual(["FLUX.2-klein-4B"]);
    expect(manifest.models[0]!.kind).toBe("image");
    // Three measured after one discarded warm-up, which is true of the images.
    expect(manifest.measuredRuns).toBe(3);
    expect(manifest.warmupRuns).toBe(1);
    // Times come from the records, not from the clock.
    expect(manifest.startedAt).toBe("2026-09-20T12:00:00.000Z");
    expect(manifest.fingerprints).toEqual(["mflux 0.19.2, mlx 0.32.2"]);
    // Nothing invented for the language grid.
    expect(manifest.promptLengths).toEqual([]);
    expect(manifest.charsPerToken).toEqual({});
    // And it is on disk for the board to read.
    expect((await readManifest(name))!.measured).toEqual(["image"]);
  });

  test("a folder that already holds a language grid keeps its settings and gains the pictures", async () => {
    const name = freshName("both-kinds");
    await writeRun(name, { lane: "Old machine", read: 600, write: 40, first: 6.8 });
    await writeImageRun(name, "Old machine", 7);

    const manifest = (await ensureImageManifest(name))!;

    expect(manifest.measured).toEqual(["llm", "image"]);
    // The language settings are untouched -- they were real.
    expect(manifest.outputCap).toBe(128);
    expect(manifest.promptFile).toBe("prompts/sample.txt");
    expect(manifest.promptLengths).toHaveLength(2);
    // And the image model is now listed beside the language one.
    expect(manifest.models.map((m) => m.dir)).toEqual(["Big-4bit", "FLUX.2-klein-4B"]);
    expect(manifest.lanes).toEqual([{ label: "Old machine", managed: true }]);
  });

  test("reading an image run for a merge does not write a manifest into it", async () => {
    const a = freshName("pics-old");
    const b = freshName("pics-new");
    const into = freshName("pics-both");
    await writeImageRun(a, "Old machine", 7);
    await writeImageRun(b, "New machine", 1.8);

    await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    // The derived manifest exists only in the merged folder. A source that
    // arrived without one still has none: reading is not writing.
    expect(await Bun.file(resolve(runDir(a), FILES.manifest)).exists()).toBe(false);
    expect(await Bun.file(resolve(runDir(b), FILES.manifest)).exists()).toBe(false);
    expect(await Bun.file(resolve(runDir(into), FILES.manifest)).exists()).toBe(true);
  });

  test("two image runs merge onto one board, with no report of settings nobody used", async () => {
    const a = freshName("pics-old");
    const b = freshName("pics-new");
    const into = freshName("pics-both");
    await writeImageRun(a, "Old machine", 7);
    await writeImageRun(b, "New machine", 1.8);

    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);

    expect(result.manifest.lanes.map((l) => l.label)).toEqual(["Old machine", "New machine"]);
    expect(result.manifest.measured).toEqual(["image"]);
    expect(result.carried.join(" ")).toContain("2 image cell(s)");
    expect(result.carried.join(" ")).toContain("2 picture(s)");

    // The board draws it: one image model, a bar per machine.
    const board = buildBoard({
      manifest: (await readManifest(into))!,
      cells: [],
      engine: [],
      power: [],
      images: (await Bun.file(resolve(runDir(into), "imagecells.json")).json()) as never,
    });
    expect(board.images!.models).toHaveLength(1);
    expect(board.images!.models[0]!.bars.map((bar) => bar.laneLabel)).toEqual(["Old machine", "New machine"]);
    expect(board.images!.models[0]!.bars.map((bar) => bar.median)).toEqual([7, 1.8]);
    expect(board.footer.measured).toEqual(["image"]);

    // No report.md: its tables are the language grid's, and there was none.
    expect(await Bun.file(resolve(runDir(into), FILES.report)).exists()).toBe(false);
  });

  test("pictures drawn from different settings are refused, seed and size and prompt alike", async () => {
    for (const [what, over] of [
      ["seed", { seed: 7 }],
      ["size", { width: 512, height: 512 }],
      ["prompt", { prompt: "something else entirely" }],
      ["steps", { steps: 12 }],
    ] as const) {
      const a = freshName(`pics-a-${what}`);
      const b = freshName(`pics-b-${what}`);
      const into = freshName(`pics-into-${what}`);
      await writeImageRun(a, "Old machine", 7);
      await writeImageRun(b, "New machine", 1.8, over);

      const failing = mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
      await expect(failing).rejects.toThrow(/would not be measuring the same thing/);
      expect(await Bun.file(resolve(runDir(into), FILES.manifest)).exists()).toBe(false);
    }
  });

  test("two machines that drew different pictures still merge — the board says so, it is a finding", async () => {
    const a = freshName("pics-old");
    const b = freshName("pics-new");
    const into = freshName("pics-both");
    await writeImageRun(a, "Old machine", 7);
    await writeImageRun(b, "New machine", 1.8, { sha256: "bbbb" });

    const result = await mergeRuns(await readMergeSource(a), await readMergeSource(b), into);
    expect(result.intoName).toBe(into);

    const board = buildBoard({
      manifest: (await readManifest(into))!,
      cells: [],
      engine: [],
      power: [],
      images: (await Bun.file(resolve(runDir(into), "imagecells.json")).json()) as never,
    });
    expect(board.images!.models[0]!.warnings.join(" ")).toContain("did not draw the same picture");
  });
});

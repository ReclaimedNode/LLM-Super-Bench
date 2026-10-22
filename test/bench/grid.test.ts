/**
 * The grid, end to end, against mock lanes.
 *
 * These are the tests that would have caught a runner that looked right and
 * measured nothing: they run a real (small) grid over real HTTP against mock
 * servers whose first-word delay grows with the prompt, and then check the
 * files on disk rather than the runner's own opinion of what it did.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { validateBenchConfig } from "../../src/bench/config.ts";
import { buildGrid, resumePlan } from "../../src/bench/plan.ts";
import { runGrid } from "../../src/bench/runner.ts";
import type { BenchEvent } from "../../src/bench/runner.ts";
import { readCells, readManifest, readRuns, runDir } from "../../src/bench/store.ts";
import type { MockLaneOptions } from "../../src/mock.ts";
import { startMockLane } from "../../src/mock.ts";

const servers: Server[] = [];
const runNames: string[] = [];
const SOURCE = "the quick brown fox jumps over the lazy dog. ".repeat(4000);

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({
    port: 0,
    firstWordDelayMs: 20,
    chunkIntervalMs: 1,
    chunks: 400,
    includeUsage: true,
    charsPerToken: 4,
    ...over,
  });
  servers.push(server);
  return server;
}

let counter = 0;
function freshRunName(): string {
  const name = `test-${process.pid}-${Date.now()}-${counter++}`;
  runNames.push(name);
  return name;
}

function configFor(lanes: { label: string; server: Server }[], over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    outputCap: 40,
    measuredRuns: 2,
    warmupRuns: 1,
    restSeconds: 0,
    charsPerToken: 4,
    engineBenchmark: false,
    requestTimeoutMs: 30_000,
    serverStartTimeoutMs: 20_000,
    promptLengths: [
      { label: "512", tokens: 512 },
      { label: "4K", tokens: 4096 },
    ],
    models: [{ name: "Mock model", id: "mock-model", quantization: "4-bit", fileSize: "0 GB" }],
    lanes: lanes.map((l) => ({ label: l.label, baseUrl: `http://localhost:${l.server.port}` })),
    ...over,
  });
}

async function run(config: ReturnType<typeof validateBenchConfig>, runName: string) {
  const events: BenchEvent[] = [];
  const cells = await runGrid({
    config,
    runName,
    sourceText: SOURCE,
    emit: (e) => events.push(e),
  });
  return { cells, events, records: await readRuns(runName) };
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await Promise.all(runNames.splice(0).map((name) => rm(runDir(name), { recursive: true, force: true })));
});

describe("a small grid, end to end", () => {
  test("measures every cell and lands the numbers on disk", async () => {
    // Lane A is the faster machine on both measures, and both lanes' prefill
    // grows with the prompt, as real prefill does.
    const fast = mock({ firstWordDelayMs: 30, chunkIntervalMs: 1, firstWordPerKCharMs: 8 });
    const slow = mock({ firstWordDelayMs: 90, chunkIntervalMs: 4, firstWordPerKCharMs: 24 });
    const runName = freshRunName();

    const { cells, records } = await run(
      configFor([
        { label: "Lane A", server: fast },
        { label: "Lane B", server: slow },
      ]),
      runName,
    );

    // 2 lanes x 1 model x 2 lengths = 4 cells; 2 measured + 1 warm-up each.
    expect(cells).toHaveLength(4);
    expect(records.filter((r) => !r.warmup)).toHaveLength(8);
    expect(records.filter((r) => r.warmup)).toHaveLength(4);
    expect(cells.every((c) => c.status === "ok")).toBe(true);
    expect(cells.every((c) => c.runsUsed === 2)).toBe(true);

    // Every run carries the true counts, the cache count and the version.
    for (const r of records) {
      expect(r.promptTokens).toBeGreaterThan(0);
      expect(r.outputTokens).toBeGreaterThan(0);
      expect(r.cachedTokens).toBe(0);
      expect(r.systemFingerprint).toContain("mock");
      expect(r.error).toBeNull();
    }

    // The faster machine is faster on both measures, in every cell.
    for (const label of ["512", "4K"]) {
      const a = cells.find((c) => c.laneLabel === "Lane A" && c.nominalLabel === label)!;
      const b = cells.find((c) => c.laneLabel === "Lane B" && c.nominalLabel === label)!;
      expect(a.readSpeed!.median).toBeGreaterThan(b.readSpeed!.median);
      expect(a.writeSpeed!.median).toBeGreaterThan(b.writeSpeed!.median);
      expect(a.firstWordSec!.median).toBeLessThan(b.firstWordSec!.median);
    }

    // The first-word chart has a real slope: a bigger prompt waits longer.
    const small = cells.find((c) => c.laneLabel === "Lane A" && c.nominalLabel === "512")!;
    const big = cells.find((c) => c.laneLabel === "Lane A" && c.nominalLabel === "4K")!;
    expect(big.firstWordSec!.median).toBeGreaterThan(small.firstWordSec!.median * 1.5);

    // cells.json and the manifest are on disk, not just in memory.
    const onDisk = await readCells(runName);
    expect(onDisk).toHaveLength(4);
    const manifest = await readManifest(runName);
    expect(manifest!.finishedAt).not.toBeNull();
    expect(manifest!.outputCap).toBe(40);
    expect(manifest!.fingerprints.length).toBeGreaterThan(0);
    expect(manifest!.charsPerToken["mock-model"]).toBeGreaterThan(0);
  }, 60_000);

  test("the prompt for each cell is close to the size on its label", async () => {
    const lane = mock();
    const runName = freshRunName();
    const { records } = await run(configFor([{ label: "Lane A", server: lane }]), runName);

    for (const r of records.filter((x) => !x.warmup)) {
      const error = Math.abs(r.promptTokens! - r.nominalTokens) / r.nominalTokens;
      expect(error).toBeLessThan(0.05);
    }
  }, 60_000);

  test("every prompt is unique, so no cache can match one", async () => {
    const lane = mock();
    const runName = freshRunName();
    const { records } = await run(configFor([{ label: "Lane A", server: lane }]), runName);
    const ids = records.map((r) => r.runId);
    expect(new Set(ids).size).toBe(ids.length);
  }, 60_000);

  test("a run the server served from cache is excluded, and the cell says so", async () => {
    // The mock is told to claim a cache hit on every request.
    const cheating = mock({ cachedTokens: 400 });
    const runName = freshRunName();
    const { cells, records } = await run(configFor([{ label: "Lane A", server: cheating }]), runName);

    expect(records.filter((r) => !r.warmup).every((r) => r.cachedTokens === 400)).toBe(true);
    for (const cell of cells) {
      expect(cell.status).toBe("no-valid-runs");
      expect(cell.runsUsed).toBe(0);
      expect(cell.cachedInvalid).toBe(2);
      expect(cell.readSpeed).toBeNull();
      expect(cell.notes.join(" ")).toContain("cache");
    }
  }, 60_000);

  test("a run that stopped short of the cap is excluded and counted", async () => {
    // Output cap is 40, and this lane stops after 20 chunks (23 tokens).
    const early = mock({ stopAfterChunks: 20 });
    const runName = freshRunName();
    const { cells, records } = await run(configFor([{ label: "Lane A", server: early }]), runName);

    expect(records.filter((r) => !r.warmup).every((r) => r.outputTokens! < 40 * 0.9)).toBe(true);
    for (const cell of cells) {
      expect(cell.shortOutput).toBe(2);
      expect(cell.runsUsed).toBe(0);
      expect(cell.status).toBe("no-valid-runs");
      expect(cell.notes.join(" ")).toContain("cap");
    }
  }, 60_000);

  test("one dead lane never stops the other", async () => {
    const alive = mock();
    const dead = mock({ failWithStatus: 500 });
    const runName = freshRunName();

    const { cells } = await run(
      configFor([
        { label: "Good", server: alive },
        { label: "Bad", server: dead },
      ]),
      runName,
    );

    const good = cells.filter((c) => c.laneLabel === "Good");
    const bad = cells.filter((c) => c.laneLabel === "Bad");
    expect(good.every((c) => c.status === "ok")).toBe(true);
    expect(bad.every((c) => c.status === "failed")).toBe(true);
    expect(bad.every((c) => c.failed === 2)).toBe(true);
  }, 60_000);

  test("a cell whose model the endpoint does not have fails that lane, on disk, with the reason", async () => {
    const wrong = mock({ modelId: "some-other-model" });
    const right = mock();
    const runName = freshRunName();

    const { cells, records } = await run(
      configFor(
        [
          { label: "Wrong", server: wrong },
          { label: "Right", server: right },
        ],
        { serverStartTimeoutMs: 4000 },
      ),
      runName,
    );

    expect(cells.filter((c) => c.laneLabel === "Right").every((c) => c.status === "ok")).toBe(true);

    // Never sent, because an unknown `model` makes mlx_lm.server go to the
    // internet looking for something to download.
    const wrongCells = cells.filter((c) => c.laneLabel === "Wrong");
    expect(wrongCells.every((c) => c.status === "failed")).toBe(true);

    // And the reason is in the log, not only in a message on a page nobody was
    // watching. "not-run" would read the same as "we never asked for it".
    const wrongRuns = records.filter((r) => r.laneLabel === "Wrong");
    expect(wrongRuns.length).toBeGreaterThan(0);
    expect(wrongRuns.every((r) => r.error === "the endpoint never listed the model")).toBe(true);
  }, 60_000);

  test("a lane matches the model under the absolute path the server expanded it to", async () => {
    // The shape that broke the first live run: the config asks for `~/...` and
    // the endpoint lists it as `/home/.../...`, alongside another model.
    const lane = mock({ modelId: "/home/someone/models/mlx-community/Some-Model-4bit" });
    const runName = freshRunName();

    const config = configFor([{ label: "Lane A", server: lane }], {
      models: [{ name: "Some Model", id: "~/models/mlx-community/Some-Model-4bit" }],
      promptLengths: [{ label: "512", tokens: 512 }],
    });

    const { cells, records } = await run(config, runName);
    expect(cells.every((c) => c.status === "ok")).toBe(true);
    // The RECORD keeps the config's id, so resume and the board line up.
    expect(records.every((r) => r.modelId === "~/models/mlx-community/Some-Model-4bit")).toBe(true);
  }, 60_000);

  test("resuming the same grid runs nothing and changes nothing", async () => {
    const lane = mock();
    const runName = freshRunName();
    const config = configFor([{ label: "Lane A", server: lane }]);

    const first = await run(config, runName);
    expect(first.records.filter((r) => !r.warmup)).toHaveLength(4);

    const second = await run(config, runName);
    expect(second.records).toHaveLength(first.records.length);
    expect(second.records.map((r) => r.runId)).toEqual(first.records.map((r) => r.runId));

    // And the plan agrees there is nothing left to do.
    const grid = buildGrid(config);
    const decisions = resumePlan(grid.lanes[0]!.cells, second.records, false);
    expect(decisions.every((d) => d.skip)).toBe(true);
  }, 90_000);

  test("a half-finished grid resumes and finishes the rest", async () => {
    const lane = mock();
    const runName = freshRunName();
    const config = configFor([{ label: "Lane A", server: lane }]);

    // Pretend a kill happened after the first cell by running a one-length grid.
    const partial = validateBenchConfig({
      ...JSON.parse(JSON.stringify({ ...config, lanes: config.lanes })),
      promptLengths: [{ label: "512", tokens: 512 }],
    });
    await run(partial, runName);
    expect((await readRuns(runName)).filter((r) => !r.warmup)).toHaveLength(2);

    const { records, cells } = await run(config, runName);
    expect(records.filter((r) => !r.warmup)).toHaveLength(4);
    // The 512 cell was not re-run: still exactly two measured runs.
    expect(records.filter((r) => !r.warmup && r.nominalLabel === "512")).toHaveLength(2);
    expect(cells.every((c) => c.status === "ok")).toBe(true);
  }, 90_000);

  test("a torture cell runs once and does not stop the grid when it fails", async () => {
    const lane = mock();
    const runName = freshRunName();
    const config = configFor([{ label: "Lane A", server: lane }], {
      torture: [{ lane: "Lane A", model: "mock-model", tokens: 20000, label: "20K" }],
    });

    const { cells, records } = await run(config, runName);
    const torture = cells.find((c) => c.torture)!;
    expect(torture.nominalLabel).toBe("20K");
    expect(torture.runsRecorded).toBe(1);
    expect(records.filter((r) => r.torture && !r.warmup)).toHaveLength(1);
    expect(cells.filter((c) => !c.torture).every((c) => c.status === "ok")).toBe(true);
  }, 90_000);

  test("each finished run is on disk before anything else happens", async () => {
    // The contract is that killing the process loses at most the run in flight.
    // The proof is not that the file is complete at the end -- it is that the
    // file ALREADY holds run N at the moment run N is announced, checked here
    // with a synchronous read so nothing can have been flushed in between.
    const lane = mock({ firstWordDelayMs: 40 });
    const runName = freshRunName();
    const logPath = join(runDir(runName), "runs.jsonl");
    const countsWhenAnnounced: { announced: number; onDisk: number }[] = [];
    let announced = 0;

    await runGrid({
      config: configFor([{ label: "Lane A", server: lane }]),
      runName,
      sourceText: SOURCE,
      emit: (event) => {
        if (event.type !== "run") return;
        announced += 1;
        const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
        countsWhenAnnounced.push({ announced, onDisk: lines.length });
      },
    });

    expect(countsWhenAnnounced.length).toBeGreaterThan(0);
    for (const { announced: n, onDisk } of countsWhenAnnounced) {
      expect(onDisk).toBe(n);
    }
    expect((await readRuns(runName)).length).toBe(announced);
  }, 60_000);

  test("the events tell the page the same story the files tell", async () => {
    const lane = mock();
    const runName = freshRunName();
    const { events, cells } = await run(configFor([{ label: "Lane A", server: lane }]), runName);

    const start = events.find((e) => e.type === "bench-start");
    expect(start).toBeDefined();
    expect(events.at(-1)!.type).toBe("bench-done");
    expect(events.filter((e) => e.type === "run")).toHaveLength(6); // 4 measured + 2 warm-ups
    expect(events.filter((e) => e.type === "cell")).toHaveLength(cells.length);

    // The lane reached "done", and reported every cell on the way.
    const laneEvents = events.filter((e) => e.type === "lane");
    expect(laneEvents.at(-1)).toMatchObject({ lane: { phase: "done" } });
  }, 60_000);
});

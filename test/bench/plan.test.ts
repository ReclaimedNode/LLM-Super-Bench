import { describe, expect, test } from "bun:test";
import { knownIdsFor, modelKeyIndex, modelKeyOf, validateBenchConfig } from "../../src/bench/config.ts";
import {
  buildGrid,
  cellKey,
  completedRunsByCell,
  estimateGridSeconds,
  estimateLaneSeconds,
  formatDuration,
  keyOfCell,
  resumePlan,
} from "../../src/bench/plan.ts";
import type { BenchRunRecord, Cell } from "../../src/bench/types.ts";

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    measuredRuns: 3,
    warmupRuns: 1,
    restSeconds: 30,
    outputCap: 128,
    promptLengths: [
      { label: "512", tokens: 512 },
      { label: "4K", tokens: 4096 },
    ],
    models: [
      { name: "Small", id: "small" },
      { name: "Big", id: "big" },
    ],
    lanes: [
      { label: "Lane A", baseUrl: "http://localhost:9001" },
      { label: "Lane B", baseUrl: "http://localhost:9002" },
    ],
    ...over,
  });
}

function record(over: Partial<BenchRunRecord>): BenchRunRecord {
  return {
    ts: "2026-09-19T00:00:00.000Z",
    runName: "r",
    runId: "run-1",
    laneLabel: "Lane A",
    modelId: "small",
    modelName: "Small",
    nominalLabel: "512",
    nominalTokens: 512,
    outputCap: 128,
    runIndex: 1,
    warmup: false,
    torture: false,
    firstResponseSec: 0.1,
    firstWordSec: 0.2,
    firstWordField: "content",
    lastWordSec: 3.2,
    totalSec: 3.3,
    promptTokens: 512,
    outputTokens: 128,
    cachedTokens: 0,
    chunks: 128,
    promptChars: 2048,
    systemFingerprint: "fp",
    thinkingDisabled: true,
    error: null,
    invalidReason: null,
    flags: [],
    ...over,
  };
}

describe("building the grid", () => {
  test("is every lane times every model times every prompt length", () => {
    const grid = buildGrid(config());
    expect(grid.lanes).toHaveLength(2);
    expect(grid.totalCells).toBe(2 * 2 * 2);
    expect(grid.totalRuns).toBe(8 * 3);

    // Grouped by model, and shortest prompt first inside each model: a grid
    // that gets killed early still has its cheap cells finished.
    const laneA = grid.lanes[0]!.cells.map((c) => `${c.modelId}/${c.nominalLabel}`);
    expect(laneA).toEqual(["small/512", "small/4K", "big/512", "big/4K"]);
  });

  test("a lane can be restricted to a subset of the models", () => {
    const grid = buildGrid(
      config({
        lanes: [
          { label: "Lane A", baseUrl: "http://localhost:9001" },
          { label: "Lane B", baseUrl: "http://localhost:9002", models: ["small"] },
        ],
      }),
    );
    expect(grid.lanes[0]!.cells).toHaveLength(4);
    expect(grid.lanes[1]!.cells).toHaveLength(2);
    expect(grid.lanes[1]!.cells.every((c) => c.modelId === "small")).toBe(true);
  });

  test("a torture cell gets one measured run and rides on the end of its model's block", () => {
    const grid = buildGrid(
      config({ torture: [{ lane: "Lane A", model: "small", tokens: 100000, label: "100K" }] }),
    );
    const laneA = grid.lanes[0]!.cells;
    const torture = laneA.find((c) => c.torture)!;
    expect(torture.measuredRuns).toBe(1);
    expect(torture.nominalTokens).toBe(100000);
    // Immediately after that model's own cells, while its server is still up.
    expect(laneA.map((c) => c.nominalLabel)).toEqual(["512", "4K", "100K", "512", "4K"]);
    expect(laneA[2]!.modelId).toBe("small");
    expect(grid.lanes[1]!.cells.some((c) => c.torture)).toBe(false);
  });

  test("a cell key survives a label that contains the separator", () => {
    expect(cellKey("A|B", "m", "512")).not.toBe(cellKey("A", "B|m", "512"));
  });
});

describe("resuming", () => {
  const cells: Cell[] = buildGrid(config()).lanes[0]!.cells;

  test("a cell with all its runs on disk is skipped", () => {
    const done = [record({ runIndex: 1 }), record({ runIndex: 2 }), record({ runIndex: 3 })];
    const plan = resumePlan(cells, done, false);
    const first = plan.find((d) => d.cell.nominalLabel === "512" && d.cell.modelId === "small")!;
    expect(first.done).toBe(3);
    expect(first.remaining).toBe(0);
    expect(first.skip).toBe(true);

    // Everything else is still owed in full.
    expect(plan.filter((d) => d.skip)).toHaveLength(1);
    expect(plan.filter((d) => !d.skip).every((d) => d.remaining === 3)).toBe(true);
  });

  test("a half-finished cell is owed only the runs it is missing", () => {
    const plan = resumePlan(cells, [record({ runIndex: 1 })], false);
    const first = plan[0]!;
    expect(first.done).toBe(1);
    expect(first.remaining).toBe(2);
    expect(first.skip).toBe(false);
  });

  test("warm-ups never count toward a cell being finished", () => {
    const warmOnly = [record({ runIndex: 0, warmup: true }), record({ runIndex: 0, warmup: true })];
    expect(completedRunsByCell(warmOnly).size).toBe(0);
    expect(resumePlan(cells, warmOnly, false)[0]!.remaining).toBe(3);
  });

  test("a failed or excluded run still counts as an attempt", () => {
    // Otherwise a cell that a machine cannot do would loop forever, and the
    // sample would change after the fact every time the grid was resumed.
    const attempts = [
      record({ runIndex: 1, error: "HTTP 500" }),
      record({ runIndex: 2, cachedTokens: 400, invalidReason: "cached" }),
      record({ runIndex: 3 }),
    ];
    expect(resumePlan(cells, attempts, false)[0]!.skip).toBe(true);
  });

  test("--force ignores what is on disk", () => {
    const done = [record({ runIndex: 1 }), record({ runIndex: 2 }), record({ runIndex: 3 })];
    const plan = resumePlan(cells, done, true);
    expect(plan.every((d) => !d.skip)).toBe(true);
    expect(plan[0]!.remaining).toBe(3);
  });

  test("records from another lane or another prompt length do not satisfy a cell", () => {
    const elsewhere = [
      record({ laneLabel: "Lane B" }),
      record({ nominalLabel: "4K" }),
      record({ modelId: "big" }),
    ];
    expect(resumePlan(cells, elsewhere, false)[0]!.done).toBe(0);
  });
});

describe("the time estimate", () => {
  const cfg = config();
  const grid = buildGrid(cfg);

  test("skipped cells cost nothing", () => {
    const all = resumePlan(grid.lanes[0]!.cells, [], false);
    const full = estimateLaneSeconds(grid.lanes[0]!, all, cfg);

    const done = grid.lanes[0]!.cells.flatMap((cell) =>
      [1, 2, 3].map((i) =>
        record({
          laneLabel: cell.laneLabel,
          modelId: cell.modelId,
          nominalLabel: cell.nominalLabel,
          runIndex: i,
        }),
      ),
    );
    expect(estimateLaneSeconds(grid.lanes[0]!, resumePlan(grid.lanes[0]!.cells, done, false), cfg)).toBe(0);
    expect(full).toBeGreaterThan(0);
  });

  test("the grid takes as long as its slowest lane, not the sum of them", () => {
    const decisions = new Map(
      grid.lanes.map((l) => [l.laneLabel, resumePlan(l.cells, [], false)] as const),
    );
    const total = estimateGridSeconds(grid, decisions, cfg);
    const perLane = grid.lanes.map((l) => estimateLaneSeconds(l, decisions.get(l.laneLabel)!, cfg));
    expect(total).toBe(Math.max(...perLane));
    expect(total).toBeLessThan(perLane.reduce((a, b) => a + b, 0));
  });

  test("a managed lane pays to load each model once", () => {
    const managed = config({
      lanes: [
        {
          label: "Lane A",
          baseUrl: "http://localhost:8090",
          ssh: { host: "box", binDir: "~/venv/bin", port: 8090 },
        },
        { label: "Lane B", baseUrl: "http://localhost:9002" },
      ],
    });
    const g = buildGrid(managed);
    const decisions = resumePlan(g.lanes[0]!.cells, [], false);
    const withStart = estimateLaneSeconds(g.lanes[0]!, decisions, managed);
    const without = estimateLaneSeconds(g.lanes[1]!, resumePlan(g.lanes[1]!.cells, [], false), managed);
    // Two models, so two loads, and nothing else differs between the lanes.
    expect(withStart - without).toBeCloseTo(2 * 60, 5);
  });
});

describe("formatDuration", () => {
  test("reads as a human would say it", () => {
    expect(formatDuration(9)).toBe("9s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3900)).toBe("1h 5m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("keyOfCell", () => {
  test("is stable across two builds of the same grid", () => {
    const a = buildGrid(config()).lanes[0]!.cells.map(keyOfCell);
    const b = buildGrid(config()).lanes[0]!.cells.map(keyOfCell);
    expect(a).toEqual(b);
  });
});

/**
 * A model's identity has to survive its weights moving.
 *
 * The first machine's finished run recorded each model under that machine's
 * own path. Moving every model to a uniform ~/bench-models/<dir> changes the
 * id, and keying on the raw string would make 21 finished cells look unstarted
 * and re-run about an hour of measurement -- and would then put the two
 * machines under two headings on the board, as though they were two models.
 */
describe("a model keeps its identity when its path changes", () => {
  const moved = () =>
    validateBenchConfig({
      measuredRuns: 5,
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [{ name: "Big", dir: "Big-4bit", hfRepo: "vendor/Big-4bit" }],
      lanes: [
        {
          label: "First",
          baseUrl: "http://one.local:8090",
          ssh: { host: "one.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
          localPaths: { "Big-4bit": "~/.somewhere/vendor--Big-4bit" },
        },
        {
          label: "Second",
          baseUrl: "http://two.local:8090",
          ssh: { host: "two.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
        },
      ],
    });

  /** A record as the older run wrote it: the per-machine path, no key. */
  const old = (i: number) =>
    record({ laneLabel: "First", modelId: "~/.somewhere/vendor--Big-4bit", runIndex: i, modelKey: undefined });

  test("the key is the uniform folder name, not wherever the weights sit", () => {
    const config = moved();
    expect(modelKeyOf(config.models[0]!)).toBe("Big-4bit");
    expect(buildGrid(config).lanes[0]!.cells[0]!.modelKey).toBe("Big-4bit");
  });

  test("a lane's own copy counts as an id that model answers to", () => {
    // So nobody has to write the old path down twice: localPaths already says
    // where those weights are on that machine.
    const config = moved();
    const ids = knownIdsFor(config, config.models[0]!);
    expect(ids).toContain("~/bench-models/Big-4bit");
    expect(ids).toContain("~/.somewhere/vendor--Big-4bit");
  });

  test("cells finished under the old path still count as done", () => {
    const config = moved();
    const cells = buildGrid(config).lanes[0]!.cells;
    const done = [1, 2, 3, 4, 5].map(old);

    // Without the index it cannot know, and would re-run the lot.
    expect(resumePlan(cells, done, false)[0]!.skip).toBe(false);
    // With it, the finished work is recognised.
    expect(resumePlan(cells, done, false, modelKeyIndex(config))[0]!.skip).toBe(true);
  });

  test("the second machine's cells are still owed", () => {
    const config = moved();
    const grid = buildGrid(config);
    const index = modelKeyIndex(config);
    const done = [1, 2, 3, 4, 5].map(old);
    expect(resumePlan(grid.lanes[0]!.cells, done, false, index).every((d) => d.skip)).toBe(true);
    expect(resumePlan(grid.lanes[1]!.cells, done, false, index).every((d) => !d.skip)).toBe(true);
  });

  test("an explicit alias works for a path no lane declares", () => {
    const config = validateBenchConfig({
      promptLengths: [{ label: "512", tokens: 512 }],
      models: [{ name: "Big", dir: "Big-4bit", aliases: ["/old/place/Big"] }],
      lanes: [{ label: "First", baseUrl: "http://one.local:8090", ssh: { host: "one.local", binDir: "~/b/bin", port: 8090 } }],
    });
    const cells = buildGrid(config).lanes[0]!.cells;
    const done = [1, 2, 3, 4, 5].map((i) => record({ laneLabel: "First", modelId: "/old/place/Big", runIndex: i, modelKey: undefined }));
    expect(resumePlan(cells, done, false, modelKeyIndex(config))[0]!.skip).toBe(true);
  });

  test("a record for a model the config does not know is not folded into another", () => {
    const config = moved();
    const cells = buildGrid(config).lanes[0]!.cells;
    const stranger = [1, 2, 3, 4, 5].map((i) => record({ laneLabel: "First", modelId: "~/some/other/model", runIndex: i, modelKey: undefined }));
    expect(resumePlan(cells, stranger, false, modelKeyIndex(config))[0]!.skip).toBe(false);
  });

  test("a record that carries its own key is believed over the index", () => {
    const config = moved();
    const cells = buildGrid(config).lanes[0]!.cells;
    const keyed = [1, 2, 3, 4, 5].map((i) =>
      record({ laneLabel: "First", modelId: "anything-at-all", modelKey: "Big-4bit", runIndex: i }),
    );
    expect(resumePlan(cells, keyed, false, modelKeyIndex(config))[0]!.skip).toBe(true);
  });
});

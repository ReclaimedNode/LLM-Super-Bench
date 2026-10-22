import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildBoard, headlineFor, marksFor, niceTicks } from "../../src/bench/board.ts";
import type { CellStat, EngineCell, PowerReading, RunManifest, Stat3 } from "../../src/bench/types.ts";

const s = (median: number, low = median, high = median, n = 5): Stat3 => ({ median, low, high, n });

function cell(over: Partial<CellStat> = {}): CellStat {
  return {
    laneLabel: "Lane A",
    modelId: "m",
    modelKey: "m",
    modelName: "Big Model",
    nominalLabel: "4K",
    nominalTokens: 4096,
    torture: false,
    status: "ok",
    runsRecorded: 5,
    runsUsed: 5,
    failed: 0,
    cachedInvalid: 0,
    shortOutput: 0,
    readSpeed: s(800, 700, 900),
    writeSpeed: s(60, 58, 62),
    firstWordSec: s(5.1, 4.9, 5.3),
    totalSec: s(7.2),
    truePromptTokens: s(4010),
    trueOutputTokens: s(128),
    firstWordField: "content",
    fingerprints: ["fp-1"],
    notes: [],
    ...over,
  };
}

function manifest(over: Partial<RunManifest> = {}): RunManifest {
  return {
    runName: "my-run",
    startedAt: "2026-09-19T10:00:00.000Z",
    finishedAt: "2026-09-19T11:00:00.000Z",
    outputCap: 128,
    measuredRuns: 5,
    warmupRuns: 1,
    restSeconds: 30,
    temperature: 0,
    promptFile: "prompts/sample.txt",
    disableThinking: true,
    models: [{ name: "Big Model", id: "m", kind: "llm", quantization: "4-bit", fileSize: "7.8 GB", activeParams: "3B of 30B" }],
    lanes: [
      { label: "Lane A", managed: true },
      { label: "Lane B", managed: false },
    ],
    promptLengths: [
      { label: "512", tokens: 512 },
      { label: "4K", tokens: 4096 },
    ],
    fingerprints: ["fp-1"],
    charsPerToken: { m: 3.62 },
    ...over,
  };
}

const twoLanes = [
  cell({ laneLabel: "Lane A", nominalLabel: "512", readSpeed: s(2000), writeSpeed: s(65), firstWordSec: s(0.26) }),
  cell({ laneLabel: "Lane B", nominalLabel: "512", readSpeed: s(520), writeSpeed: s(43), firstWordSec: s(0.98) }),
  cell({ laneLabel: "Lane A", nominalLabel: "4K", readSpeed: s(800), writeSpeed: s(60), firstWordSec: s(5.1) }),
  cell({ laneLabel: "Lane B", nominalLabel: "4K", readSpeed: s(210), writeSpeed: s(42), firstWordSec: s(19.5) }),
];

function board(cells: CellStat[], engine: EngineCell[] = [], power: PowerReading[] = [], m = manifest()) {
  return buildBoard({ manifest: m, cells, engine, power });
}

describe("shaping a run for the board", () => {
  test("one row per prompt size, shortest first, twin charts on each", () => {
    const model = board(twoLanes).models[0]!;
    expect(model.rows.map((r) => r.nominalLabel)).toEqual(["512", "4K"]);
    for (const row of model.rows) {
      expect(row.reading.measure).toBe("reading");
      expect(row.writing.measure).toBe("writing");
      expect(row.reading.bars.map((b) => b.laneLabel)).toEqual(["Lane A", "Lane B"]);
      expect(row.writing.bars.map((b) => b.laneLabel)).toEqual(["Lane A", "Lane B"]);
    }
  });

  test("every bar carries the median and the low-to-high range", () => {
    const bar = board([cell({ readSpeed: s(800, 700, 900) })]).models[0]!.rows[0]!.reading.bars[0]!;
    expect(bar.median).toBe(800);
    expect(bar.low).toBe(700);
    expect(bar.high).toBe(900);
  });

  test("each lane keeps one colour everywhere it appears", () => {
    const data = board(twoLanes);
    expect(data.lanes.map((l) => l.colorVar)).toEqual(["--lane-1", "--lane-2"]);
    const model = data.models[0]!;
    for (const row of model.rows) {
      expect(row.reading.bars.map((b) => b.colorVar)).toEqual(["--lane-1", "--lane-2"]);
      expect(row.writing.bars.map((b) => b.colorVar)).toEqual(["--lane-1", "--lane-2"]);
    }
    expect(model.firstWord.series.map((s2) => s2.colorVar)).toEqual(["--lane-1", "--lane-2"]);
  });

  test("the axis clears the tallest RANGE mark, not just the tallest median", () => {
    const chart = board([
      cell({ laneLabel: "Lane A", readSpeed: s(800, 700, 1500) }),
      cell({ laneLabel: "Lane B", readSpeed: s(900, 880, 910) }),
    ]).models[0]!.rows[0]!.reading;
    // Otherwise the range mark would be drawn off the top of its own chart.
    expect(chart.dataMax).toBe(1500);
    expect(chart.max).toBeGreaterThanOrEqual(1500);
  });

  test("a cell with no usable number becomes a gap with a reason, never a zero bar", () => {
    const bar = board([cell({ status: "no-valid-runs", runsUsed: 0, cachedInvalid: 5, readSpeed: null })]).models[0]!
      .rows[0]!.reading.bars[0]!;
    expect(bar.median).toBeNull();
    expect(bar.marks).toContain("no valid runs");
    expect(bar.marks).toContain("5 cached");
  });

  test("a lane that never ran this cell is marked not run", () => {
    const data = board([cell({ laneLabel: "Lane A", nominalLabel: "4K" })]);
    const bars = data.models[0]!.rows[0]!.reading.bars;
    expect(bars[0]!.median).toBe(800);
    expect(bars[1]!.median).toBeNull();
    expect(bars[1]!.marks).toEqual(["not run"]);
  });

  test("partial, failed and thinking cells all carry a visible mark", () => {
    expect(marksFor(cell({ status: "failed", failed: 5 }))).toContain("failed");
    expect(marksFor(cell({ status: "partial", runsUsed: 3, shortOutput: 2 }))).toContain("2 short");
    expect(marksFor(cell({ firstWordField: "reasoning" }))).toContain("reasoning");
    expect(marksFor(undefined)).toEqual(["not run"]);
  });

  test("the cell's own notes travel with the row, named by lane", () => {
    const row = board([cell({ laneLabel: "Lane A", notes: ["2 run(s) excluded: cache."] })]).models[0]!.rows[0]!;
    expect(row.notes).toContain("Lane A: 2 run(s) excluded: cache.");
  });
});

describe("axis ticks land on round numbers", () => {
  // Dividing the tallest value into four gave ticks like 563, 188 and 56.3,
  // and a zero that read "0.00" on a tokens-per-second axis. Arithmetically
  // fine, unreadable at a glance, and the axis is on a chart that gets filmed.
  const isRound = (v: number) => Number.isInteger(v) || Number.isInteger(v * 2) || Number.isInteger(v * 10);

  test("the real numbers off the live run give the ticks a person would draw", () => {
    expect(niceTicks(662).ticks).toEqual([0, 200, 400, 600, 800]);
    expect(niceTicks(61.3).ticks).toEqual([0, 20, 40, 60, 80]);
    expect(niceTicks(2173).ticks).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    expect(niceTicks(5.43).ticks).toEqual([0, 2, 4, 6]);
  });

  test("every tick is a round number, over a wide spread of maxima", () => {
    for (const max of [0.4, 1, 3.7, 9, 12, 61.3, 99, 350, 662, 1001, 2173, 19999, 123456]) {
      const { ticks } = niceTicks(max);
      for (const tick of ticks) {
        expect(isRound(tick)).toBe(true);
      }
    }
  });

  test("the first tick is zero and the last is the axis top", () => {
    for (const max of [0.4, 12, 662, 2173, 123456]) {
      const { ticks, max: top } = niceTicks(max);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(top);
    }
  });

  test("the axis always clears the data, never crops it", () => {
    for (const max of [0.4, 1, 3.7, 9, 12, 61.3, 99, 350, 662, 1001, 2173, 19999, 123456]) {
      expect(niceTicks(max).max).toBeGreaterThanOrEqual(max);
    }
  });

  test("the steps are even, so the gridlines are evenly spaced", () => {
    for (const max of [12, 61.3, 662, 2173]) {
      const { ticks } = niceTicks(max);
      const steps = ticks.slice(1).map((t, i) => t - ticks[i]!);
      for (const step of steps) expect(step).toBeCloseTo(steps[0]!, 9);
    }
  });

  test("four to seven gridlines: enough to read, not a ladder", () => {
    for (const max of [0.4, 1, 3.7, 9, 12, 61.3, 99, 350, 662, 1001, 2173, 19999, 123456]) {
      const n = niceTicks(max).ticks.length;
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(8);
    }
  });

  test("no data gives an axis rather than a divide by zero", () => {
    expect(niceTicks(0).ticks).toEqual([0, 1]);
    expect(niceTicks(Number.NaN).max).toBe(1);
  });

  test("both charts of a twin row keep their own scale", () => {
    const row = board(twoLanes).models[0]!.rows[0]!;
    expect(row.reading.max).not.toBe(row.writing.max);
    expect(row.reading.ticks).not.toEqual(row.writing.ticks);
  });

  test("the line chart's seconds axis gets the same treatment", () => {
    const chart = board(twoLanes).models[0]!.firstWord;
    expect(chart.dataMaxY).toBe(19.5);
    expect(chart.ticks).toEqual([0, 5, 10, 15, 20]);
    expect(chart.maxY).toBe(20);
  });
});

/**
 * The board's page code is a browser script, so `bun test` cannot lay it out.
 * What it CAN do is hold the two structural rules that make the footer bug
 * impossible, both of which were broken when the bug shipped.
 */
describe("the footer keeps every label with its own value", () => {
  const dir = resolve(import.meta.dir, "../../public/bench");
  const js = readFileSync(resolve(dir, "board.js"), "utf8");
  const css = readFileSync(resolve(dir, "board.css"), "utf8");

  test("a label and its value are appended as ONE element, not two", () => {
    // Before: `list.append(dt); list.append(dd);` -- two grid items, so a row
    // could end on a label and orphan its value onto the next row, shifting
    // every pair after it.
    expect(js).toMatch(/pair\.append\(tag\("dt"/);
    expect(js).toMatch(/pair\.append\(tag\("dd"/);
    expect(js).toMatch(/list\.append\(pair\)/);
    expect(js).not.toMatch(/list\.append\(tag\("dt"/);
    expect(js).not.toMatch(/list\.append\(tag\("dd"/);
  });

  test("the pair can shrink, so a long value wraps inside its own column", () => {
    expect(css).toMatch(/\.footer-pair\s*\{[^}]*min-width:\s*0/);
  });
});

describe("the first-word line chart", () => {
  test("one line per lane, in seconds, over the prompt sizes in order", () => {
    const chart = board(twoLanes).models[0]!.firstWord;
    expect(chart.unit).toBe("seconds");
    expect(chart.xLabels).toEqual(["512", "4K"]);
    expect(chart.series[0]!.points.map((p) => p.y)).toEqual([0.26, 5.1]);
    expect(chart.series[1]!.points.map((p) => p.y)).toEqual([0.98, 19.5]);
    expect(chart.dataMaxY).toBe(19.5);
  });

  test("a missing cell is a hole in the line, not a zero", () => {
    const chart = board([
      cell({ laneLabel: "Lane A", nominalLabel: "512", firstWordSec: s(0.26) }),
      cell({ laneLabel: "Lane A", nominalLabel: "4K", firstWordSec: s(5.1) }),
      cell({ laneLabel: "Lane B", nominalLabel: "512", firstWordSec: s(0.98) }),
    ]).models[0]!.firstWord;
    expect(chart.series[1]!.points.map((p) => p.y)).toEqual([0.98, null]);
  });

  test("a torture cell stays off the line, because one run is not a trend", () => {
    const chart = board([
      ...twoLanes,
      cell({ laneLabel: "Lane A", nominalLabel: "100K", nominalTokens: 100000, torture: true, firstWordSec: s(90) }),
    ]).models[0]!.firstWord;
    expect(chart.xLabels).toEqual(["512", "4K"]);
    // 90s never reaches the axis: the torture cell is off this chart entirely.
    expect(chart.dataMaxY).toBe(19.5);
  });
});

describe("the headline sentence", () => {
  test("compares the lanes on the biggest prompt they both finished", () => {
    // The small sizes are where two machines look most alike, so leading with
    // one would flatter the slower box.
    expect(headlineFor(twoLanes, ["Lane A", "Lane B"])).toBe(
      "At a 4K prompt: Lane A reads 3.8x faster and writes 1.4x faster than Lane B on this model.",
    );
  });

  test("falls back to a smaller size when the biggest one is missing a lane", () => {
    const missing = twoLanes.filter((c) => !(c.laneLabel === "Lane B" && c.nominalLabel === "4K"));
    expect(headlineFor(missing, ["Lane A", "Lane B"])).toContain("At a 512 prompt:");
  });

  test("one lane means no comparison, and no sentence invented for it", () => {
    expect(headlineFor(twoLanes, ["Lane A"])).toBeNull();
  });
});

describe("the whole board", () => {
  test("carries the settings and versions a published number needs", () => {
    const data = board(twoLanes);
    expect(data.runName).toBe("my-run");
    expect(data.footer.outputCap).toBe(128);
    expect(data.footer.measuredRuns).toBe(5);
    expect(data.footer.restSeconds).toBe(30);
    expect(data.footer.fingerprints).toEqual(["fp-1"]);
    expect(data.footer.charsPerToken.m).toBe(3.62);
    expect(data.models[0]!.quantization).toBe("4-bit");
    expect(data.models[0]!.fileSize).toBe("7.8 GB");
    expect(data.models[0]!.activeParams).toBe("3B of 30B");
  });

  test("warns about cells that produced nothing usable", () => {
    const data = board([
      cell({ laneLabel: "Lane A", status: "failed" }),
      cell({ laneLabel: "Lane B", status: "partial" }),
    ]);
    expect(data.warnings.join(" ")).toContain("Lane A 4K");
    expect(data.warnings.join(" ")).toContain("had runs excluded");
  });

  test("says so when the run never finished", () => {
    expect(board(twoLanes, [], [], manifest({ finishedAt: null })).warnings.join(" ")).toContain("did not finish");
  });

  test("says so when ONE lane changed server version partway through", () => {
    const data = board(
      [
        cell({ laneLabel: "Lane A", nominalLabel: "512", fingerprints: ["fp-1"] }),
        cell({ laneLabel: "Lane A", nominalLabel: "4K", fingerprints: ["fp-2"] }),
        cell({ laneLabel: "Lane B", fingerprints: ["fp-3"] }),
      ],
      [],
      [],
      manifest({ fingerprints: ["fp-1", "fp-2", "fp-3"] }),
    );
    expect(data.warnings.join(" ")).toContain("Lane A did not stay on one server version");
  });

  test("two machines running two versions is not a warning — that is what two machines are", () => {
    // The versions are still printed in the footer; what would make a number
    // unreadable is one lane changing version, not two lanes differing. A
    // merged run always has two, so warning here would cry wolf every time.
    const data = board(
      [cell({ laneLabel: "Lane A", fingerprints: ["fp-1"] }), cell({ laneLabel: "Lane B", fingerprints: ["fp-2"] })],
      [],
      [],
      manifest({ fingerprints: ["fp-1", "fp-2"] }),
    );
    expect(data.warnings).toEqual([]);
    expect(data.footer.fingerprints).toEqual(["fp-1", "fp-2"]);
  });

  test("a clean run warns about nothing", () => {
    expect(board(twoLanes).warnings).toEqual([]);
  });

  test("the engine numbers come through with their peak memory, or say they are missing", () => {
    const engine: EngineCell[] = [
      {
        laneLabel: "Lane A",
        modelId: "m",
        nominalLabel: "512",
        nominalTokens: 512,
        generationTokens: 128,
        promptTps: s(790, 788, 792),
        generationTps: s(69.3),
        peakMemoryGb: 8.83,
        trials: 5,
        unavailable: null,
        raw: null,
      },
      {
        laneLabel: "Lane A",
        modelId: "m",
        nominalLabel: "4K",
        nominalTokens: 4096,
        generationTokens: 128,
        promptTps: null,
        generationTps: null,
        peakMemoryGb: null,
        trials: 0,
        unavailable: "its output did not parse",
        raw: null,
      },
    ];
    const rows = board(twoLanes, engine).models[0]!.engine;
    expect(rows[0]!.readMedian).toBe(790);
    expect(rows[0]!.peakMemoryGb).toBe(8.83);
    expect(rows[1]!.unavailable).toBe("its output did not parse");
    expect(rows[1]!.readMedian).toBeNull();
  });

  test("tokens per watt uses the writing speed from the machine that was metered", () => {
    const power: PowerReading[] = [
      { laneLabel: "Lane A", modelId: "m", modelName: "Big Model", kind: "load", watts: 200, holdSeconds: 60, ts: "" },
      { laneLabel: "Lane A", modelId: null, modelName: null, kind: "idle", watts: 20, holdSeconds: 60, ts: "" },
    ];
    const row = board(twoLanes, [], power).models[0]!.power[0]!;
    expect(row.loadWatts).toBe(200);
    expect(row.idleWatts).toBe(20);
    // Lane A's writing speed on its biggest prompt (4K) is 60.
    expect(row.tokensPerWatt).toBeCloseTo(60 / 200, 9);
  });

  test("no power readings means no power rows, not zeroes", () => {
    expect(board(twoLanes).models[0]!.power).toEqual([]);
  });

  test("a model with no cells is left out rather than shown empty", () => {
    const m = manifest({
      models: [
        { name: "Big Model", id: "m", kind: "llm" },
        { name: "Never Ran", id: "n", kind: "llm" },
      ],
    });
    expect(board(twoLanes, [], [], m).models.map((x) => x.modelId)).toEqual(["m"]);
  });
});

import { describe, expect, test } from "bun:test";
import { buildReport, engineModelName } from "../../src/bench/report.ts";
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
    readSpeed: s(800, 780, 820),
    writeSpeed: s(60, 58, 62),
    firstWordSec: s(5.1, 4.9, 5.3),
    totalSec: s(7.2),
    truePromptTokens: s(4010, 4008, 4012),
    trueOutputTokens: s(128),
    firstWordField: "content",
    fingerprints: ["0.31.3-0.31.2-os-gpu"],
    notes: [],
    ...over,
  };
}

const manifest: RunManifest = {
  runName: "my-run",
  startedAt: "2026-09-19T10:00:00.000Z",
  finishedAt: "2026-09-19T11:30:00.000Z",
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
  fingerprints: ["0.31.3-0.31.2-os-gpu"],
  charsPerToken: { m: 3.62 },
};

function report(cells: CellStat[], engine: EngineCell[] = [], power: PowerReading[] = []): string {
  return buildReport({ manifest, cells, engine, power });
}

describe("report.md", () => {
  const cells = [
    cell({ laneLabel: "Lane A", nominalLabel: "512", readSpeed: s(2000), writeSpeed: s(65), firstWordSec: s(0.26) }),
    cell({ laneLabel: "Lane A", nominalLabel: "4K", readSpeed: s(800), writeSpeed: s(60), firstWordSec: s(5.1) }),
    cell({ laneLabel: "Lane B", nominalLabel: "512", readSpeed: s(520), writeSpeed: s(43), firstWordSec: s(0.98) }),
    cell({ laneLabel: "Lane B", nominalLabel: "4K", readSpeed: s(210), writeSpeed: s(42), firstWordSec: s(19.5) }),
  ];

  test("has one section per model with the three measure tables", () => {
    const md = report(cells);
    expect(md).toContain("# Benchmark: my-run");
    expect(md).toContain("## Big Model");
    expect(md).toContain("### Reading speed");
    expect(md).toContain("### Writing speed");
    expect(md).toContain("### Wait for the first word");
    expect(md).toContain("### True token counts the speeds were divided by");
  });

  test("the tables are Markdown a human can paste, one column per lane", () => {
    const md = report(cells);
    expect(md).toContain("| Prompt | Lane A | Lane B |");
    expect(md).toContain("| --- | --- | --- |");
    // Shortest prompt first, and the median with its range beside it.
    const rows = md.split("\n").filter((l) => l.startsWith("| 512 |") || l.startsWith("| 4K |"));
    expect(rows.length).toBeGreaterThanOrEqual(6);
  });

  test("a median carries the range it came from", () => {
    const md = report([cell({ readSpeed: s(800, 700, 900) })]);
    expect(md).toContain("800 (700–900)");
  });

  test("a single-run cell says so rather than pretending to a range", () => {
    const md = report([cell({ torture: true, nominalLabel: "100K", readSpeed: s(90, 90, 90, 1) })]);
    expect(md).toContain("90 (1 run)");
    expect(md).toContain("100K (torture)");
  });

  test("the headline compares the lanes in plain words, on the biggest shared prompt", () => {
    const md = report(cells);
    expect(md).toContain("At a 4K prompt:");
    expect(md).toContain("Lane A reads 3.8x faster and writes 1.4x faster than Lane B on this model.");
  });

  test("failed, excluded and flagged cells are marked, never dropped", () => {
    const md = report([
      cell({ laneLabel: "Lane A", status: "partial", runsUsed: 3, notes: ["2 run(s) excluded: cache."] }),
      cell({ laneLabel: "Lane B", status: "failed", runsUsed: 0, readSpeed: null, writeSpeed: null, notes: ["5 of 5 runs failed."] }),
    ]);
    expect(md).toContain("⚠ 3/5 runs used");
    expect(md).toContain("✖ all runs failed");
    expect(md).toContain("### Excluded, failed and flagged");
    expect(md).toContain("2 run(s) excluded: cache.");
    expect(md).toContain("5 of 5 runs failed.");
  });

  test("the footer carries the settings and the software versions", () => {
    const md = report(cells);
    expect(md).toContain("## Settings and versions");
    expect(md).toContain("**Output cap:** 128 tokens");
    expect(md).toContain("5, after 1 discarded warm-up");
    expect(md).toContain("**Rest between cells:** 30s");
    expect(md).toContain("0.31.3-0.31.2-os-gpu");
    expect(md).toContain("Never a mean");
    expect(md).toContain("unique run id");
  });

  test("the footer names the model file, its size and its active parameters", () => {
    const md = report(cells);
    expect(md).toContain("| Big Model | 4-bit | 7.8 GB | 3B of 30B | 3.62 |");
  });

  test("the engine numbers appear beside the API ones, labelled as the engine's", () => {
    const engine: EngineCell[] = [
      {
        laneLabel: "Lane A",
        modelId: "m",
        nominalLabel: "512",
        nominalTokens: 512,
        generationTokens: 128,
        promptTps: s(790, 788, 792, 5),
        generationTps: s(69.3, 69.1, 69.5, 5),
        peakMemoryGb: 8.83,
        trials: 5,
        unavailable: null,
        raw: null,
      },
    ];
    const md = report(cells, engine);
    expect(md).toContain("## The engine's own benchmark");
    expect(md).toContain("| Lane | Model | Prompt | Reads (tok/s) | Writes (tok/s) | Peak memory (GB) | Trials |");
    expect(md).toContain("| Lane A | Big Model | 512 | 790 (788–792) | 69.3 (69.1–69.5) | 8.83 | 5 |");
    expect(md).toContain("Peak memory (GB)");
    expect(md).toContain("8.83");
    expect(md).toContain("The tool prints a mean");
  });

  test("each engine row names its model, whatever path that machine recorded it under", () => {
    const merged: RunManifest = {
      ...manifest,
      models: [
        { name: "Big Model", id: "~/bench-models/Big-Model-4bit", dir: "Big-Model-4bit", kind: "llm" },
        { name: "Small Model", id: "~/bench-models/Small-Model-4bit", dir: "Small-Model-4bit", kind: "llm", aliases: ["/elsewhere/small"] },
      ],
    };
    expect(engineModelName(merged, "~/bench-models/Big-Model-4bit")).toBe("Big Model");
    expect(engineModelName(merged, "/home/x/models/mlx-community/Big-Model-4bit")).toBe("Big Model");
    expect(engineModelName(merged, "/home/x/.cache/models/mlx-community--Small-Model-4bit")).toBe("Small Model");
    expect(engineModelName(merged, "/elsewhere/small")).toBe("Small Model");
    // Nothing claims it: the id is printed rather than a blank cell.
    expect(engineModelName(merged, "/home/x/models/Unknown-4bit")).toBe("/home/x/models/Unknown-4bit");
  });

  test("an engine cell that could not run says not available, and invents nothing", () => {
    const engine: EngineCell[] = [
      {
        laneLabel: "Lane A",
        modelId: "m",
        nominalLabel: "512",
        nominalTokens: 512,
        generationTokens: 128,
        promptTps: null,
        generationTps: null,
        peakMemoryGb: null,
        trials: 0,
        unavailable: "its output did not parse",
        raw: null,
      },
    ];
    expect(report(cells, engine)).toContain("not available — its output did not parse");
  });

  test("power is labelled as a reading taken by hand", () => {
    const power: PowerReading[] = [
      { laneLabel: "Lane A", modelId: "m", modelName: "Big Model", kind: "load", watts: 210, holdSeconds: 60, ts: "" },
      { laneLabel: "Lane A", modelId: null, modelName: null, kind: "idle", watts: 22, holdSeconds: 60, ts: "" },
    ];
    const md = report(cells, [], power);
    expect(md).toContain("## Power");
    expect(md).toContain("Read by hand off a wall meter");
    expect(md).toContain("| Lane A | Big Model | under load | 210 | 60s |");
  });

  test("no power data means no power section, not an empty one", () => {
    expect(report(cells)).not.toContain("## Power");
  });

  test("a pipe in a lane label cannot break the table", () => {
    const md = report([cell({ laneLabel: "A|B" })]);
    expect(md).toContain("A\\|B");
  });
});

import { describe, expect, test } from "bun:test";
import { buildReport, formatReport, latestSetups } from "../src/report.ts";
import type { PresetId, RunLogRecord } from "../src/types.ts";

let seq = 0;
function rec(over: Partial<RunLogRecord> & { lane: string; preset: PresetId }): RunLogRecord {
  seq += 1;
  return {
    ts: new Date(Date.UTC(2026, 8, 19, 0, 0, seq)).toISOString(),
    runId: `r-${seq}`,
    baseUrl: "http://localhost:9001",
    model: "mock-model",
    promptChars: 100,
    firstResponseSec: 0.5,
    firstWordSec: 1,
    firstWordField: "content",
    lastWordSec: 6,
    chunks: 100,
    tokens: null,
    tokenSource: null,
    totalSec: 6,
    error: null,
    ...over,
  };
}

describe("buildReport", () => {
  test("medians per lane and preset, over the last N runs only", () => {
    const records: RunLogRecord[] = [
      // Older runs that must fall outside a window of 3.
      rec({ lane: "Lane A", preset: "8k", firstWordSec: 99, totalSec: 99 }),
      rec({ lane: "Lane A", preset: "8k", firstWordSec: 99, totalSec: 99 }),
      // The last three: medians are 2 and 7.
      rec({ lane: "Lane A", preset: "8k", firstWordSec: 1, totalSec: 6 }),
      rec({ lane: "Lane A", preset: "8k", firstWordSec: 2, totalSec: 7 }),
      rec({ lane: "Lane A", preset: "8k", firstWordSec: 3, totalSec: 8 }),
    ];

    const rows = buildReport(records, 3);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toBe(3);
    expect(rows[0]!.medianFirstWordSec).toBe(2);
    expect(rows[0]!.medianTotalSec).toBe(7);
  });

  test("keeps lane and preset apart", () => {
    const rows = buildReport(
      [
        rec({ lane: "Lane A", preset: "short", totalSec: 2 }),
        rec({ lane: "Lane A", preset: "8k", totalSec: 10 }),
        rec({ lane: "Lane B", preset: "short", totalSec: 4 }),
        rec({ lane: "Lane B", preset: "8k", totalSec: 20 }),
      ],
      10,
    );
    expect(rows).toHaveLength(4);
    const key = (lane: string, preset: string) => rows.find((r) => r.lane === lane && r.preset === preset)!;
    expect(key("Lane A", "short").medianTotalSec).toBe(2);
    expect(key("Lane B", "8k").medianTotalSec).toBe(20);
    // short before 8k before 32k, lanes alphabetical inside a preset.
    expect(rows.map((r) => `${r.preset}/${r.lane}`)).toEqual([
      "short/Lane A",
      "short/Lane B",
      "8k/Lane A",
      "8k/Lane B",
    ]);
  });

  test("counts errored runs but keeps them out of the medians", () => {
    const rows = buildReport(
      [
        rec({ lane: "Lane A", preset: "short", totalSec: 4, firstWordSec: 1 }),
        rec({ lane: "Lane A", preset: "short", totalSec: null, firstWordSec: null, error: "HTTP 500" }),
        rec({ lane: "Lane A", preset: "short", totalSec: 6, firstWordSec: 3 }),
      ],
      10,
    );
    expect(rows[0]!.runs).toBe(3);
    expect(rows[0]!.errors).toBe(1);
    expect(rows[0]!.medianTotalSec).toBe(5);
    expect(rows[0]!.medianFirstWordSec).toBe(2);
  });

  test("reports tokens/sec only when every counted run has a token count", () => {
    const tokens = buildReport(
      [
        rec({ lane: "Lane A", preset: "short", tokens: 100, tokenSource: "usage", firstWordSec: 1, lastWordSec: 3, totalSec: 3 }),
        rec({ lane: "Lane A", preset: "short", tokens: 200, tokenSource: "usage", firstWordSec: 1, lastWordSec: 3, totalSec: 3 }),
      ],
      10,
    );
    expect(tokens[0]!.rateUnit).toBe("tokens/sec");
    // (100-1)/2 = 49.5 and (200-1)/2 = 99.5; median 74.5.
    expect(tokens[0]!.medianRate).toBe(74.5);

    const chunks = buildReport(
      [
        rec({ lane: "Lane A", preset: "short", tokens: 100, tokenSource: "usage", firstWordSec: 1, lastWordSec: 3, totalSec: 3 }),
        rec({ lane: "Lane A", preset: "short", chunks: 40, firstWordSec: 1, lastWordSec: 3, totalSec: 3 }),
      ],
      10,
    );
    expect(chunks[0]!.rateUnit).toBe("chunks/sec");
  });

  test("the report uses the same speed formula as the live race", () => {
    const rows = buildReport(
      [rec({ lane: "Lane A", preset: "short", chunks: 101, firstWordSec: 2, lastWordSec: 12, totalSec: 12 })],
      10,
    );
    // (101-1) / (12-2) = 10, NOT 101/12.
    expect(rows[0]!.medianRate).toBe(10);
  });

  test("a record written before lastWordSec existed gets no rate rather than a wrong one", () => {
    const legacy = rec({ lane: "Lane A", preset: "short", chunks: 100, firstWordSec: 1, totalSec: 6 });
    delete (legacy as { lastWordSec?: unknown }).lastWordSec;
    const rows = buildReport([legacy], 10);
    expect(rows[0]!.runs).toBe(1);
    expect(rows[0]!.medianRate).toBeNull();
    expect(rows[0]!.medianTotalSec).toBe(6);
  });

  test("no runs gives no rows", () => {
    expect(buildReport([], 10)).toEqual([]);
  });
});

describe("formatReport", () => {
  test("prints a plain aligned table", () => {
    const rows = buildReport(
      [
        rec({ lane: "Lane A", preset: "short", firstWordSec: 0.4, totalSec: 3 }),
        rec({ lane: "Lane B", preset: "short", firstWordSec: 1.2, totalSec: 9 }),
      ],
      10,
    );
    const text = formatReport(rows, 10);
    const lines = text.split("\n");
    expect(lines[0]).toContain("Median of the last 10 run(s)");
    expect(lines[2]).toContain("LANE");
    expect(lines[2]).toContain("FIRST WORD");
    expect(text).toContain("Lane A");
    expect(text).toContain("0.400s");
    expect(text).toContain("chunks/sec");
    // Header and body columns line up.
    const header = lines[2]!;
    const body = lines.find((l) => l.startsWith("Lane B"))!;
    expect(body.indexOf("1.200s")).toBe(header.indexOf("FIRST WORD"));
  });

  test("says plainly when nothing has been raced yet", () => {
    expect(formatReport([], 10)).toContain("No runs logged yet");
  });
});

describe("prompt speed and setup in the report", () => {
  const setup = (build: string) => ({ modelFile: "M-Q8_0.gguf", quant: "Q8_0", build, slots: 2, contextPerSlot: 131072, vision: false, notes: "spec on" });

  test("prompt speed is the median over one-stream runs that have a prompt token count", () => {
    const rows = buildReport(
      [
        rec({ lane: "A", preset: "32k", firstWordSec: 10, promptTokens: 30000 }),
        rec({ lane: "A", preset: "32k", firstWordSec: 20, promptTokens: 30000 }),
        rec({ lane: "A", preset: "32k", firstWordSec: 30, promptTokens: 30000 }),
      ],
      10,
    );
    expect(rows[0]!.medianPromptSpeed).toBe(1500);
  });

  test("blank where it would be a guess: no count, a cache hit, a thinking model, several streams", () => {
    const blank = (over: Partial<RunLogRecord>) =>
      buildReport([rec({ lane: "A", preset: "32k", promptTokens: 30000, ...over })], 10)[0]!.medianPromptSpeed;
    expect(blank({ promptTokens: undefined })).toBeNull();
    expect(blank({ cachedTokens: 100 })).toBeNull();
    expect(blank({ firstWordField: "reasoning" })).toBeNull();
    expect(blank({ concurrency: 2, failedStreams: 0, streams: [] })).toBeNull();
  });

  test("runs against differently set-up servers are flagged, and the latest setup is listed", () => {
    const records = [
      rec({ lane: "A", preset: "4k", setup: setup("b1") }),
      rec({ lane: "A", preset: "4k", setup: setup("b2") }),
    ];
    const rows = buildReport(records, 10);
    expect(rows[0]!.setupChanged).toBe(true);
    const text = formatReport(rows, 10, latestSetups(records));
    expect(text).toContain("Setup changed within the window for: A 4k x1");
    expect(text).toContain("A: M-Q8_0.gguf, Q8_0, build b2, 2 slots, 131,072 ctx/slot, notes: spec on");
  });

  test("the same setup throughout is not flagged, and old records without one are fine", () => {
    expect(buildReport([rec({ lane: "A", preset: "4k", setup: setup("b1") }), rec({ lane: "A", preset: "4k", setup: setup("b1") })], 10)[0]!.setupChanged).toBe(false);
    expect(buildReport([rec({ lane: "A", preset: "4k" })], 10)[0]!.setupChanged).toBe(false);
  });
});

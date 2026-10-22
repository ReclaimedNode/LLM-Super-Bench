import { describe, expect, test } from "bun:test";
import {
  buildScoreboard,
  computeRate,
  elapsedSeconds,
  formatRatio,
  formatSeconds,
  median,
  ratioHigherIsBetter,
  ratioLowerIsBetter,
} from "../src/timing.ts";
import type { LaneResult } from "../src/types.ts";

function lane(over: Partial<LaneResult> & { label: string }): LaneResult {
  return {
    laneId: over.label.toLowerCase().replace(/\s+/g, "-"),
    label: over.label,
    model: "model-x",
    displayModel: "model-x",
    baseUrl: "http://localhost:1",
    firstResponseSec: null,
    firstWordSec: null,
    firstWordField: null,
    lastWordSec: null,
    chunks: 0,
    tokens: null,
    tokenSource: null,
    promptTokens: null,
    cachedTokens: null,
    systemFingerprint: null,
    totalSec: null,
    error: null,
    blocked: null,
    usageSupported: null,
    ...over,
  };
}

describe("elapsedSeconds", () => {
  test("converts a millisecond delta to seconds", () => {
    expect(elapsedSeconds(1000, 1412.5)).toBeCloseTo(0.4125, 6);
  });

  test("is zero for the same instant", () => {
    expect(elapsedSeconds(500, 500)).toBe(0);
  });
});

describe("computeRate", () => {
  test("is (count - 1) over the window between the first and last piece", () => {
    // 101 pieces from 1s to 6s: 100 gaps across 5s -> 20/sec.
    expect(computeRate(101, 1, 6)).toBe(20);
  });

  test("excludes the wait before the first word", () => {
    // Two lanes stream identically fast once started; one waited 10s longer to
    // begin. They must score the same speed.
    const quickToStart = computeRate(51, 0.5, 5.5);
    const slowToStart = computeRate(51, 10.5, 15.5);
    expect(quickToStart).toBe(slowToStart);
    expect(quickToStart).toBe(10);

    // count / total time would have punished the slow starter twice.
    expect(51 / 15.5).toBeLessThan(51 / 5.5);
  });

  test("is null for a single piece, which has no window", () => {
    expect(computeRate(1, 1, 1)).toBeNull();
    expect(computeRate(0, 1, 6)).toBeNull();
  });

  test("is null when either end of the window is missing", () => {
    expect(computeRate(100, null, 6)).toBeNull();
    expect(computeRate(100, 1, null)).toBeNull();
  });

  test("is null when the window is zero or negative", () => {
    expect(computeRate(100, 6, 6)).toBeNull();
    expect(computeRate(100, 7, 6)).toBeNull();
  });
});

describe("median", () => {
  test("odd count takes the middle value", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  test("even count averages the two middle values", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  test("empty is null", () => {
    expect(median([])).toBeNull();
  });

  test("ignores non-finite values", () => {
    expect(median([1, Number.NaN, 3])).toBe(2);
  });
});

describe("ratios", () => {
  test("lower-is-better divides the loser by the winner", () => {
    expect(ratioLowerIsBetter(0.5, 1.6)).toBeCloseTo(3.2, 10);
  });

  test("higher-is-better divides the winner by the loser", () => {
    expect(ratioHigherIsBetter(80, 25)).toBeCloseTo(3.2, 10);
  });

  test("formats to one decimal with an x", () => {
    expect(formatRatio(3.24)).toBe("3.2x");
  });

  test("formats seconds with more precision under ten", () => {
    expect(formatSeconds(0.412)).toBe("0.41s");
    expect(formatSeconds(14.88)).toBe("14.9s");
  });
});

describe("buildScoreboard", () => {
  test("names the winner of each measure and states the gap in plain words", () => {
    const board = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 0.5, lastWordSec: 5.5, chunks: 100, totalSec: 5.5, firstWordField: "content" }),
      lane({ label: "Lane B", firstWordSec: 1.6, lastWordSec: 11.6, chunks: 100, totalSec: 11.6, firstWordField: "content" }),
    ]);

    const first = board.entries.find((e) => e.measure === "First word")!;
    expect(first.winnerLabel).toBe("Lane A");
    expect(first.ratio).toBeCloseTo(3.2, 5);
    expect(first.sentence).toContain("Lane A reached the first word 3.2x faster than Lane B");

    const speed = board.entries.find((e) => e.measure === "Speed")!;
    expect(speed.winnerLabel).toBe("Lane A");
    // A: 99 gaps across 5s = 19.8. B: 99 gaps across 10s = 9.9.
    expect(speed.winnerValue).toBeCloseTo(19.8, 5);
    expect(speed.ratio).toBeCloseTo(2, 5);

    const total = board.entries.find((e) => e.measure === "Total time")!;
    expect(total.winnerLabel).toBe("Lane A");
    expect(total.sentence).toContain("sooner than Lane B");
  });

  test("calls speed chunks/sec unless every finished lane reported token usage", () => {
    const mixed = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 1, lastWordSec: 3, chunks: 50, tokens: 60, tokenSource: "usage", totalSec: 3 }),
      lane({ label: "Lane B", firstWordSec: 1, lastWordSec: 4, chunks: 50, totalSec: 4 }),
    ]);
    expect(mixed.speedUnit).toBe("chunks/sec");
    expect(mixed.notes.some((n) => n.includes("did not report token usage"))).toBe(true);

    const both = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 1, lastWordSec: 3, chunks: 50, tokens: 60, tokenSource: "usage", totalSec: 3 }),
      lane({ label: "Lane B", firstWordSec: 1, lastWordSec: 4, chunks: 50, tokens: 60, tokenSource: "usage", totalSec: 4 }),
    ]);
    expect(both.speedUnit).toBe("tokens/sec");

    // In the mixed case, the lane that DID report tokens is still expressed in
    // the race's unit, so one lane never shows two different speeds on screen.
    const laneA = mixed.laneRates.find((l) => l.laneId === "lane-a")!;
    expect(mixed.speedUnit).toBe("chunks/sec");
    expect(laneA.rate).toBeCloseTo((50 - 1) / (3 - 1), 6); // chunks, not its 60 tokens
  });

  test("laneRates covers every lane and is null for the ones that did not run", () => {
    const board = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 1, lastWordSec: 3, chunks: 50, totalSec: 3 }),
      lane({ label: "Lane B", error: "HTTP 500" }),
      lane({ label: "Lane C", blocked: "model missing" }),
    ]);
    expect(board.laneRates).toHaveLength(3);
    expect(board.laneRates.find((l) => l.laneId === "lane-a")!.rate).toBeCloseTo(24.5, 6);
    expect(board.laneRates.find((l) => l.laneId === "lane-b")!.rate).toBeNull();
    expect(board.laneRates.find((l) => l.laneId === "lane-c")!.rate).toBeNull();
  });

  test("scores only the lanes that finished, and names the ones that did not", () => {
    const board = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 0.4, lastWordSec: 4, chunks: 80, totalSec: 4 }),
      lane({ label: "Lane B", error: "HTTP 500 - boom" }),
      lane({ label: "Lane C", blocked: "Lane C will not start: model missing" }),
    ]);
    expect(board.entries.every((e) => e.winnerLabel === "Lane A")).toBe(true);
    expect(board.entries[0]!.runnerUpLabel).toBeNull();
    expect(board.notes.some((n) => n.includes("Lane B failed: HTTP 500 - boom"))).toBe(true);
    // A blocked lane's reason already names the lane, so it is not prefixed again.
    expect(board.notes).toContain("Lane C will not start: model missing");
  });

  test("warns when total time is comparing very different amounts of output", () => {
    const board = buildScoreboard([
      lane({ label: "Lane A", firstWordSec: 0.2, lastWordSec: 2, chunks: 20, totalSec: 2 }),
      lane({ label: "Lane B", firstWordSec: 0.2, lastWordSec: 9, chunks: 200, totalSec: 9 }),
    ]);
    expect(board.notes.some((n) => n.includes("Total time compares different amounts of output"))).toBe(true);
  });

  test("says so plainly when nothing finished", () => {
    const board = buildScoreboard([lane({ label: "Lane A", error: "down" }), lane({ label: "Lane B", error: "down" })]);
    expect(board.entries).toHaveLength(0);
    expect(board.notes.some((n) => n.includes("No lane finished"))).toBe(true);
  });
});

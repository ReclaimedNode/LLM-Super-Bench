import { describe, expect, test } from "bun:test";
import {
  compareSentence,
  judgeRun,
  markRun,
  readingSpeed,
  stat3,
  summariseCell,
  writingSpeed,
} from "../../src/bench/stats.ts";
import type { BenchRunRecord, Cell } from "../../src/bench/types.ts";

const CAP = 128;

function record(over: Partial<BenchRunRecord> = {}): BenchRunRecord {
  return {
    ts: "2026-09-19T00:00:00.000Z",
    runName: "r",
    runId: "run-1",
    laneLabel: "Lane A",
    modelId: "m",
    modelName: "M",
    nominalLabel: "4K",
    nominalTokens: 4096,
    outputCap: CAP,
    runIndex: 1,
    warmup: false,
    torture: false,
    firstResponseSec: 0.05,
    firstWordSec: 2,
    firstWordField: "content",
    lastWordSec: 5,
    totalSec: 5.1,
    promptTokens: 4000,
    outputTokens: CAP,
    cachedTokens: 0,
    chunks: 120,
    promptChars: 16000,
    systemFingerprint: "0.31.3-0.31.2-os-gpu",
    thinkingDisabled: true,
    error: null,
    invalidReason: null,
    flags: [],
    ...over,
  };
}

const cell: Cell = {
  laneLabel: "Lane A",
  modelId: "m",
  modelKey: "m",
  modelName: "M",
  nominalLabel: "4K",
  nominalTokens: 4096,
  measuredRuns: 5,
  torture: false,
};

describe("median, lowest and highest", () => {
  test("the headline is the median, never the mean", () => {
    // One slow run drags a mean a long way and leaves a median alone. That is
    // the whole reason the median is the headline.
    const s = stat3([10, 10, 10, 10, 60])!;
    expect(s.median).toBe(10);
    expect(s.low).toBe(10);
    expect(s.high).toBe(60);
    expect(s.n).toBe(5);
    const mean = (10 + 10 + 10 + 10 + 60) / 5;
    expect(mean).toBe(20);
    expect(s.median).not.toBe(mean);
  });

  test("an even count takes the midpoint of the middle two", () => {
    expect(stat3([1, 2, 3, 4])!.median).toBe(2.5);
  });

  test("no values means no number, not a zero", () => {
    expect(stat3([])).toBeNull();
    expect(stat3([Number.NaN])).toBeNull();
  });
});

describe("reading speed", () => {
  test("is the TRUE prompt tokens divided by the wait for the first word", () => {
    expect(readingSpeed(4000, 2)).toBe(2000);
  });

  test("uses the true count, not the nominal one", () => {
    // A cell labelled 4K whose prompt truly measured 4,000 tokens must report
    // 2,000 tok/s, not 2,048. The label is a label.
    const r = record({ promptTokens: 4000, nominalTokens: 4096, firstWordSec: 2 });
    expect(readingSpeed(r.promptTokens, r.firstWordSec)).toBe(2000);
    expect(readingSpeed(r.nominalTokens, r.firstWordSec)).not.toBe(2000);
  });

  test("no true count means no reading speed", () => {
    expect(readingSpeed(null, 2)).toBeNull();
    expect(readingSpeed(4000, null)).toBeNull();
    expect(readingSpeed(4000, 0)).toBeNull();
  });
});

describe("writing speed", () => {
  test("is (tokens - 1) over the window between first and last piece", () => {
    // 128 tokens, pieces from 2s to 5s: 127 / 3.
    expect(writingSpeed(record())!).toBeCloseTo(127 / 3, 9);
  });

  test("excludes the wait before the first word, unlike tokens over total time", () => {
    const slowPrefill = record({ firstWordSec: 20, lastWordSec: 23, totalSec: 23.1 });
    const naive = slowPrefill.outputTokens! / slowPrefill.totalSec!;
    expect(writingSpeed(slowPrefill)!).toBeGreaterThan(naive * 5);
  });

  test("one token has no window and so no speed", () => {
    expect(writingSpeed(record({ outputTokens: 1 }))).toBeNull();
  });
});

describe("which runs are allowed to become numbers", () => {
  test("a clean run counts", () => {
    const v = judgeRun(record(), CAP);
    expect(v.usable).toBe(true);
    expect(v.invalidReason).toBeNull();
  });

  test("a run the server partly served from cache is excluded and says so", () => {
    const v = judgeRun(record({ cachedTokens: 3900 }), CAP);
    expect(v.usable).toBe(false);
    expect(v.flags).toContain("cached");
    expect(v.invalidReason).toContain("3900");
    expect(v.invalidReason).toContain("cache");
  });

  test("cached_tokens of zero is fine; it is above zero that disqualifies", () => {
    expect(judgeRun(record({ cachedTokens: 0 }), CAP).usable).toBe(true);
    expect(judgeRun(record({ cachedTokens: 1 }), CAP).usable).toBe(false);
  });

  test("a run that stopped under 90% of the cap is excluded and flagged", () => {
    const v = judgeRun(record({ outputTokens: 100 }), CAP); // 100 < 115.2
    expect(v.usable).toBe(false);
    expect(v.flags).toContain("short-output");
    expect(v.invalidReason).toContain("100 of the 128-token cap");
  });

  test("exactly 90% of the cap still counts", () => {
    expect(judgeRun(record({ outputTokens: 115.2 }), CAP).usable).toBe(true);
    expect(judgeRun(record({ outputTokens: 115 }), CAP).usable).toBe(false);
  });

  test("a failed run is excluded, and the failure is the reason", () => {
    const v = judgeRun(record({ error: "Timed out after 1800s" }), CAP);
    expect(v.usable).toBe(false);
    expect(v.invalidReason).toContain("Timed out");
    expect(v.flags).toContain("failed");
  });

  test("no usage frame means no true counts to divide by, so it cannot count", () => {
    const v = judgeRun(record({ promptTokens: null, outputTokens: null }), CAP);
    expect(v.usable).toBe(false);
    expect(v.flags).toContain("no-usage");
  });

  test("a first word that arrived as reasoning is flagged but still counts", () => {
    const v = judgeRun(record({ firstWordField: "reasoning" }), CAP);
    expect(v.usable).toBe(true);
    expect(v.flags.join(" ")).toContain("reasoning");
  });

  test("markRun writes the verdict onto the record", () => {
    const marked = markRun(record({ cachedTokens: 12 }), CAP);
    expect(marked.invalidReason).toContain("cache");
    expect(marked.flags).toContain("cached");
  });
});

describe("summarising a cell", () => {
  test("medians are taken over the usable runs only, and the rest are counted", () => {
    const runs = [
      record({ runIndex: 0, warmup: true, firstWordSec: 99 }), // discarded
      record({ runIndex: 1, firstWordSec: 2 }),
      record({ runIndex: 2, firstWordSec: 3 }),
      record({ runIndex: 3, firstWordSec: 4 }),
      record({ runIndex: 4, firstWordSec: 1, cachedTokens: 900 }), // cache
      record({ runIndex: 5, firstWordSec: 1, outputTokens: 20 }), // short
    ];
    const stat = summariseCell(cell, runs, CAP);

    expect(stat.runsRecorded).toBe(5);
    expect(stat.runsUsed).toBe(3);
    expect(stat.cachedInvalid).toBe(1);
    expect(stat.shortOutput).toBe(1);
    expect(stat.status).toBe("partial");
    expect(stat.firstWordSec!.median).toBe(3);
    expect(stat.firstWordSec!.low).toBe(2);
    expect(stat.firstWordSec!.high).toBe(4);
    // The warm-up's 99s never reaches the numbers.
    expect(stat.firstWordSec!.high).toBeLessThan(99);
    expect(stat.notes.join(" ")).toContain("cache");
    expect(stat.notes.join(" ")).toContain("cap");
  });

  test("a cell whose every run was excluded reports that, rather than nothing", () => {
    const stat = summariseCell(cell, [record({ cachedTokens: 5 }), record({ cachedTokens: 5 })], CAP);
    expect(stat.status).toBe("no-valid-runs");
    expect(stat.readSpeed).toBeNull();
    expect(stat.runsUsed).toBe(0);
    expect(stat.notes.length).toBeGreaterThan(0);
  });

  test("a cell whose every run failed says failed", () => {
    const stat = summariseCell(cell, [record({ error: "boom" }), record({ error: "boom" })], CAP);
    expect(stat.status).toBe("failed");
    expect(stat.failed).toBe(2);
  });

  test("a cell with nothing recorded is not-run, not a zero", () => {
    const stat = summariseCell(cell, [], CAP);
    expect(stat.status).toBe("not-run");
    expect(stat.writeSpeed).toBeNull();
  });

  test("reading speed comes from each run's own true prompt count", () => {
    const runs = [
      record({ runIndex: 1, promptTokens: 4000, firstWordSec: 2 }), // 2000
      record({ runIndex: 2, promptTokens: 4000, firstWordSec: 4 }), // 1000
      record({ runIndex: 3, promptTokens: 4000, firstWordSec: 1 }), // 4000
    ];
    const stat = summariseCell(cell, runs, CAP);
    expect(stat.readSpeed!.median).toBe(2000);
    expect(stat.readSpeed!.low).toBe(1000);
    expect(stat.readSpeed!.high).toBe(4000);
  });

  test("two different server versions inside one cell is called out", () => {
    const stat = summariseCell(
      cell,
      [record({ systemFingerprint: "a" }), record({ systemFingerprint: "b" })],
      CAP,
    );
    expect(stat.fingerprints).toEqual(["a", "b"]);
    expect(stat.notes.join(" ")).toContain("more than one version");
  });
});

describe("the plain-words comparison", () => {
  test("names one lane once when it wins both", () => {
    const sentence = compareSentence(
      { label: "Lane A", read: 100, write: 10 },
      { label: "Lane B", read: 380, write: 14 },
    );
    expect(sentence).toBe("Lane B reads 3.8x faster and writes 1.4x faster than Lane A on this model.");
  });

  test("splits into two clauses when the lanes split the two measures", () => {
    const sentence = compareSentence(
      { label: "Lane A", read: 400, write: 10 },
      { label: "Lane B", read: 100, write: 20 },
    )!;
    expect(sentence).toContain("Lane A reads 4.0x faster than Lane B");
    expect(sentence).toContain("Lane B writes 2.0x faster than Lane A");
  });

  test("says nothing rather than a sentence with a hole in it", () => {
    expect(compareSentence({ label: "A", read: null, write: null }, { label: "B", read: 1, write: 1 })).toBeNull();
  });

  test("one measure missing gives one clause", () => {
    const sentence = compareSentence(
      { label: "A", read: 200, write: null },
      { label: "B", read: 100, write: 5 },
    )!;
    expect(sentence).toBe("A reads 2.0x faster than B on this model.");
  });
});

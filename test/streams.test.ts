import { describe, expect, test } from "bun:test";
import { PRESETS, PRESET_IDS, buildPrompt, targetCharsFor } from "../src/prompt.ts";
import { parseRaceRequest } from "../src/request.ts";
import { buildReport, formatReport } from "../src/report.ts";
import { combineStreams, concurrencyOptions, streamRunId } from "../src/streams.ts";
import {
  buildScoreboard,
  computeRate,
  laneSpeed,
  laneThroughput,
  medianStreamRate,
  throughput,
} from "../src/timing.ts";
import type { LaneResult, RunLogRecord, StreamSample } from "../src/types.ts";

function stream(over: Partial<LaneResult> = {}): LaneResult {
  return {
    laneId: "lane-0",
    label: "Studio",
    model: "model-x",
    displayModel: "model-x",
    baseUrl: "http://localhost:1",
    firstResponseSec: 0.1,
    firstWordSec: 1,
    firstWordField: "content",
    lastWordSec: 11,
    chunks: 100,
    tokens: 101,
    tokenSource: "usage",
    promptTokens: 500,
    cachedTokens: 0,
    systemFingerprint: "fp",
    totalSec: 11.5,
    error: null,
    blocked: null,
    usageSupported: true,
    ...over,
  };
}

function sample(over: Partial<StreamSample> = {}): StreamSample {
  return { firstWordSec: 1, lastWordSec: 11, chunks: 100, tokens: 101, totalSec: 11.5, ...over };
}

describe("the prompt sizes the page offers", () => {
  test("every size has a preset, smallest first, and Short is the one with no source text", () => {
    expect(PRESET_IDS).toEqual(["short", "4k", "8k", "16k", "32k", "64k", "128k"]);
    for (const id of PRESET_IDS) expect(PRESETS[id].id).toBe(id);
    const tokens = PRESET_IDS.map((id) => PRESETS[id].targetTokens);
    expect(tokens[0]).toBe(0);
    expect([...tokens].sort((a, b) => a - b)).toEqual(tokens);
  });

  test("each size is the number of tokens its label says, in characters at the configured ratio", () => {
    expect(targetCharsFor("4k", 4)).toBe(4096 * 4);
    expect(targetCharsFor("16k", 4)).toBe(16384 * 4);
    expect(targetCharsFor("64k", 4)).toBe(65536 * 4);
    expect(targetCharsFor("128k", 4)).toBe(131072 * 4);
  });

  test("a bigger size really builds a bigger prompt, from a source shorter than all of them", () => {
    const source = "the quick brown fox jumps over the lazy dog. ".repeat(50);
    const sizes = PRESET_IDS.map((id) => buildPrompt({ preset: id, sourceText: source, charsPerToken: 4, runId: "r" }).chars);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThan(sizes[i - 1]!);
  });
});

describe("streams per machine: the options and the run ids", () => {
  test("offers the powers of two up to the maximum", () => {
    expect(concurrencyOptions(16)).toEqual([1, 2, 4, 8, 16]);
    expect(concurrencyOptions(1)).toEqual([1]);
    expect(concurrencyOptions(10)).toEqual([1, 2, 4, 8]);
  });

  test("one stream keeps the plain run id, so an ordinary race is what it always was", () => {
    expect(streamRunId("20260101T000000Z-abc", 0, 1)).toBe("20260101T000000Z-abc");
  });

  test("several streams get distinct ids that are all the same length", () => {
    const ids = Array.from({ length: 16 }, (_, k) => streamRunId("R", k, 16));
    expect(new Set(ids).size).toBe(16);
    expect(new Set(ids.map((i) => i.length)).size).toBe(1);
    expect(ids[0]).toBe("R-s01");
    expect(ids[15]).toBe("R-s16");
  });
});

describe("combining one lane's streams into one result", () => {
  test("a single stream comes back untouched", () => {
    const only = stream();
    expect(combineStreams([only])).toBe(only);
  });

  test("first word is the median, last word and total are the latest, output is the sum", () => {
    const combined = combineStreams([
      stream({ firstWordSec: 1, lastWordSec: 10, totalSec: 11, chunks: 10, tokens: 13 }),
      stream({ firstWordSec: 2, lastWordSec: 12, totalSec: 13, chunks: 20, tokens: 23 }),
      stream({ firstWordSec: 3, lastWordSec: 14, totalSec: 15, chunks: 30, tokens: 33 }),
      stream({ firstWordSec: 10, lastWordSec: 20, totalSec: 21, chunks: 40, tokens: 43 }),
    ]);
    expect(combined.firstWordSec).toBe(2.5);
    expect(combined.lastWordSec).toBe(20);
    expect(combined.totalSec).toBe(21);
    expect(combined.chunks).toBe(100);
    expect(combined.tokens).toBe(112);
    expect(combined.tokenSource).toBe("usage");
    expect(combined.concurrency).toBe(4);
    expect(combined.failedStreams).toBe(0);
    expect(combined.streams).toHaveLength(4);
    expect(combined.error).toBeNull();
  });

  test("a sum of tokens over only some of the streams is not reported as a token count", () => {
    const combined = combineStreams([stream({ tokens: 50 }), stream({ tokens: null, tokenSource: null, usageSupported: false })]);
    expect(combined.tokens).toBeNull();
    expect(combined.tokenSource).toBeNull();
    expect(combined.usageSupported).toBe(false);
    expect(combined.chunks).toBe(200);
  });

  test("a stream that failed is counted, named, and left out of every number", () => {
    const combined = combineStreams([
      stream({ chunks: 10, tokens: 13, totalSec: 5 }),
      stream({ chunks: 0, tokens: null, firstWordSec: null, lastWordSec: null, totalSec: null, error: "HTTP 500" }),
      stream({ chunks: 20, tokens: 23, totalSec: 7 }),
    ]);
    expect(combined.concurrency).toBe(3);
    expect(combined.failedStreams).toBe(1);
    expect(combined.streams).toHaveLength(2);
    expect(combined.chunks).toBe(30);
    expect(combined.tokens).toBe(36);
    expect(combined.totalSec).toBe(7);
    expect(combined.error).toBeNull();
  });

  test("when every stream failed the lane failed, and says why", () => {
    const combined = combineStreams([
      stream({ error: "HTTP 500 - boom", totalSec: null }),
      stream({ error: "HTTP 500 - boom", totalSec: null }),
      stream({ error: "HTTP 500 - boom", totalSec: null }),
    ]);
    expect(combined.error).toBe("all 3 streams failed: HTTP 500 - boom");
    expect(combined.failedStreams).toBe(3);
    expect(combined.streams).toEqual([]);
  });
});

describe("the speed of one stream, and every stream together", () => {
  test("with one stream, throughput IS the speed formula", () => {
    const one = sample({ firstWordSec: 2, lastWordSec: 12, tokens: 101 });
    expect(throughput([one], "tokens/sec")).toBe(computeRate(101, 2, 12));
    expect(medianStreamRate([one], "tokens/sec")).toBe(computeRate(101, 2, 12));
  });

  test("per-stream speed is the median of each stream's own rate", () => {
    const streams = [
      sample({ firstWordSec: 1, lastWordSec: 11, tokens: 101 }), // 10 /s
      sample({ firstWordSec: 2, lastWordSec: 12, tokens: 201 }), // 20 /s
      sample({ firstWordSec: 1, lastWordSec: 11, tokens: 301 }), // 30 /s
    ];
    expect(medianStreamRate(streams, "tokens/sec")).toBe(20);
  });

  test("throughput adds the gaps of every stream and divides by the window that covers them all", () => {
    const streams = [
      sample({ firstWordSec: 1, lastWordSec: 11, tokens: 101 }), // 100 gaps
      sample({ firstWordSec: 2, lastWordSec: 12, tokens: 201 }), // 200 gaps
    ];
    // 300 gaps over 1 -> 12, which is 11 seconds.
    expect(throughput(streams, "tokens/sec")).toBeCloseTo(300 / 11, 10);
  });

  test("two streams that ran one after the other are not counted as if they overlapped", () => {
    const streams = [
      sample({ firstWordSec: 1, lastWordSec: 11, tokens: 101 }),
      sample({ firstWordSec: 11, lastWordSec: 21, tokens: 101 }),
    ];
    // 200 gaps over 1 -> 21, 20 seconds: 10 per second, the same as a stream alone.
    expect(throughput(streams, "tokens/sec")).toBeCloseTo(10, 10);
  });

  test("a stream with nothing measurable adds nothing and does not stretch the window", () => {
    const streams = [
      sample({ firstWordSec: 1, lastWordSec: 11, tokens: 101 }),
      sample({ firstWordSec: null, lastWordSec: null, tokens: null, chunks: 0 }),
    ];
    expect(throughput(streams, "tokens/sec")).toBeCloseTo(10, 10);
  });

  test("is null when nothing could be measured", () => {
    expect(throughput([], "tokens/sec")).toBeNull();
    expect(throughput([sample({ tokens: null })], "tokens/sec")).toBeNull();
    expect(medianStreamRate([], "chunks/sec")).toBeNull();
  });

  test("a lane that ran one stream has a speed and no throughput", () => {
    const lane = stream({ firstWordSec: 1, lastWordSec: 11, tokens: 101 });
    expect(laneSpeed(lane, "tokens/sec")).toBe(10);
    expect(laneThroughput(lane, "tokens/sec")).toBeNull();
  });

  test("a lane that ran several has the median stream's speed and the throughput of all of them", () => {
    const lane = combineStreams([
      stream({ firstWordSec: 1, lastWordSec: 11, tokens: 101 }),
      stream({ firstWordSec: 2, lastWordSec: 12, tokens: 201 }),
    ]);
    expect(laneSpeed(lane, "tokens/sec")).toBe(15);
    expect(laneThroughput(lane, "tokens/sec")).toBeCloseTo(300 / 11, 10);
  });
});

describe("the scoreboard when each machine ran several streams", () => {
  function pair(a: Partial<LaneResult>[], b: Partial<LaneResult>[]) {
    return [
      { ...combineStreams(a.map((o) => stream({ laneId: "lane-0", label: "Studio", ...o }))) },
      { ...combineStreams(b.map((o) => stream({ laneId: "lane-1", label: "Box", ...o }))) },
    ];
  }

  test("adds a throughput entry, and says the other numbers are medians of the streams", () => {
    const board = buildScoreboard(
      pair(
        [
          { firstWordSec: 1, lastWordSec: 11, tokens: 101, totalSec: 12 },
          { firstWordSec: 1, lastWordSec: 11, tokens: 101, totalSec: 12 },
        ],
        [
          { firstWordSec: 2, lastWordSec: 12, tokens: 51, totalSec: 13 },
          { firstWordSec: 2, lastWordSec: 12, tokens: 51, totalSec: 13 },
        ],
      ),
    );
    expect(board.concurrency).toBe(2);
    expect(board.entries.map((e) => e.measure)).toEqual(["First word", "Speed", "Throughput", "Total time"]);

    const first = board.entries.find((e) => e.measure === "First word")!;
    expect(first.sentence).toContain("(median of 2 streams)");
    const speed = board.entries.find((e) => e.measure === "Speed")!;
    expect(speed.sentence).toContain("per second per stream");
    const total = board.entries.find((e) => e.measure === "Throughput")!;
    expect(total.winnerLabel).toBe("Studio");
    expect(total.sentence).toContain("across all 2 streams");
    // 200 gaps over 10s = 20/s against 100 gaps over 10s = 10/s.
    expect(total.winnerValue).toBeCloseTo(20, 10);
    expect(total.ratio).toBeCloseTo(2, 10);
    expect(board.entries.find((e) => e.measure === "Total time")!.sentence).toContain("all 2 streams");

    // The tile numbers: one stream's speed, and everything together.
    expect(board.laneRates.find((l) => l.laneId === "lane-0")!.rate).toBeCloseTo(10, 10);
    expect(board.laneThroughputs.find((l) => l.laneId === "lane-0")!.rate).toBeCloseTo(20, 10);
  });

  test("a lane that lost a stream is named, and is not ranked on throughput", () => {
    const board = buildScoreboard(
      pair(
        [{ tokens: 101 }, { tokens: 101 }],
        [{ tokens: 101 }, { tokens: null, firstWordSec: null, lastWordSec: null, totalSec: null, error: "HTTP 500" }],
      ),
    );
    expect(board.notes.some((n) => n.startsWith("Box: 1 of 2 streams failed"))).toBe(true);
    expect(board.notes.some((n) => n.startsWith("Box is left out of throughput"))).toBe(true);
    const total = board.entries.find((e) => e.measure === "Throughput")!;
    expect(total.winnerLabel).toBe("Studio");
    expect(total.runnerUpLabel).toBeNull();
    expect(total.sentence).toContain("only lane with every stream finished");
  });

  test("one stream per machine is the scoreboard it always was: no throughput, nothing to explain", () => {
    const board = buildScoreboard([stream({ label: "Studio" }), stream({ laneId: "lane-1", label: "Box", firstWordSec: 2, lastWordSec: 12 })]);
    expect(board.concurrency).toBe(1);
    expect(board.entries.map((e) => e.measure)).toEqual(["First word", "Speed", "Total time"]);
    expect(board.laneThroughputs).toEqual([]);
    expect(board.entries.some((e) => /median|per stream|all \d+ streams/.test(e.sentence))).toBe(false);
  });

  test("one machine on its own is scored without inventing a rival", () => {
    const board = buildScoreboard([stream({ label: "Studio" })]);
    expect(board.entries.map((e) => e.measure)).toEqual(["First word", "Speed", "Total time"]);
    for (const entry of board.entries) {
      expect(entry.ratio).toBeNull();
      expect(entry.runnerUpLabel).toBeNull();
      // Nobody lost, so nobody is "the only lane" to have done anything.
      expect(entry.sentence).not.toContain("only lane");
    }
    expect(board.entries[0]!.sentence).toBe("Studio reached the first word in 1.00s.");
  });

  test("one machine on its own with several streams says whose median it is", () => {
    const solo = combineStreams([stream({ label: "Studio" }), stream({ label: "Studio" })]);
    const board = buildScoreboard([solo]);
    expect(board.entries.map((e) => e.measure)).toEqual(["First word", "Speed", "Throughput", "Total time"]);
    expect(board.entries[0]!.sentence).toBe("Studio reached the first word in 1.00s (median of 2 streams).");
    expect(board.entries[1]!.sentence).toContain("per stream (median of 2 streams)");
    expect(board.entries[2]!.sentence).toContain("across all 2 streams");
    expect(board.entries[3]!.sentence).toContain("all 2 streams in");
  });

  test("when two raced and one fell over, the survivor is still named as the only lane", () => {
    const board = buildScoreboard([stream({ label: "Studio" }), stream({ laneId: "lane-1", label: "Box", error: "HTTP 500", totalSec: null })]);
    expect(board.entries[0]!.sentence).toContain("was the only lane to produce a word");
  });
});

describe("what the page may ask for", () => {
  const limits = { laneIds: ["lane-0", "lane-1"], maxConcurrency: 16 };

  test("an empty request is the old race: every machine, Short, one stream", () => {
    expect(parseRaceRequest({}, limits)).toEqual({
      ok: true,
      request: { preset: "short", laneIds: ["lane-0", "lane-1"], concurrency: 1 },
    });
    expect(parseRaceRequest(null, limits).ok).toBe(true);
  });

  test("takes one machine, a size, and a number of streams", () => {
    expect(parseRaceRequest({ preset: "32k", lanes: ["lane-1"], concurrency: 8 }, limits)).toEqual({
      ok: true,
      request: { preset: "32k", laneIds: ["lane-1"], concurrency: 8 },
    });
  });

  test("keeps the machines in configured order however they were asked for", () => {
    const parsed = parseRaceRequest({ lanes: ["lane-1", "lane-0", "lane-1"] }, limits);
    expect(parsed.ok && parsed.request.laneIds).toEqual(["lane-0", "lane-1"]);
  });

  test("refuses, by name, a choice that is present and wrong, rather than racing something else", () => {
    const bad = (body: unknown) => {
      const r = parseRaceRequest(body, limits);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.error;
    };
    expect(bad({ preset: "9k" })).toContain("Unknown prompt size");
    expect(bad({ preset: 8 })).toContain("Unknown prompt size");
    expect(bad({ lanes: [] })).toContain("at least one machine");
    expect(bad({ lanes: "lane-0" })).toContain("at least one machine");
    expect(bad({ lanes: ["lane-9"] })).toContain("Unknown machine");
    expect(bad({ concurrency: 0 })).toContain("from 1 to 16");
    expect(bad({ concurrency: 17 })).toContain("from 1 to 16");
    expect(bad({ concurrency: 2.5 })).toContain("whole number");
    expect(bad({ concurrency: "4" })).toContain("whole number");
  });
});

describe("the report keeps streams-per-machine apart", () => {
  let seq = 0;
  function rec(over: Partial<RunLogRecord>): RunLogRecord {
    seq += 1;
    return {
      ts: new Date(Date.UTC(2026, 9, 21, 0, 0, seq)).toISOString(),
      runId: `r-${seq}`,
      lane: "Studio",
      baseUrl: "http://localhost:1",
      model: "m",
      preset: "8k",
      promptChars: 100,
      firstResponseSec: 0.5,
      firstWordSec: 1,
      firstWordField: "content",
      lastWordSec: 11,
      chunks: 100,
      tokens: 101,
      tokenSource: "usage",
      totalSec: 12,
      error: null,
      ...over,
    };
  }

  test("a run with four streams is its own row, never pooled with a run of one", () => {
    const rows = buildReport(
      [
        rec({ totalSec: 5 }),
        rec({
          concurrency: 2,
          totalSec: 30,
          streams: [
            { firstWordSec: 1, lastWordSec: 11, chunks: 100, tokens: 101, totalSec: 12 },
            { firstWordSec: 2, lastWordSec: 12, chunks: 200, tokens: 201, totalSec: 13 },
          ],
        }),
      ],
      10,
    );
    expect(rows.map((r) => r.concurrency)).toEqual([1, 2]);
    expect(rows[0]!.medianTotalSec).toBe(5);
    expect(rows[0]!.medianThroughput).toBeNull();
    expect(rows[1]!.medianTotalSec).toBe(30);
    // One stream's median speed: (10 + 20) / 2. And every stream together: 300 gaps over 11s.
    expect(rows[1]!.medianRate).toBe(15);
    expect(rows[1]!.medianThroughput).toBeCloseTo(300 / 11, 10);
  });

  test("the table has the streams column, and explains the two speeds only when it has to", () => {
    const one = formatReport(buildReport([rec({})], 10), 10);
    expect(one).toContain("STREAMS");
    expect(one).not.toContain("ALL STREAMS is every stream together");

    const several = formatReport(
      buildReport(
        [rec({ concurrency: 2, streams: [{ firstWordSec: 1, lastWordSec: 11, chunks: 100, tokens: 101, totalSec: 12 }] })],
        10,
      ),
      10,
    );
    expect(several).toContain("ALL STREAMS is every stream together");
  });
});

describe("the maxConcurrency setting", () => {
  const lane = (label: string, port: number) => ({ label, baseUrl: `http://localhost:${port}`, model: "m" });
  const base = { lanes: [lane("A", 1), lane("B", 2)] };

  test("defaults to 16, and the page offers the powers of two up to it", async () => {
    const { validateConfig } = await import("../src/config.ts");
    const config = validateConfig(base);
    expect(config.maxConcurrency).toBe(16);
    expect(concurrencyOptions(config.maxConcurrency!)).toEqual([1, 2, 4, 8, 16]);
  });

  test("takes a whole number from 1 to 64 and refuses anything else, naming the setting", async () => {
    const { validateConfig } = await import("../src/config.ts");
    expect(validateConfig({ ...base, maxConcurrency: 4 }).maxConcurrency).toBe(4);
    expect(validateConfig({ ...base, maxConcurrency: 64 }).maxConcurrency).toBe(64);
    for (const bad of [0, 65, 2.5, "8"]) {
      expect(() => validateConfig({ ...base, maxConcurrency: bad })).toThrow(/maxConcurrency/);
    }
  });
});

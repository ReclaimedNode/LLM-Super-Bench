import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { presetFit } from "../src/capacity.ts";
import { PROJECT_ROOT, validateConfig } from "../src/config.ts";
import { runRace } from "../src/race.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import {
  MAX_SWEEP_RUNS,
  parseSweepRequest,
  runSweep,
  spread,
  summarizeCell,
  sweepCsv,
} from "../src/sweep.ts";
import type { SweepEvent } from "../src/sweep.ts";
import { MIN_PROMPT_TOKENS_FOR_SPEED, promptSpeed } from "../src/timing.ts";
import type { LaneConfig, LaneResult, RaceConfig } from "../src/types.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({ port: 0, firstWordDelayMs: 10, chunkIntervalMs: 2, chunks: 10, includeUsage: true, ...over });
  servers.push(server);
  return server;
}
const laneFor = (s: Server, label: string): LaneConfig => ({
  label,
  baseUrl: `http://localhost:${s.port}`,
  model: "mock-model",
  displayModel: "mock-model",
});
const raceConfig = (lanes: LaneConfig[]): RaceConfig => ({
  port: 0,
  maxTokens: 512,
  temperature: 0,
  charsPerToken: 4,
  promptFile: "prompts/sample.txt",
  requestTimeoutMs: 20_000,
  preflightTimeoutMs: 10_000,
  lanes,
});

function result(over: Partial<LaneResult> = {}): LaneResult {
  return {
    laneId: "lane-0",
    label: "Studio",
    model: "m",
    displayModel: "m",
    baseUrl: "http://x",
    firstResponseSec: 0.1,
    firstWordSec: 2,
    firstWordField: "content",
    lastWordSec: 12,
    chunks: 101,
    tokens: 101,
    tokenSource: "usage",
    promptTokens: 4000,
    cachedTokens: 0,
    systemFingerprint: null,
    totalSec: 12,
    error: null,
    blocked: null,
    usageSupported: true,
    ...over,
  } as LaneResult;
}

describe("promptSpeed", () => {
  test("prompt tokens over seconds to the first word", () => {
    expect(promptSpeed(result())).toBe(2000);
  });

  test("is left blank wherever it would be a guess", () => {
    expect(promptSpeed(result({ concurrency: 4 }))).toBeNull(); // streams share one prefill
    expect(promptSpeed(result({ firstWordField: "reasoning" }))).toBeNull(); // a thinking model
    expect(promptSpeed(result({ cachedTokens: 3000 }))).toBeNull(); // part of it never processed
    expect(promptSpeed(result({ promptTokens: null }))).toBeNull();
    expect(promptSpeed(result({ promptTokens: MIN_PROMPT_TOKENS_FOR_SPEED - 1 }))).toBeNull(); // a short prompt
    expect(promptSpeed(result({ error: "boom" }))).toBeNull();
    expect(promptSpeed(result({ firstWordSec: null }))).toBeNull();
  });
});

describe("presetFit", () => {
  const presets = [
    { id: "short", targetTokens: 0 },
    { id: "4k", targetTokens: 4096 },
    { id: "32k", targetTokens: 32768 },
  ];

  test("names the machines whose reported context looks too small", () => {
    const fit = presetFit(
      [{ label: "Studio", contextTokens: 32768 }, { label: "Box", contextTokens: 65536 }],
      presets,
      512,
    );
    expect(fit).toEqual({ "32k": ["Studio"] });
  });

  test("a machine that did not report a context is never warned about", () => {
    expect(presetFit([{ label: "Box", contextTokens: null }], presets, 512)).toEqual({});
  });
});

describe("parseSweepRequest", () => {
  const limits = { laneIds: ["lane-0", "lane-1"], maxConcurrency: 16 };

  test("a good request, de-duplicated and sorted", () => {
    const r = parseSweepRequest({ presets: ["4k", "short", "4k"], concurrencies: [4, 1, 4], repeats: 3 }, limits);
    expect(r).toEqual({
      ok: true,
      request: { laneIds: ["lane-0", "lane-1"], presets: ["4k", "short"], concurrencies: [1, 4], repeats: 3, warmup: false },
    });
  });

  test("each wrong thing is refused with a sentence", () => {
    const bad = (body: unknown) => {
      const r = parseSweepRequest(body, limits);
      return r.ok ? null : r.error;
    };
    expect(bad({ concurrencies: [1] })).toContain("prompt size");
    expect(bad({ presets: ["9k"], concurrencies: [1] })).toContain("Unknown prompt size");
    expect(bad({ presets: ["4k"] })).toContain("stream count");
    expect(bad({ presets: ["4k"], concurrencies: [17] })).toContain("1 to 16");
    expect(bad({ presets: ["4k"], concurrencies: [1], repeats: 6 })).toContain("1 to 5");
    expect(bad({ presets: ["4k"], concurrencies: [1], lanes: ["nope"] })).toContain("Unknown machine");
  });

  test("a sweep too big to start by accident is refused", () => {
    const r = parseSweepRequest(
      { presets: ["short", "4k", "8k", "16k", "32k", "64k", "128k"], concurrencies: [1, 2, 4, 8, 16], repeats: 5 },
      limits,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MAX_SWEEP_RUNS));
  });
});

describe("the table", () => {
  test("spread is the median with the lowest and highest, and skips blanks", () => {
    expect(spread([3, 1, null, 2])).toEqual({ median: 2, min: 1, max: 3 });
    expect(spread([null])).toBeNull();
  });

  test("a cell folds its runs into one row per machine, with a failed run left out", () => {
    const runs = [
      [result({ firstWordSec: 1, lastWordSec: 11 })],
      [result({ firstWordSec: 3, lastWordSec: 13 })],
      [result({ error: "connection reset", totalSec: null })],
    ];
    const [row] = summarizeCell("4k", 1, runs);
    expect(row!.repeats).toBe(3);
    expect(row!.finished).toBe(2);
    expect(row!.firstWordSec).toEqual({ median: 2, min: 1, max: 3 });
    expect(row!.speedUnit).toBe("tokens/sec");
    expect(row!.throughput).toBeNull(); // one stream
  });

  test("CSV has a header, quotes what needs quoting and leaves a blank where there is no number", () => {
    const [row] = summarizeCell("4k", 1, [[result({ label: 'Mac, "Studio"' })]]);
    const lines = sweepCsv([row!]).trimEnd().split("\n");
    expect(lines[0]).toStartWith("prompt_size,prompt_tokens,streams_per_machine,machine,");
    expect(lines[1]).toStartWith('4k,4000,1,"Mac, ""Studio""",1,1,2,2,2,tokens/sec,');
    // throughput is blank (",,,") for a one-stream cell
    expect(lines[1]).toContain(",,,");
    expect(lines[0]!.split(",").length).toBe(lines[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).length);
  });
});

describe("runSweep", () => {
  const sourceText = "the quick brown fox jumps over the lazy dog. ".repeat(400);

  test("runs every cell and repeat in order and ends with the table", async () => {
    const a = mock();
    const b = mock();
    const events: SweepEvent[] = [];
    const done = await runSweep({
      config: raceConfig([laneFor(a, "Studio"), laneFor(b, "Box")]),
      sourceText,
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0", "lane-1"], presets: ["short", "4k"], concurrencies: [1, 2], repeats: 2, warmup: false },
      emit: (e) => {
        if (e.type === "sweep-progress" || e.type === "sweep-done") events.push(e);
      },
    });

    const progress = events.filter((e) => e.type === "sweep-progress");
    expect(progress.length).toBe(8);
    expect(progress.map((p) => (p as any).index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(done.complete).toBe(true);
    // 2 sizes x 2 stream counts x 2 machines
    expect(done.rows.length).toBe(8);
    expect(done.rows.every((r) => r.finished === 2 && r.repeats === 2)).toBe(true);
    expect(done.rows.filter((r) => r.concurrency === 2).every((r) => r.throughput !== null)).toBe(true);
    expect(done.rows.filter((r) => r.concurrency === 1).every((r) => r.throughput === null)).toBe(true);
    expect(done.csv.trimEnd().split("\n").length).toBe(9);
  });

  test("stops between races when the page is gone, and reports what it got to", async () => {
    const a = mock();
    const b = mock();
    let races = 0;
    const done = await runSweep({
      config: raceConfig([laneFor(a, "Studio"), laneFor(b, "Box")]),
      sourceText,
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0", "lane-1"], presets: ["short"], concurrencies: [1], repeats: 5, warmup: false },
      shouldStop: () => races >= 2,
      emit: (e) => {
        if (e.type === "sweep-progress") races++;
      },
    });
    expect(done.complete).toBe(false);
    expect(done.rows.length).toBe(2);
    expect(done.rows[0]!.finished).toBe(2);
    expect(done.rows[0]!.repeats).toBe(2);
  });
});

describe("the page", () => {
  const html = readFileSync(resolve(PROJECT_ROOT, "public/index.html"), "utf8");
  const script = readFileSync(resolve(PROJECT_ROOT, "public/app.js"), "utf8");

  test("has the sweep panel wired to the sweep endpoint", () => {
    for (const id of ["sweep-sizes", "sweep-streams", "sweep-repeats", "sweep-start", "sweep-csv", "sweep-rows", "presets-note"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(script).toContain("/api/sweep");
    expect(script).toContain('case "sweep-done"');
  });

  test("shows the prompt-processing line and writes it with textContent", () => {
    expect(html).toContain("prompt-note");
    expect(script).toContain("lanePromptSpeeds");
    expect(script).not.toMatch(/\.innerHTML\s*=/);
  });
});

describe("warm-up", () => {
  const limits = { laneIds: ["lane-0"], maxConcurrency: 16 };

  test("is off unless asked for, and must be a boolean", () => {
    const base = { presets: ["4k"], concurrencies: [1] };
    const off = parseSweepRequest(base, limits);
    expect(off.ok && off.request.warmup).toBe(false);
    const on = parseSweepRequest({ ...base, warmup: true }, limits);
    expect(on.ok && on.request.warmup).toBe(true);
    expect(parseSweepRequest({ ...base, warmup: "yes" }, limits).ok).toBe(false);
  });

  test("one short race runs first, is announced, and is not in the table", async () => {
    const a = mock();
    const seen: string[] = [];
    const done = await runSweep({
      config: raceConfig([laneFor(a, "Studio")]),
      sourceText: "x ".repeat(5000),
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0"], presets: ["4k"], concurrencies: [1], repeats: 1, warmup: true },
      emit: (e) => {
        if (e.type === "sweep-warmup" || e.type === "sweep-progress") seen.push(e.type);
        if (e.type === "race-start") seen.push(`race:${e.preset}`);
      },
    });
    expect(seen).toEqual(["sweep-warmup", "race:short", "sweep-progress", "race:4k"]);
    expect(done.rows.length).toBe(1);
    expect(done.rows[0]!.preset).toBe("4k");
    expect(done.rows[0]!.repeats).toBe(1);
  });
});

describe("a machine's extra request fields", () => {
  const lane = (extra: unknown) => ({
    lanes: [
      { label: "A", baseUrl: "http://a:1", model: "m", ...(extra === undefined ? {} : { extraBody: extra }) },
      { label: "B", baseUrl: "http://b:1", model: "m" },
    ],
  });

  test("kept when valid", () => {
    const cfg = validateConfig(lane({ chat_template_kwargs: { enable_thinking: false } }));
    expect(cfg.lanes[0]!.extraBody).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(cfg.lanes[1]!.extraBody).toBeUndefined();
  });

  test("refused when it is not an object or touches what the race controls", () => {
    for (const bad of [[], "x", 3, null, { temperature: 1 }, { max_tokens: 5 }, { stream: false }, { model: "other" }]) {
      expect(() => validateConfig(lane(bad))).toThrow(/extraBody/);
    }
  });

  test("is sent with that machine's requests and not the other's", async () => {
    const a = mock();
    const b = mock();
    const bodies: Record<string, any> = {};
    const impl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/chat/completions" && typeof init?.body === "string") {
        bodies[url.port] = JSON.parse(init.body);
      }
      return fetch(input, init);
    };
    await runRace({
      config: raceConfig([
        { ...laneFor(a, "Studio"), extraBody: { chat_template_kwargs: { enable_thinking: false } } },
        laneFor(b, "Box"),
      ]),
      preset: "short",
      sourceText: "x",
      emit: () => {},
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      fetchImpl: impl,
    });
    expect(bodies[String(a.port)].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[String(b.port)].chat_template_kwargs).toBeUndefined();
    expect(bodies[String(a.port)].stream).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords } from "../src/log.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { runRace } from "../src/race.ts";
import type { LaneConfig, PresetId, RaceConfig, RaceEvent } from "../src/types.ts";

const servers: Server[] = [];
const dirs: string[] = [];

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({
    port: 0,
    firstWordDelayMs: 10,
    chunkIntervalMs: 2,
    chunks: 10,
    includeUsage: false,
    ...over,
  });
  servers.push(server);
  return server;
}

function laneFor(server: Server, label: string, model = "mock-model"): LaneConfig {
  return { label, baseUrl: `http://localhost:${server.port}`, model, displayModel: model };
}

function configFor(lanes: LaneConfig[]): RaceConfig {
  return {
    port: 0,
    maxTokens: 512,
    temperature: 0,
    charsPerToken: 4,
    promptFile: "prompts/sample.txt",
    requestTimeoutMs: 20_000,
    preflightTimeoutMs: 10_000,
    lanes,
  };
}

async function tempLogPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-race-race-"));
  dirs.push(dir);
  return join(dir, "runs.jsonl");
}

async function race(opts: {
  lanes: LaneConfig[];
  preset?: PresetId;
  logPath?: string | null;
  skipUsageProbe?: boolean;
}) {
  const events: RaceEvent[] = [];
  const outcome = await runRace({
    config: configFor(opts.lanes),
    preset: opts.preset ?? "short",
    sourceText: "the quick brown fox jumps over the lazy dog. ".repeat(50),
    emit: (e) => events.push(e),
    logPath: opts.logPath ?? null,
    skipUsageProbe: opts.skipUsageProbe ?? true,
    tickMs: 20,
  });
  return { outcome, events };
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("a full race against two mock lanes at different speeds", () => {
  test("the scoreboard picks the right winner for every measure", async () => {
    const fast = mock({ firstWordDelayMs: 40, chunkIntervalMs: 3, chunks: 20 });
    const slow = mock({ firstWordDelayMs: 400, chunkIntervalMs: 25, chunks: 20 });

    const { outcome, events } = await race({
      lanes: [laneFor(fast, "Fast Lane"), laneFor(slow, "Slow Lane")],
    });

    const [fastResult, slowResult] = outcome.results;
    expect(fastResult!.error).toBeNull();
    expect(slowResult!.error).toBeNull();
    expect(fastResult!.chunks).toBe(20);
    expect(slowResult!.chunks).toBe(20);

    // The fast lane really was faster on all three measures.
    expect(fastResult!.firstWordSec!).toBeLessThan(slowResult!.firstWordSec!);
    expect(fastResult!.totalSec!).toBeLessThan(slowResult!.totalSec!);

    const board = outcome.scoreboard;
    expect(board.speedUnit).toBe("chunks/sec");
    for (const measure of ["First word", "Speed", "Total time"] as const) {
      const entry = board.entries.find((e) => e.measure === measure)!;
      expect(entry.winnerLabel).toBe("Fast Lane");
      expect(entry.runnerUpLabel).toBe("Slow Lane");
      expect(entry.ratio!).toBeGreaterThan(1);
    }

    // The sentences say it in plain words.
    const firstWord = board.entries.find((e) => e.measure === "First word")!;
    expect(firstWord.sentence).toMatch(/^Fast Lane reached the first word \d+\.\dx faster than Slow Lane/);

    // The stream told the page the same story.
    expect(events.filter((e) => e.type === "race-start")).toHaveLength(1);
    expect(events.filter((e) => e.type === "lane-done")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tick").length).toBeGreaterThan(0);
    expect(events.at(-1)!.type).toBe("race-done");
  });

  test("the lanes run at the same time, not one after the other", async () => {
    const a = mock({ firstWordDelayMs: 300, chunkIntervalMs: 1, chunks: 3 });
    const b = mock({ firstWordDelayMs: 300, chunkIntervalMs: 1, chunks: 3 });

    const started = performance.now();
    const { outcome } = await race({ lanes: [laneFor(a, "Lane A"), laneFor(b, "Lane B")] });
    const wall = (performance.now() - started) / 1000;

    const sum = outcome.results.reduce((acc, r) => acc + (r.totalSec ?? 0), 0);
    expect(sum).toBeGreaterThan(0.55); // two ~0.3s lanes, if they were serialised
    expect(wall).toBeLessThan(sum * 0.8); // but the wall clock shows they overlapped
  });

  test("timing comes from the server: first word lands before the lane finishes", async () => {
    const a = mock({ firstWordDelayMs: 120, chunkIntervalMs: 5, chunks: 10 });
    const { outcome, events } = await race({ lanes: [laneFor(a, "Lane A"), laneFor(mock(), "Lane B")] });

    const result = outcome.results.find((r) => r.label === "Lane A")!;
    expect(result.firstWordSec!).toBeGreaterThan(0.1);
    expect(result.firstWordSec!).toBeLessThan(result.totalSec!);

    const firstWordEvent = events.find((e) => e.type === "first-word" && e.laneId === result.laneId);
    expect(firstWordEvent).toBeDefined();
    expect((firstWordEvent as { firstWordSec: number }).firstWordSec).toBe(result.firstWordSec!);
  });
});

describe("speed honesty", () => {
  test("uses real token counts when both endpoints report usage", async () => {
    const a = mock({ includeUsage: true, chunks: 12, firstWordDelayMs: 20, chunkIntervalMs: 2 });
    const b = mock({ includeUsage: true, chunks: 12, firstWordDelayMs: 60, chunkIntervalMs: 8 });

    const { outcome } = await race({ lanes: [laneFor(a, "Lane A"), laneFor(b, "Lane B")] });

    for (const r of outcome.results) {
      expect(r.tokenSource).toBe("usage");
      expect(r.tokens).toBe(15); // the mock reports chunks + 3, so a token is not a chunk
      expect(r.chunks).toBe(12);
      expect(r.usageSupported).toBe(true);
    }
    expect(outcome.scoreboard.speedUnit).toBe("tokens/sec");
    expect(outcome.scoreboard.entries.find((e) => e.measure === "Speed")!.unit).toBe("tokens/sec");
  });

  test("falls back to chunks/sec and says so when an endpoint reports no usage", async () => {
    const a = mock({ includeUsage: true, chunks: 12 });
    const b = mock({ includeUsage: false, chunks: 12 });

    const { outcome } = await race({ lanes: [laneFor(a, "Lane A"), laneFor(b, "Lane B")] });

    expect(outcome.results.find((r) => r.label === "Lane A")!.tokens).toBe(15);
    expect(outcome.results.find((r) => r.label === "Lane B")!.tokens).toBeNull();
    expect(outcome.scoreboard.speedUnit).toBe("chunks/sec");
    expect(outcome.scoreboard.notes.some((n) => n.includes("not tokens"))).toBe(true);
  });

  // A server that opens with {"role":"assistant","content":""} answers
  // instantly but has not said a word. Counting that as the first word would
  // report a first-word time of nearly zero, which is nonsense.
  test("an instant empty chunk is a first response, not a first word", async () => {
    const chatty = mock({
      leadingEmptyChunks: 1,
      firstWordDelayMs: 500,
      chunkIntervalMs: 2,
      chunks: 10,
    });
    const plain = mock({ firstWordDelayMs: 20, chunkIntervalMs: 2, chunks: 10 });

    const { outcome, events } = await race({ lanes: [laneFor(chatty, "Chatty"), laneFor(plain, "Plain")] });
    const result = outcome.results.find((r) => r.label === "Chatty")!;

    // First word is near 500ms, not near 0.
    expect(result.firstWordSec!).toBeGreaterThan(0.45);
    expect(result.firstWordSec!).toBeLessThan(0.9);

    // The empty chunk still counted as a response, and arrived long before it.
    expect(result.firstResponseSec!).toBeLessThan(0.2);
    expect(result.firstResponseSec!).toBeLessThan(result.firstWordSec!);

    // It is not counted as output either.
    expect(result.chunks).toBe(10);
    expect(result.firstWordField).toBe("content");

    // Both are reported to the page as separate events.
    const response = events.find((e) => e.type === "first-response" && e.laneId === result.laneId);
    const word = events.find((e) => e.type === "first-word" && e.laneId === result.laneId);
    expect(response).toBeDefined();
    expect(word).toBeDefined();
    expect((response as { firstResponseSec: number }).firstResponseSec).toBe(result.firstResponseSec!);
    expect((word as { firstWordSec: number }).firstWordSec).toBe(result.firstWordSec!);

    // And the scoreboard scores the word, so the chatty lane does not "win".
    const firstWord = outcome.scoreboard.entries.find((e) => e.measure === "First word")!;
    expect(firstWord.winnerLabel).toBe("Plain");
  });

  test("a lane with no empty lead has its first response on the same chunk as its first word", async () => {
    const plain = mock({ firstWordDelayMs: 150, chunkIntervalMs: 2, chunks: 6 });
    const { outcome } = await race({ lanes: [laneFor(plain, "Plain"), laneFor(mock(), "Other")] });
    const r = outcome.results.find((x) => x.label === "Plain")!;
    expect(r.firstResponseSec!).toBe(r.firstWordSec!);
  });

  test("speed is measured between the first and last piece, excluding the wait", async () => {
    // 21 chunks, 10ms apart, after a 600ms wait: ~200ms of streaming, 20 gaps
    // -> ~100/sec. Dividing by total time would have said ~26/sec.
    const lane = mock({ firstWordDelayMs: 600, chunkIntervalMs: 10, chunks: 21 });
    const { outcome } = await race({ lanes: [laneFor(lane, "Lane A"), laneFor(mock(), "Lane B")] });
    const r = outcome.results.find((x) => x.label === "Lane A")!;

    const rate = (r.chunks - 1) / (r.lastWordSec! - r.firstWordSec!);
    const naive = r.chunks / r.totalSec!;
    expect(rate).toBeGreaterThan(naive * 2);

    const speed = outcome.scoreboard.entries.find((e) => e.measure === "Speed")!;
    const mine = speed.winnerLabel === "Lane A" ? speed.winnerValue : speed.runnerUpValue!;
    expect(mine).toBeCloseTo(rate, 6);

    // The window ends at the last piece of text, not at the end of the stream.
    expect(r.lastWordSec!).toBeLessThanOrEqual(r.totalSec!);
  });

  test("records which streamed field carried the first word", async () => {
    const thinker = mock({ reasoningChunks: 3, firstWordDelayMs: 20, chunkIntervalMs: 2, chunks: 5 });
    const plain = mock({ firstWordDelayMs: 20, chunkIntervalMs: 2, chunks: 5 });

    const { outcome, events } = await race({ lanes: [laneFor(thinker, "Thinker"), laneFor(plain, "Plain")] });

    expect(outcome.results.find((r) => r.label === "Thinker")!.firstWordField).toBe("reasoning");
    expect(outcome.results.find((r) => r.label === "Plain")!.firstWordField).toBe("content");
    // Reasoning chunks count toward the stream but are marked as reasoning.
    expect(outcome.results.find((r) => r.label === "Thinker")!.chunks).toBe(8);
    const reasoningDeltas = events.filter((e) => e.type === "delta" && e.field === "reasoning");
    expect(reasoningDeltas).toHaveLength(3);
  });
});

describe("a broken lane does not stop the race", () => {
  test("an endpoint that errors is reported while the other lane keeps going", async () => {
    const good = mock({ firstWordDelayMs: 20, chunkIntervalMs: 2, chunks: 8 });
    const bad = mock({ failWithStatus: 500 });

    const { outcome, events } = await race({ lanes: [laneFor(good, "Good"), laneFor(bad, "Bad")] });

    const goodResult = outcome.results.find((r) => r.label === "Good")!;
    const badResult = outcome.results.find((r) => r.label === "Bad")!;
    expect(goodResult.error).toBeNull();
    expect(goodResult.totalSec).toBeGreaterThan(0);
    expect(badResult.error).toContain("HTTP 500");
    expect(badResult.totalSec).toBeNull();

    expect(events.some((e) => e.type === "lane-error" && e.message.includes("HTTP 500"))).toBe(true);
    expect(outcome.scoreboard.entries.every((e) => e.winnerLabel === "Good")).toBe(true);
    expect(outcome.scoreboard.notes.some((n) => n.startsWith("Bad failed:"))).toBe(true);
  });

  test("a lane whose model the endpoint does not list is refused before any request", async () => {
    const good = mock({ firstWordDelayMs: 10, chunkIntervalMs: 1, chunks: 4 });
    const other = mock();

    const { outcome, events } = await race({
      lanes: [laneFor(good, "Good"), laneFor(other, "Typo", "qwen3-14b-4bitt")],
    });

    const blocked = outcome.results.find((r) => r.label === "Typo")!;
    expect(blocked.blocked).toContain("does not have the configured model");
    expect(blocked.totalSec).toBeNull();
    expect(events.some((e) => e.type === "lane-blocked")).toBe(true);
    // It never started, so there is no lane-start for it.
    expect(events.some((e) => e.type === "lane-start" && e.laneId === blocked.laneId)).toBe(false);
    expect(outcome.results.find((r) => r.label === "Good")!.totalSec).toBeGreaterThan(0);
    expect(outcome.scoreboard.notes.some((n) => n.startsWith("Typo will not start:"))).toBe(true);
  });
});

describe("the run log", () => {
  test("a race appends one JSON line per lane with the measured numbers", async () => {
    const logPath = await tempLogPath();
    const a = mock({ includeUsage: true, firstWordDelayMs: 20, chunkIntervalMs: 2, chunks: 6 });
    const b = mock({ failWithStatus: 503 });

    const { outcome } = await race({ lanes: [laneFor(a, "Lane A"), laneFor(b, "Lane B")], logPath, preset: "8k" });

    const records = await readRecords(logPath);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.lane)).toEqual(["Lane A", "Lane B"]);

    const [first, second] = records;
    expect(first!.runId).toBe(outcome.runId);
    expect(first!.preset).toBe("8k");
    expect(first!.promptChars).toBe(outcome.promptChars);
    expect(first!.baseUrl).toBe(`http://localhost:${a.port}`);
    expect(first!.model).toBe("mock-model");
    expect(first!.firstWordSec).toBeGreaterThan(0);
    expect(first!.firstWordField).toBe("content");
    expect(first!.chunks).toBe(6);
    expect(first!.tokens).toBe(9);
    expect(first!.tokenSource).toBe("usage");
    expect(first!.totalSec).toBeGreaterThan(first!.firstWordSec!);
    expect(first!.error).toBeNull();

    expect(second!.error).toContain("HTTP 503");
    expect(second!.totalSec).toBeNull();

    // A second race appends rather than replacing.
    await race({ lanes: [laneFor(a, "Lane A"), laneFor(a, "Lane B")], logPath, preset: "short" });
    expect(await readRecords(logPath)).toHaveLength(4);
  });

  test("the prompt sent to each lane carries a fresh run id", async () => {
    const a = mock({ firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 2 });
    const first = await race({ lanes: [laneFor(a, "Lane A"), laneFor(a, "Lane B")] });
    const second = await race({ lanes: [laneFor(a, "Lane A"), laneFor(a, "Lane B")] });
    expect(first.outcome.runId).not.toBe(second.outcome.runId);
  });
});

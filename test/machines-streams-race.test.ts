import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords } from "../src/log.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { runRace } from "../src/race.ts";
import type { LaneConfig, RaceConfig, RaceEvent } from "../src/types.ts";

const servers: Server[] = [];
const dirs: string[] = [];

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({
    port: 0,
    firstWordDelayMs: 10,
    chunkIntervalMs: 2,
    chunks: 10,
    includeUsage: true,
    ...over,
  });
  servers.push(server);
  return server;
}

function laneFor(server: Server, label: string): LaneConfig {
  return { label, baseUrl: `http://localhost:${server.port}`, model: "mock-model", displayModel: "mock-model" };
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

interface Seen {
  port: string;
  prompt: string;
}

/** A fetch that remembers every prompt it was asked to send, and can fail chosen ones. */
function recording(failWhen?: (prompt: string, port: string) => boolean) {
  const seen: Seen[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/chat/completions" && typeof init?.body === "string") {
      const prompt = (JSON.parse(init.body) as { messages: { content: string }[] }).messages[0]!.content;
      seen.push({ port: url.port, prompt });
      if (failWhen?.(prompt, url.port)) throw new Error("connection reset");
    }
    return fetch(input, init);
  };
  return { seen, impl };
}

async function race(opts: {
  lanes: LaneConfig[];
  laneIds?: string[];
  concurrency?: number;
  fetchImpl?: typeof fetch;
  logPath?: string | null;
}) {
  const events: RaceEvent[] = [];
  const outcome = await runRace({
    config: configFor(opts.lanes),
    preset: "short",
    sourceText: "the quick brown fox jumps over the lazy dog. ".repeat(50),
    emit: (e) => events.push(e),
    logPath: opts.logPath ?? null,
    skipUsageProbe: true,
    tickMs: 20,
    laneIds: opts.laneIds,
    concurrency: opts.concurrency,
    fetchImpl: opts.fetchImpl,
  });
  return { outcome, events };
}

afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("one machine on its own, or head to head", () => {
  test("picking one machine races that machine and never touches the other", async () => {
    const a = mock();
    const b = mock();
    const { seen, impl } = recording();

    const { outcome, events } = await race({
      lanes: [laneFor(a, "Studio"), laneFor(b, "Box")],
      laneIds: ["lane-1"],
      fetchImpl: impl,
    });

    expect(outcome.results.map((r) => r.label)).toEqual(["Box"]);
    expect(outcome.results[0]!.error).toBeNull();
    expect(seen.map((s) => s.port)).toEqual([String(b.port)]);

    const start = events.find((e) => e.type === "race-start") as Extract<RaceEvent, { type: "race-start" }>;
    expect(start.lanes.map((l) => l.label)).toEqual(["Box"]);
    // The lane keeps the id it has in the config, so the page can find its tile.
    expect(start.lanes[0]!.laneId).toBe("lane-1");
    expect(events.filter((e) => e.type === "lane-done")).toHaveLength(1);
  });

  test("a single machine gets a result, not a made-up winner", async () => {
    const a = mock();
    const b = mock();
    const { outcome } = await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], laneIds: ["lane-0"] });
    for (const entry of outcome.scoreboard.entries) {
      expect(entry.winnerLabel).toBe("Studio");
      expect(entry.runnerUpLabel).toBeNull();
      expect(entry.ratio).toBeNull();
    }
    expect(outcome.scoreboard.laneRates).toHaveLength(1);
  });

  test("head to head is the default and races everything", async () => {
    const a = mock();
    const b = mock();
    const { outcome } = await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")] });
    expect(outcome.results.map((r) => r.label)).toEqual(["Studio", "Box"]);
  });

  test("a race with nobody in it is refused instead of silently doing nothing", async () => {
    const a = mock();
    const b = mock();
    await expect(race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], laneIds: ["lane-9"] })).rejects.toThrow(
      "No machine",
    );
  });

  test("the log gets one line for the one machine that raced", async () => {
    const a = mock();
    const b = mock();
    const dir = await mkdtemp(join(tmpdir(), "llm-race-one-"));
    dirs.push(dir);
    const logPath = join(dir, "runs.jsonl");
    await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], laneIds: ["lane-0"], logPath });
    const records = await readRecords(logPath);
    expect(records.map((r) => r.lane)).toEqual(["Studio"]);
    // A one-stream line is the line it always was.
    expect("concurrency" in records[0]!).toBe(false);
    expect("streams" in records[0]!).toBe(false);
  });
});

describe("several streams on each machine", () => {
  test("every machine gets the same number of requests, and stream N reads the same prompt on both", async () => {
    const a = mock();
    const b = mock();
    const { seen, impl } = recording();

    const { outcome } = await race({
      lanes: [laneFor(a, "Studio"), laneFor(b, "Box")],
      concurrency: 4,
      fetchImpl: impl,
    });

    const forPort = (port: number) => seen.filter((s) => s.port === String(port)).map((s) => s.prompt);
    const onA = forPort(a.port!);
    const onB = forPort(b.port!);
    expect(onA).toHaveLength(4);
    expect(onB).toHaveLength(4);

    // No two streams on a machine share a prompt, so no cache can serve one from another.
    expect(new Set(onA).size).toBe(4);
    for (const prompt of onA) expect(prompt).toMatch(/^\[race-run [^\]]+-s[1-4]\]/);

    // And the machines are asked the same four things.
    expect([...onA].sort()).toEqual([...onB].sort());

    for (const r of outcome.results) {
      expect(r.concurrency).toBe(4);
      expect(r.failedStreams).toBe(0);
      expect(r.streams).toHaveLength(4);
      expect(r.chunks).toBe(40);
    }
  });

  test("the lanes start every stream in the same tick, not one after the other", async () => {
    const a = mock({ firstWordDelayMs: 300, chunkIntervalMs: 1, chunks: 3 });
    const b = mock({ firstWordDelayMs: 300, chunkIntervalMs: 1, chunks: 3 });
    const started = performance.now();
    const { outcome } = await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], concurrency: 4 });
    const wall = (performance.now() - started) / 1000;

    // Eight streams of ~0.3s. Run one after another that is over two seconds.
    expect(wall).toBeLessThan(1.2);
    for (const r of outcome.results) expect(r.totalSec!).toBeLessThan(1);
  });

  test("the page hears one start, one first word and one finish per lane, and one stream's text", async () => {
    const a = mock();
    const b = mock();
    const { events } = await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], concurrency: 4 });

    for (const laneId of ["lane-0", "lane-1"]) {
      expect(events.filter((e) => e.type === "lane-start" && e.laneId === laneId)).toHaveLength(1);
      expect(events.filter((e) => e.type === "first-word" && e.laneId === laneId)).toHaveLength(1);
      expect(events.filter((e) => e.type === "lane-done" && e.laneId === laneId)).toHaveLength(1);
      // Ten chunks from the one stream whose text is shown, not forty from all of them.
      expect(events.filter((e) => e.type === "delta" && e.laneId === laneId)).toHaveLength(10);
    }

    const word = events.find((e) => e.type === "first-word") as Extract<RaceEvent, { type: "first-word" }>;
    expect(word.streams).toBe(4);

    const done = events.find((e) => e.type === "lane-done") as Extract<RaceEvent, { type: "lane-done" }>;
    expect(done.streams).toBe(4);
    expect(done.failedStreams).toBe(0);
    expect(done.chunks).toBe(40);
    expect(done.throughput).not.toBeNull();

    const tick = events.filter((e) => e.type === "tick").at(-1) as Extract<RaceEvent, { type: "tick" }>;
    for (const lane of tick.lanes) {
      expect(lane.done).toBe(true);
      expect(lane.streams).toEqual({ total: 4, streaming: 0, done: 4 });
    }
  });

  test("the scoreboard compares throughput, and the tiles and board agree", async () => {
    const quick = mock({ chunkIntervalMs: 2, chunks: 30 });
    const slow = mock({ chunkIntervalMs: 12, chunks: 30 });
    const { outcome } = await race({ lanes: [laneFor(quick, "Quick"), laneFor(slow, "Slow")], concurrency: 3 });

    const board = outcome.scoreboard;
    expect(board.concurrency).toBe(3);
    const entry = board.entries.find((e) => e.measure === "Throughput")!;
    expect(entry.winnerLabel).toBe("Quick");
    expect(entry.ratio!).toBeGreaterThan(1);
    expect(board.laneThroughputs).toHaveLength(2);
    expect(board.laneThroughputs.find((l) => l.laneId === "lane-0")!.rate).toBeCloseTo(entry.winnerValue, 6);
  });

  test("one stream failing is named and does not sink the lane", async () => {
    const a = mock();
    const b = mock();
    const { impl } = recording((prompt, port) => port === String(b.port) && prompt.includes("-s2]"));

    const { outcome, events } = await race({
      lanes: [laneFor(a, "Studio"), laneFor(b, "Box")],
      concurrency: 4,
      fetchImpl: impl,
    });

    const box = outcome.results.find((r) => r.label === "Box")!;
    expect(box.error).toBeNull();
    expect(box.failedStreams).toBe(1);
    expect(box.streams).toHaveLength(3);
    expect(box.chunks).toBe(30);

    const done = events.find((e) => e.type === "lane-done" && e.laneId === "lane-1") as Extract<RaceEvent, { type: "lane-done" }>;
    expect(done.failedStreams).toBe(1);
    // The stream's own failure is not the lane's.
    expect(events.some((e) => e.type === "lane-error")).toBe(false);

    expect(outcome.scoreboard.notes.some((n) => n.startsWith("Box: 1 of 4 streams failed"))).toBe(true);
    expect(outcome.scoreboard.notes.some((n) => n.startsWith("Box is left out of throughput"))).toBe(true);
  });

  test("a lane whose every stream fails is a failed lane, with the reason", async () => {
    const good = mock();
    const bad = mock({ failWithStatus: 500 });
    const { outcome, events } = await race({
      lanes: [laneFor(good, "Good"), laneFor(bad, "Bad")],
      concurrency: 3,
    });

    const result = outcome.results.find((r) => r.label === "Bad")!;
    expect(result.error).toMatch(/^all 3 streams failed: HTTP 500/);
    const errors = events.filter((e) => e.type === "lane-error");
    expect(errors).toHaveLength(1);
    expect(outcome.scoreboard.notes.some((n) => n.startsWith("Bad failed: all 3 streams failed"))).toBe(true);
    expect(outcome.scoreboard.entries.every((e) => e.winnerLabel === "Good")).toBe(true);
  });

  test("the log records the streams, so the report can read them back", async () => {
    const a = mock();
    const b = mock();
    const dir = await mkdtemp(join(tmpdir(), "llm-race-streams-"));
    dirs.push(dir);
    const logPath = join(dir, "runs.jsonl");

    await race({ lanes: [laneFor(a, "Studio"), laneFor(b, "Box")], concurrency: 2, logPath });
    const records = await readRecords(logPath);
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.concurrency).toBe(2);
      expect(r.failedStreams).toBe(0);
      expect(r.streams).toHaveLength(2);
      expect(r.chunks).toBe(20);
    }
  });

  test("one machine and several streams work together", async () => {
    const a = mock();
    const b = mock();
    const { outcome } = await race({
      lanes: [laneFor(a, "Studio"), laneFor(b, "Box")],
      laneIds: ["lane-1"],
      concurrency: 2,
    });
    expect(outcome.results.map((r) => r.label)).toEqual(["Box"]);
    expect(outcome.results[0]!.concurrency).toBe(2);
    expect(outcome.scoreboard.laneThroughputs).toHaveLength(1);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { UNKNOWN_CAPACITY, probeCapacity, readProps, streamChoices, streamLimit } from "../src/capacity.ts";
import { validateConfig } from "../src/config.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { runRace } from "../src/race.ts";
import type { LaneConfig, RaceConfig, RaceEvent } from "../src/types.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({ port: 0, firstWordDelayMs: 10, chunkIntervalMs: 2, chunks: 10, includeUsage: true, ...over });
  servers.push(server);
  return server;
}

const laneFor = (server: Server, label: string, extra: Partial<LaneConfig> = {}): LaneConfig => ({
  label,
  baseUrl: `http://localhost:${server.port}`,
  model: "mock-model",
  displayModel: "mock-model",
  ...extra,
});

describe("readProps", () => {
  test("reads slots and context from a llama-server body", () => {
    expect(readProps({ total_slots: 2, default_generation_settings: { n_ctx: 65536 } })).toEqual({
      slots: 2,
      contextTokens: 65536,
      source: "server",
    });
  });

  test("slots without a context still count", () => {
    expect(readProps({ total_slots: 4 })).toEqual({ slots: 4, contextTokens: null, source: "server" });
  });

  test("anything else is unknown, not an error", () => {
    for (const body of [null, "x", 3, {}, { total_slots: 0 }, { total_slots: 1.5 }, { total_slots: "2" }]) {
      expect(readProps(body)).toEqual(UNKNOWN_CAPACITY);
    }
  });
});

describe("probeCapacity", () => {
  test("asks the server's /props", async () => {
    const server = mock({ slots: 3, contextTokens: 8192 });
    expect(await probeCapacity(laneFor(server, "A"))).toEqual({ slots: 3, contextTokens: 8192, source: "server" });
  });

  test("a number in the config wins and the server is not asked", async () => {
    const server = mock({ slots: 3 });
    let asked = false;
    const result = await probeCapacity(laneFor(server, "A", { slots: 8 }), {
      fetchImpl: (async () => {
        asked = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ slots: 8, contextTokens: null, source: "config" });
    expect(asked).toBe(false);
  });

  test("a server with no /props is unknown", async () => {
    const server = mock();
    expect(await probeCapacity(laneFor(server, "A"))).toEqual(UNKNOWN_CAPACITY);
  });

  test("a machine that is down is unknown and does not throw", async () => {
    const server = mock();
    const lane = laneFor(server, "A");
    server.stop(true);
    expect(await probeCapacity(lane, { timeoutMs: 500 })).toEqual(UNKNOWN_CAPACITY);
  });

  test("a machine that never answers is given up on", async () => {
    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const started = performance.now();
    const result = await probeCapacity({ label: "A", baseUrl: "http://x", model: "m", displayModel: "m" }, { timeoutMs: 50, fetchImpl: hang });
    expect(result).toEqual(UNKNOWN_CAPACITY);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("streamChoices and streamLimit", () => {
  test("powers of two, plus the maximum itself when it is not one", () => {
    expect(streamChoices(1)).toEqual([1]);
    expect(streamChoices(2)).toEqual([1, 2]);
    expect(streamChoices(3)).toEqual([1, 2, 3]);
    expect(streamChoices(8)).toEqual([1, 2, 4, 8]);
    expect(streamChoices(10)).toEqual([1, 2, 4, 8, 10]);
  });

  const cap = (slots: number | null) => ({ slots, contextTokens: null, source: slots === null ? null : ("server" as const) });

  test("the smallest known machine decides", () => {
    expect(streamLimit([cap(4), cap(2)], 16)).toEqual({ max: 2, unknown: 0, options: [1, 2] });
  });

  test("the configured maximum still caps it", () => {
    expect(streamLimit([cap(64), cap(32)], 16).max).toBe(16);
  });

  test("a machine that can't say does not lower it, and is counted", () => {
    expect(streamLimit([cap(4), cap(null)], 16)).toEqual({ max: 4, unknown: 1, options: [1, 2, 4] });
  });

  test("nobody can say: the config's maximum stands", () => {
    expect(streamLimit([cap(null), cap(null)], 16)).toEqual({ max: 16, unknown: 2, options: [1, 2, 4, 8, 16] });
  });
});

describe("config slots", () => {
  const base = (slots?: unknown) => ({
    lanes: [
      { label: "A", baseUrl: "http://a:1", model: "m", ...(slots === undefined ? {} : { slots }) },
      { label: "B", baseUrl: "http://b:1", model: "m" },
    ],
  });

  test("is kept when valid", () => {
    expect(validateConfig(base(4)).lanes[0]!.slots).toBe(4);
    expect(validateConfig(base()).lanes[0]!.slots).toBeUndefined();
  });

  test("is refused when not a whole number from 1 to 1024", () => {
    for (const bad of [0, -1, 1.5, "2", 1025, null]) {
      expect(() => validateConfig(base(bad))).toThrow(/slots/);
    }
  });
});

describe("a race that asks for more than a machine runs at once", () => {
  const config = (lanes: LaneConfig[]): RaceConfig => ({
    port: 0,
    maxTokens: 512,
    temperature: 0,
    charsPerToken: 4,
    promptFile: "prompts/sample.txt",
    requestTimeoutMs: 20_000,
    preflightTimeoutMs: 10_000,
    lanes,
  });

  async function run(laneSlots: Record<string, number | null>, concurrency: number) {
    const a = mock();
    const b = mock();
    const events: RaceEvent[] = [];
    const outcome = await runRace({
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      preset: "short",
      sourceText: "the quick brown fox jumps over the lazy dog. ".repeat(50),
      emit: (e) => events.push(e),
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      concurrency,
      laneSlots,
    });
    return outcome;
  }

  test("the scoreboard says streams waited in the queue", async () => {
    const outcome = await run({ "lane-0": 2, "lane-1": 8 }, 4);
    expect(outcome.results.find((r) => r.label === "Studio")!.slots).toBe(2);
    const notes = outcome.scoreboard.notes.join("\n");
    expect(notes).toContain("Studio runs 2 at a time");
    expect(notes).toContain("2 of the 4 streams waited");
    expect(notes).not.toContain("Box runs");
  });

  test("no note when the streams fit, or when the slots are not known", async () => {
    const fits = await run({ "lane-0": 4, "lane-1": 4 }, 4);
    expect(fits.scoreboard.notes.join("\n")).not.toContain("at a time");
    const unknown = await run({ "lane-0": null, "lane-1": null }, 4);
    expect(unknown.results.every((r) => r.slots === undefined)).toBe(true);
    expect(unknown.scoreboard.notes.join("\n")).not.toContain("at a time");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "../src/config.ts";
import { STOPPED_MESSAGE } from "../src/lane.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { runRace } from "../src/race.ts";
import { runSweep } from "../src/sweep.ts";
import type { LaneConfig, RaceConfig, RaceEvent } from "../src/types.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A mock that streams for about four seconds, so a stop clearly beats the end. */
function slowMock(over: Partial<MockLaneOptions> = {}): Server {
  const s = startMockLane({ port: 0, firstWordDelayMs: 10, chunkIntervalMs: 20, chunks: 200, includeUsage: true, ...over });
  servers.push(s);
  return s;
}
const laneFor = (s: Server, label: string): LaneConfig => ({
  label,
  baseUrl: `http://localhost:${s.port}`,
  model: "mock-model",
  displayModel: "mock-model",
});
const config = (lanes: LaneConfig[]): RaceConfig => ({
  port: 0,
  maxTokens: 512,
  temperature: 0,
  charsPerToken: 4,
  promptFile: "p",
  requestTimeoutMs: 20_000,
  preflightTimeoutMs: 10_000,
  lanes,
});
const base = { sourceText: "x ".repeat(2000), logPath: null, skipUsageProbe: true, tickMs: 20 } as const;

describe("stopping a race", () => {
  test("cuts every request off at once and marks each lane stopped, not failed", async () => {
    const a = slowMock();
    const b = slowMock();
    const controller = new AbortController();
    const events: RaceEvent[] = [];
    setTimeout(() => controller.abort(), 300);

    const started = performance.now();
    const outcome = await runRace({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      preset: "short",
      emit: (e) => events.push(e),
      signal: controller.signal,
    });
    const took = performance.now() - started;

    expect(took).toBeLessThan(2000); // the stream alone would take about 4 seconds
    expect(outcome.results.every((r) => r.stopped === true && r.error === STOPPED_MESSAGE)).toBe(true);
    const errors = events.filter((e) => e.type === "lane-error") as Extract<RaceEvent, { type: "lane-error" }>[];
    expect(errors.length).toBe(2);
    expect(errors.every((e) => e.stopped === true)).toBe(true);
    const notes = outcome.scoreboard.notes.join("\n");
    expect(notes).toContain("Studio was stopped before it finished, so it is not scored.");
    expect(notes).not.toContain("failed");
  });

  test("several streams per machine are stopped as a whole", async () => {
    const a = slowMock();
    const b = slowMock();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const outcome = await runRace({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      preset: "short",
      emit: () => {},
      concurrency: 3,
      signal: controller.signal,
    });
    expect(outcome.results.every((r) => r.stopped === true && r.error === STOPPED_MESSAGE)).toBe(true);
    expect(outcome.results.every((r) => !r.error?.includes("streams failed"))).toBe(true);
  });

  test("a signal that is already aborted stops every lane at once", async () => {
    const a = slowMock();
    const b = slowMock();
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    const outcome = await runRace({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      preset: "short",
      emit: () => {},
      signal: controller.signal,
    });
    expect(outcome.results.every((r) => r.stopped)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("the server on the other end sees the connection close, so it can stop generating", async () => {
    let gone = false;
    let lastSent = 0;
    const fake = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock-model" }] });
        let timer: ReturnType<typeof setInterval>;
        return new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              timer = setInterval(() => {
                lastSent++;
                controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "w " } }] })}\n\n`));
              }, 10);
            },
            // llama-server stops the slot when this happens.
            cancel() {
              gone = true;
              clearInterval(timer);
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      },
    });
    servers.push(fake);
    const other = slowMock();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    await runRace({
      ...base,
      config: config([laneFor(fake, "Fake"), laneFor(other, "Box")]),
      preset: "short",
      emit: () => {},
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(gone).toBe(true);
    const atClose = lastSent;
    await new Promise((r) => setTimeout(r, 200));
    expect(lastSent).toBe(atClose); // nothing more was produced after the close
  });

  test("without a stop, nothing changes", async () => {
    const a = startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 5, includeUsage: true });
    const b = startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 5, includeUsage: true });
    servers.push(a, b);
    const outcome = await runRace({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      preset: "short",
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(outcome.results.every((r) => !r.stopped && r.error === null)).toBe(true);
  });
});

describe("stopping a sweep", () => {
  test("ends it, leaves the race that was cut off out of the table, keeps the ones that finished", async () => {
    const quick = () => {
      const s = startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 5, includeUsage: true });
      servers.push(s);
      return s;
    };
    const a = quick();
    const b = quick();
    const controller = new AbortController();
    let races = 0;
    const done = await runSweep({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      pauseMs: 0,
      signal: controller.signal,
      request: { laneIds: ["lane-0", "lane-1"], presets: ["short"], concurrencies: [1], repeats: 5, warmup: false },
      emit: (e) => {
        // Stop while the third race is starting.
        if (e.type === "sweep-progress" && ++races === 3) controller.abort();
      },
    });
    expect(done.complete).toBe(false);
    expect(done.stopped).toBe(true);
    // Two races finished before the third was cut off; the third is not counted.
    expect(done.rows.length).toBe(2);
    expect(done.rows[0]!.repeats).toBe(2);
    expect(done.rows[0]!.finished).toBe(2);
  });

  test("a stop before it starts runs nothing", async () => {
    const a = slowMock();
    const b = slowMock();
    const controller = new AbortController();
    controller.abort();
    const done = await runSweep({
      ...base,
      config: config([laneFor(a, "Studio"), laneFor(b, "Box")]),
      pauseMs: 0,
      signal: controller.signal,
      request: { laneIds: ["lane-0", "lane-1"], presets: ["short"], concurrencies: [1], repeats: 2, warmup: true },
      emit: () => {},
    });
    expect(done.rows).toEqual([]);
    expect(done.stopped).toBe(true);
  });
});

describe("the page", () => {
  const html = readFileSync(resolve(PROJECT_ROOT, "public/index.html"), "utf8");
  const script = readFileSync(resolve(PROJECT_ROOT, "public/app.js"), "utf8");
  test("has a STOP button that is hidden until something runs and calls /api/stop", () => {
    expect(html).toMatch(/id="stop"[^>]*hidden/);
    expect(script).toContain("/api/stop");
    expect(script).toContain('event.stopped ? "STOPPED" : "FAILED"');
  });

  test("the server hands the run's own abort signal to the job (it once reached the stream's controller by mistake)", () => {
    const server = readFileSync(resolve(PROJECT_ROOT, "src/server.ts"), "utf8");
    expect(server).toContain("stopper.signal");
    expect(server).toContain("currentRun === stopper");
  });
});

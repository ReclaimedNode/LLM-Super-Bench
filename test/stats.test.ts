/**
 * The live strip under each lane.
 *
 * Two things here are wrong silently and expensively. A reading rounded or
 * scaled the wrong way puts a number on camera that is not what the machine
 * said -- a 256GB Mac showing 274.9 GB, a CPU at 0.11 shown as 0%. And a
 * subscriber count that drifts leaves an ssh child running on this Mac and a
 * macmon running on theirs after the page has gone, which on a filming day
 * accumulates one per reload.
 *
 * None of it needs a Mac: the command and the parsing are functions of their
 * input, and the hub is driven through its start seam by a fake stream that
 * can be made to die on demand, which is the case that matters and cannot be
 * arranged on real hardware.
 */

import { describe, expect, test } from "bun:test";
import {
  MACMON_BIN,
  MACMON_INTERVAL_MS,
  StatsHub,
  macmonCommand,
  parseMacmonLine,
} from "../src/show/stats.ts";
import type { LaneStats, StatsEvent, StatsHandlers, StatsLaneRef } from "../src/show/stats.ts";

// ------------------------------------------------------------------ fixtures

/** A reading in the shape macmon 0.8.2 prints, trimmed to the fields read. */
function reading(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    gpu_usage: [1398, 0.9612],
    gpu_power: 63.125,
    cpu_usage_pct: 0.1142,
    ane_power: 0,
    memory: { ram_total: 274877906944, ram_usage: 62631477248, swap_total: 0, swap_usage: 0 },
    temp: { cpu_temp_avg: 48.91, gpu_temp_avg: 45.176 },
    all_power: 84.4,
    timestamp: "2026-09-21T14:48:27.398674+00:00",
    ...over,
  });
}

const LANES: StatsLaneRef[] = [
  { laneId: "lane-0", label: "M3 Ultra 512GB" },
  { laneId: "lane-1", label: "M5 Ultra 256GB" },
];

/** A stream this test drives by hand: it prints when told and dies when told. */
class FakeStreams {
  /** Every lane that has a stream right now, with the way to feed it. */
  live = new Map<string, StatsHandlers>();
  /** How many times each lane has been started, to prove a restart happened. */
  starts: string[] = [];
  /** How many times each lane has been stopped. */
  stops: string[] = [];

  start = (lane: StatsLaneRef, handlers: StatsHandlers): (() => void) => {
    this.starts.push(lane.laneId);
    this.live.set(lane.laneId, handlers);
    return () => {
      this.stops.push(lane.laneId);
      this.live.delete(lane.laneId);
    };
  };

  say(laneId: string, line: string): void {
    this.live.get(laneId)?.onLine(line);
  }

  die(laneId: string, reason: string): void {
    const handlers = this.live.get(laneId);
    this.live.delete(laneId);
    handlers?.onEnd(reason);
  }
}

// ------------------------------------------------------------------ command

describe("what each machine is asked to run", () => {
  test("macmon is named in full, because it is not on the PATH ssh gets", () => {
    expect(macmonCommand()).toBe(`"$HOME"'/.local/bin/macmon' pipe -i '500'`);
    expect(MACMON_BIN).toBe("~/.local/bin/macmon");
    expect(MACMON_INTERVAL_MS).toBe(500);
  });

  test("the interval is whatever it is asked for, as a whole number", () => {
    expect(macmonCommand(250)).toContain("-i '250'");
    expect(macmonCommand(250.7)).toContain("-i '250'");
    expect(macmonCommand(0)).toContain("-i '1'");
  });

  test("twice a second at the default, which is what the strip is asked to move at", () => {
    expect(MACMON_INTERVAL_MS).toBeLessThanOrEqual(500);
  });
});

// ------------------------------------------------------------------ parsing

describe("one reading, as the strip shows it", () => {
  const stats = parseMacmonLine(reading()) as LaneStats;

  test("the GPU's active ratio is a whole percent, from the second half of the pair", () => {
    // gpu_usage is [frequency, active ratio]; the frequency is not a percent.
    expect(stats.gpuPct).toBe(96);
  });

  test("cpu_usage_pct is a ratio in spite of its name, so 0.1142 is 11%", () => {
    expect(stats.cpuPct).toBe(11);
    expect(parseMacmonLine(reading({ cpu_usage_pct: 0.0015 }))?.cpuPct).toBe(0);
    expect(parseMacmonLine(reading({ cpu_usage_pct: 1 }))?.cpuPct).toBe(100);
  });

  test("watts to one decimal, the Neural Engine included", () => {
    expect(stats.gpuWatts).toBe(63.1);
    expect(stats.aneWatts).toBe(0);
    expect(parseMacmonLine(reading({ ane_power: 4.28 }))?.aneWatts).toBe(4.3);
  });

  test("a 256GB machine says 256.0 GB, not 274.9", () => {
    // The gigabyte on the box is 1024 three times over. Dividing the other way
    // puts a number on screen that contradicts the lane's own name.
    expect(stats.ramTotalGb).toBe(256);
    expect(stats.ramUsedGb).toBe(58.3);
    expect(parseMacmonLine(reading({ memory: { ram_total: 549755813888, ram_usage: 64948404224 } })))
      .toMatchObject({ ramTotalGb: 512, ramUsedGb: 60.5 });
  });

  test("the GPU temperature is whole degrees", () => {
    expect(stats.gpuTempC).toBe(45);
  });

  test("a line that is not a reading is skipped rather than shown as zeroes", () => {
    expect(parseMacmonLine("")).toBeNull();
    expect(parseMacmonLine("{")).toBeNull();
    expect(parseMacmonLine('{"gpu_usage":[1398,0.96]}')).toBeNull();
    expect(parseMacmonLine("[1,2,3]")).toBeNull();
    expect(parseMacmonLine("null")).toBeNull();
    expect(parseMacmonLine(reading({ memory: { ram_total: 274877906944 } }))).toBeNull();
    expect(parseMacmonLine(reading({ gpu_power: "hot" }))).toBeNull();
    expect(parseMacmonLine(reading({ temp: {} }))).toBeNull();
  });
});

// ------------------------------------------------------------------ the hub

describe("one reader per machine, and only while a page is open", () => {
  function collector(): { events: StatsEvent[]; send: (event: StatsEvent) => void } {
    const events: StatsEvent[] = [];
    return { events, send: (event) => void events.push(event) };
  }

  test("the first page starts every lane; the last one to leave stops them", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    expect(hub.running).toEqual([]);

    const first = collector();
    const leaveFirst = hub.subscribe(first.send);
    expect(fake.starts).toEqual(["lane-0", "lane-1"]);
    expect(hub.subscribers).toBe(1);

    // A second page is a second reader of the same two streams, not two more.
    const second = collector();
    const leaveSecond = hub.subscribe(second.send);
    expect(fake.starts).toEqual(["lane-0", "lane-1"]);
    expect(hub.subscribers).toBe(2);

    leaveFirst();
    expect(fake.stops).toEqual([]);
    expect(hub.running).toEqual(["lane-0", "lane-1"]);

    leaveSecond();
    expect(fake.stops.sort()).toEqual(["lane-0", "lane-1"]);
    expect(hub.running).toEqual([]);
    expect(hub.subscribers).toBe(0);
  });

  test("the next page after that starts them again", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    hub.subscribe(collector().send)();
    expect(fake.stops).toHaveLength(2);

    hub.subscribe(collector().send);
    expect(fake.starts).toEqual(["lane-0", "lane-1", "lane-0", "lane-1"]);
    expect(hub.running).toEqual(["lane-0", "lane-1"]);
  });

  test("leaving twice counts once, so a reload cannot stop a page that is still open", () => {
    // The server hears about a closed connection from both cancel() and the
    // request's abort. Two of those must not read as two pages leaving.
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    const leaveFirst = hub.subscribe(collector().send);
    hub.subscribe(collector().send);

    leaveFirst();
    leaveFirst();
    expect(hub.subscribers).toBe(1);
    expect(fake.stops).toEqual([]);
  });

  test("every reading goes to every page, and a page that opens late is not blank", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    const first = collector();
    hub.subscribe(first.send);
    fake.say("lane-0", reading());

    expect(first.events).toHaveLength(1);
    expect(first.events[0]).toEqual({ type: "stats", laneId: "lane-0", stats: parseMacmonLine(reading())! });

    // The page that arrives now gets what is already known, at once, rather
    // than dashes until the next reading half a second later.
    const late = collector();
    hub.subscribe(late.send);
    expect(late.events).toEqual([{ type: "stats", laneId: "lane-0", stats: parseMacmonLine(reading())! }]);

    fake.say("lane-1", reading({ gpu_usage: [0, 0] }));
    expect(first.events).toHaveLength(2);
    expect(late.events).toHaveLength(2);
  });

  test("a line the tool cannot read does not kill the stream", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    const seen = collector();
    hub.subscribe(seen.send);

    fake.say("lane-0", "macmon: warning: something");
    fake.say("lane-0", '{"gpu_usage":[13');
    expect(seen.events).toEqual([]);
    expect(hub.running).toContain("lane-0");

    fake.say("lane-0", reading());
    expect(seen.events).toHaveLength(1);
    expect(seen.events[0]?.type).toBe("stats");
  });

  test("a lane that dies says so, is logged once, and leaves the other alone", () => {
    const fake = new FakeStreams();
    const lines: string[] = [];
    const hub = new StatsHub(LANES, fake.start, (message) => lines.push(message));
    const seen = collector();
    hub.subscribe(seen.send);

    fake.die("lane-1", "it exited 255: ssh: connect to host: Operation timed out");

    expect(seen.events).toEqual([
      { type: "stats-gone", laneId: "lane-1", reason: "it exited 255: ssh: connect to host: Operation timed out" },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("M5 Ultra 256GB");
    expect(lines[0]).toContain("Operation timed out");

    // The other machine is untouched, and still reporting.
    expect(hub.running).toEqual(["lane-0"]);
    fake.say("lane-0", reading());
    expect(seen.events.at(-1)?.type).toBe("stats");
  });

  test("a dead lane comes back the next time a page connects", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    hub.subscribe(collector().send);
    fake.die("lane-0", "it exited 255");
    expect(hub.running).toEqual(["lane-1"]);

    hub.subscribe(collector().send);
    expect(hub.running.sort()).toEqual(["lane-0", "lane-1"]);
    expect(fake.starts).toEqual(["lane-0", "lane-1", "lane-0"]);
  });

  test("a lane whose last reading is stale is forgotten, so a new page sees dashes", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    hub.subscribe(collector().send);
    fake.say("lane-0", reading());
    fake.die("lane-0", "it exited 1");

    const late = collector();
    hub.subscribe(late.send);
    expect(late.events.filter((e) => e.type === "stats" && e.laneId === "lane-0")).toEqual([]);
  });

  test("stopping on the way down kills every stream and reports nothing", () => {
    const fake = new FakeStreams();
    const seen = collector();
    const hub = new StatsHub(LANES, fake.start);
    hub.subscribe(seen.send);

    hub.stop();
    expect(fake.stops.sort()).toEqual(["lane-0", "lane-1"]);
    expect(hub.running).toEqual([]);
    expect(seen.events.filter((e) => e.type === "stats-gone")).toEqual([]);
  });

  test("a page that cannot be written to is dropped rather than throwing into the next one", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub(LANES, fake.start);
    const good = collector();
    hub.subscribe(() => {
      throw new Error("this connection is closed");
    });
    hub.subscribe(good.send);

    fake.say("lane-0", reading());
    expect(hub.subscribers).toBe(1);
    expect(good.events).toHaveLength(1);
  });

  test("with no lanes at all there is nothing to start and nothing to leak", () => {
    const fake = new FakeStreams();
    const hub = new StatsHub([], fake.start);
    const leave = hub.subscribe(collector().send);
    expect(fake.starts).toEqual([]);
    leave();
    expect(hub.running).toEqual([]);
  });
});

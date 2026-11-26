import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
// @ts-expect-error plain browser module
import * as charts from "../public/charts.js";
import { validateConfig } from "../src/config.ts";
import { mergeLanes } from "../src/editor.ts";
import {
  MemoryWatch,
  memoryLineReader,
  memoryScript,
  memoryTargetFor,
  mergePeaks,
  parseMemoryBlock,
  peakOf,
  peakText,
  plainSshReason,
  startMemoryStream,
} from "../src/memory.ts";
import type { MemoryHandlers, MemoryPeak, MemoryReading } from "../src/memory.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { buildRunFile } from "../src/runfile.ts";
import { parseSweepRequest, runSweep, summarizeCell, sweepCsv } from "../src/sweep.ts";
import type { SweepEvent, SweepMemoryWatch } from "../src/sweep.ts";
import { parseSweepArgs } from "../src/sweepcli.ts";
import { sustainedStreams } from "../src/sustained.ts";
import type { SustainedInput } from "../src/sustained.ts";
import type { LaneConfig, LaneResult, RaceConfig } from "../src/types.ts";

const GB = 1024 ** 3;

// What a 4-card Linux box prints for one sample: /proc/meminfo's four lines, then one line per card.
const LINUX = [
  "MemTotal:       65806472 kB",
  "MemAvailable:   49029640 kB",
  "SwapTotal:       8388604 kB",
  "SwapFree:        7340028 kB",
  "GPU: 7421, 8192",
  "GPU: 7398, 8192",
  "GPU: 7398, 8192",
  "GPU: 7402, 8192",
];

// What a 256 GB Mac prints: hw.memsize, vm_stat as it is, vm.swapusage.
const DARWIN = [
  "MemSize: 274877906944",
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "Pages free:                             5012345.",
  "Pages active:                           4000000.",
  "Pages inactive:                         3000000.",
  "Pages speculative:                       100000.",
  "Pages throttled:                              0.",
  "Pages wired down:                       2000000.",
  "Pages purgeable:                          50000.",
  '"Translation faults":                 123456789.',
  "Pages stored in compressor:              900000.",
  "Pages occupied by compressor:            500000.",
  "Swap: total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)",
];

describe("reading a machine's memory", () => {
  test("Linux: host used is total minus available, and every card is counted", () => {
    const r = parseMemoryBlock("Linux", LINUX)!;
    expect(r.os).toBe("linux");
    expect(r.hostTotalBytes).toBe(65806472 * 1024);
    expect(r.hostUsedBytes).toBe((65806472 - 49029640) * 1024);
    expect(r.swapUsedBytes).toBe((8388604 - 7340028) * 1024);
    expect(r.gpus.length).toBe(4);
    expect(r.gpus[0]).toEqual({ usedBytes: 7421 * 1024 * 1024, totalBytes: 8192 * 1024 * 1024 });
  });

  test("Linux without nvidia-smi has no GPU reading, not a zero", () => {
    const r = parseMemoryBlock("Linux", LINUX.slice(0, 4))!;
    expect(r.gpus).toEqual([]);
    expect(peakOf([r])!.gpuPeakGb).toBeNull();
  });

  test("macOS: used is active + wired + compressor pages at the page size vm_stat names", () => {
    const r = parseMemoryBlock("Darwin", DARWIN)!;
    expect(r.os).toBe("darwin");
    expect(r.hostTotalBytes).toBe(274877906944);
    expect(r.hostUsedBytes).toBe((4000000 + 2000000 + 500000) * 16384);
    expect(r.swapUsedBytes).toBe(512 * 1024 * 1024);
    expect(r.gpus).toEqual([]);
  });

  test("a block that is not a reading is null, never a guess", () => {
    expect(parseMemoryBlock("Linux", ["MemTotal:  100 kB"])).toBeNull();
    expect(parseMemoryBlock("Linux", ["MemTotal: 100 kB", "MemAvailable: 500 kB"])).toBeNull();
    expect(parseMemoryBlock("Darwin", DARWIN.filter((l) => !l.startsWith("Pages wired")))).toBeNull();
    expect(parseMemoryBlock("FreeBSD", LINUX)).toBeNull();
    expect(parseMemoryBlock("Linux", [])).toBeNull();
  });

  test("the line reader hands over one reading per complete block and skips a half-written one", () => {
    const got: MemoryReading[] = [];
    const odd: string[] = [];
    const read = memoryLineReader((r) => got.push(r), (os) => odd.push(os));
    for (const line of ["noise before", "LSB-MEM-BEGIN Linux", ...LINUX, "LSB-MEM-END"]) read(line);
    for (const line of ["LSB-MEM-BEGIN Linux", "MemTotal:  100 kB", "LSB-MEM-BEGIN Darwin", ...DARWIN, "LSB-MEM-END"]) read(line);
    for (const line of ["LSB-MEM-BEGIN SunOS", "LSB-MEM-END"]) read(line);
    expect(got.map((r) => r.os)).toEqual(["linux", "darwin"]);
    expect(odd).toEqual(["SunOS"]);
  });

  test("the script only reads, and ends itself", () => {
    const script = memoryScript(1, 60);
    expect(script).toContain("/proc/meminfo");
    expect(script).toContain("vm_stat");
    expect(script).toContain("+ 60 ))");
    for (const word of ["rm ", "sudo", "curl", "wget", "install", " > /", ">>"]) expect(script).not.toContain(word);
  });
});

describe("peaks", () => {
  const reading = (hostUsedGb: number, gpuUsedGb: number[] = [], swapGb: number | null = 0): MemoryReading => ({
    os: "linux",
    hostTotalBytes: 64 * GB,
    hostUsedBytes: hostUsedGb * GB,
    swapUsedBytes: swapGb === null ? null : swapGb * GB,
    gpus: gpuUsedGb.map((g) => ({ usedBytes: g * GB, totalBytes: 8 * GB })),
  });

  test("a peak is the highest of each number, and GPU is every card together", () => {
    const p = peakOf([reading(10, [1, 1]), reading(30, [7, 7.5], 2), reading(20, [6, 6])])!;
    expect(p).toEqual({ samples: 3, hostPeakGb: 30, hostTotalGb: 64, gpuPeakGb: 14.5, gpuTotalGb: 16, gpus: 2, swapPeakGb: 2 });
    expect(peakOf([])).toBeNull();
  });

  test("merging keeps the highest and adds the samples up", () => {
    const a = peakOf([reading(10, [1])])!;
    const b = peakOf([reading(25, [5]), reading(12, [6])])!;
    const merged = mergePeaks([a, null, undefined, b])!;
    expect(merged.hostPeakGb).toBe(25);
    expect(merged.gpuPeakGb).toBe(6);
    expect(merged.samples).toBe(3);
    expect(mergePeaks([null, undefined])).toBeNull();
  });

  test("the words give used, total and percent, and leave out a GPU that is not there", () => {
    expect(peakText(peakOf([reading(16, [4, 4])])!)).toBe("host 16.0 of 64.0 GB (25%), GPU 8.0 of 16.0 GB (50%) over 2 cards");
    expect(peakText(peakOf([reading(16)])!)).toBe("host 16.0 of 64.0 GB (25%)");
    expect(peakText(peakOf([reading(16, [], 1.5)])!)).toContain("swap 1.5 GB");
  });
});

describe("MemoryWatch", () => {
  function fake() {
    const handlers = new Map<string, MemoryHandlers>();
    const stopped: string[] = [];
    let clock = 0;
    const watch = new MemoryWatch(
      [{ laneId: "lane-0", label: "Studio" }, { laneId: "lane-1", label: "Box" }],
      (lane, h) => {
        handlers.set(lane.laneId, h);
        return () => stopped.push(lane.laneId);
      },
      () => clock,
    );
    const send = (laneId: string, lines: string[], os = "Linux") => {
      for (const line of [`LSB-MEM-BEGIN ${os}`, ...lines, "LSB-MEM-END"]) handlers.get(laneId)!.onLine(line);
    };
    return { watch, handlers, stopped, send, tick: (to: number) => (clock = to) };
  }
  const linuxUsing = (usedKb: number) => ["MemTotal: 1048576 kB", `MemAvailable: ${1048576 - usedKb} kB`];

  test("peaks cover only the samples that arrived since the mark", () => {
    const f = fake();
    f.tick(1);
    f.send("lane-0", linuxUsing(900000)); // before the race: must not count
    f.tick(5);
    const mark = f.watch.mark();
    f.tick(6);
    f.send("lane-0", linuxUsing(262144));
    f.tick(7);
    f.send("lane-0", linuxUsing(524288));
    const peaks = f.watch.peaksSince(mark);
    expect(peaks["lane-0"]!.hostPeakGb).toBe(0.5);
    expect(peaks["lane-0"]!.samples).toBe(2);
    expect(peaks["lane-1"]).toBeNull(); // a machine that sent nothing has no reading, not a zero
  });

  test("ready() reports who answered and who did not, without waiting for a machine that has given up", async () => {
    const f = fake();
    f.send("lane-0", linuxUsing(262144));
    f.handlers.get("lane-1")!.onEnd("ssh could not sign in to it (this machine's key is not accepted there)");
    const status = await f.watch.ready(5000);
    expect(status[0]!.ok).toBe(true);
    expect(status[0]!.message).toContain("Memory sampling is on for Studio");
    expect(status[1]!.ok).toBe(false);
    expect(status[1]!.message).toContain("No memory reading from Box: ssh could not sign in");
    expect(status[1]!.message).toContain("the sweep is not affected");
  });

  test("ready() gives up after its time, and names an operating system it cannot read", async () => {
    const f = fake();
    f.send("lane-1", [], "FreeBSD");
    const status = await f.watch.ready(30);
    expect(status[0]!.message).toContain("has not answered yet");
    expect(status[1]!.message).toContain("FreeBSD");
  });

  test("stop() stops every loop once", () => {
    const f = fake();
    f.watch.stop();
    f.watch.stop();
    expect(f.stopped.sort()).toEqual(["lane-0", "lane-1"]);
  });

  test("a machine whose loop cannot even start is a status line, not a crash", async () => {
    const watch = new MemoryWatch([{ laneId: "lane-0", label: "Studio" }], () => {
      throw new Error("its ssh settings contain characters that are not allowed");
    });
    const [status] = await watch.ready(50);
    expect(status!.ok).toBe(false);
    expect(status!.message).toContain("not allowed");
  });
});

describe("where a machine's sampler runs", () => {
  test("a machine at this computer's own address runs it here; any other goes over ssh to the host in its address", () => {
    expect(memoryTargetFor({ baseUrl: "http://localhost:9001" })).toEqual({ kind: "local" });
    expect(memoryTargetFor({ baseUrl: "http://127.0.0.1:9001" })).toEqual({ kind: "local" });
    expect(memoryTargetFor({ baseUrl: "http://192.168.1.50:8000" })).toEqual({ kind: "ssh", target: { host: "192.168.1.50", binDir: "~", port: 0 } });
  });

  test("the ssh block names a different host, user or port", () => {
    const t = memoryTargetFor({ baseUrl: "http://192.168.1.50:8000", ssh: { host: "studio.local", user: "bench", sshPort: 2222 } });
    expect(t).toEqual({ kind: "ssh", target: { host: "studio.local", user: "bench", sshPort: 2222, binDir: "~", port: 0 } });
  });

  test("the config keeps a lane's ssh block, and so does saving machines from the page", () => {
    const config = validateConfig({
      lanes: [{ label: "Studio", baseUrl: "http://192.168.1.50:8000", model: "m", ssh: { user: "bench", sshPort: 2222, nonsense: true } }],
    });
    expect(config.lanes[0]!.ssh).toEqual({ user: "bench", sshPort: 2222 });
    const merged = mergeLanes(config.lanes, [{ label: "Studio", baseUrl: "http://192.168.1.50:8000" }], ["m"]);
    expect(merged[0]!.ssh).toEqual({ user: "bench", sshPort: 2222 });
  });

  test("an ssh failure is put in words that carry no address", () => {
    const cases: [string, string][] = [
      ["bench@192.168.1.50: Permission denied (publickey,password).", "could not sign in"],
      ["ssh: connect to host 192.168.1.50 port 22: Operation timed out", "timed out"],
      ["ssh: Could not resolve hostname studio.local: nodename nor servname provided", "did not resolve"],
      ["ssh: connect to host 192.168.1.50 port 22: Connection refused", "refused the ssh connection"],
      ["Host key verification failed.", "host key"],
    ];
    for (const [stderr, expected] of cases) {
      const reason = plainSshReason(255, stderr);
      expect(reason).toContain(expected);
      expect(reason).not.toContain("192.168");
      expect(reason).not.toContain("studio.local");
    }
    expect(plainSshReason(3, "something new at 10.0.0.9")).toBe("the sampler stopped (exit 3)");
  });

  test("the real loop, run on this machine, sends a reading and stops when asked", async () => {
    if (process.platform !== "linux" && process.platform !== "darwin") return;
    const readings: MemoryReading[] = [];
    let endedWith: string | null = null;
    const read = memoryLineReader((r) => readings.push(r));
    const stop = startMemoryStream({ kind: "local" }, { onLine: read, onEnd: (reason) => (endedWith = reason) });
    const deadline = Date.now() + 8000;
    while (readings.length === 0 && endedWith === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(endedWith).toBeNull();
    expect(readings.length).toBeGreaterThan(0);
    expect(readings[0]!.hostTotalBytes).toBeGreaterThan(0);
    expect(readings[0]!.hostUsedBytes).toBeLessThanOrEqual(readings[0]!.hostTotalBytes);
  });
});

// ------------------------------------------------------------------ sustained streams

const level = (over: Partial<SustainedInput>): SustainedInput => ({
  preset: "4k", concurrency: 1, laneId: "lane-0", label: "Studio", repeats: 3, finished: 3, failedStreams: 0, slots: null, ...over,
});
const climb = (counts: number[], bad: Record<number, Partial<SustainedInput>> = {}, base: Partial<SustainedInput> = {}) =>
  counts.map((c) => level({ ...base, concurrency: c, ...(bad[c] ?? {}) }));

describe("sustained streams", () => {
  test("every level clean: the top of the sweep, said as 'at least'", () => {
    const [s] = sustainedStreams(climb([1, 2, 4, 8]));
    expect(s).toMatchObject({ sustained: 8, top: 8, stoppedAt: null, stop: null });
    expect(s!.sentence).toBe("Studio sustained 8 streams at 4k, the most this sweep asked for, so its limit is at least that.");
  });

  test("a failed stream stops the climb at the level before it", () => {
    const [s] = sustainedStreams(climb([1, 2, 4, 8, 16], { 8: { failedStreams: 2 } }));
    expect(s).toMatchObject({ sustained: 4, top: 16, stoppedAt: 8, stop: "failed-streams" });
    expect(s!.sentence).toBe("Studio sustained 4 streams at 4k: at 8, 2 of 24 streams failed.");
  });

  test("a run that did not finish stops it too, and a clean level above the failure does not count", () => {
    const [s] = sustainedStreams(climb([1, 2, 4, 8], { 4: { finished: 2 } }));
    expect(s).toMatchObject({ sustained: 2, stoppedAt: 4, stop: "failed-runs" });
    expect(s!.sentence).toContain("at 4, 1 of 3 runs did not finish");
  });

  test("streams past what the machine runs at once are a queue, not sustained", () => {
    const [s] = sustainedStreams(climb([1, 2, 4, 8], {}, { slots: 4 }));
    expect(s).toMatchObject({ sustained: 4, stoppedAt: 8, stop: "queue" });
    expect(s!.sentence).toBe("Studio sustained 4 streams at 4k: it runs 4 at a time, so at 8 the rest waited in its queue.");
  });

  test("not even the lowest level clean is 'none', not zero", () => {
    const [s] = sustainedStreams(climb([2, 4], { 2: { finished: 0 } }));
    expect(s!.sustained).toBeNull();
    expect(s!.sentence).toContain("did not sustain 2 streams at 4k, the fewest this sweep asked for");
  });

  test("the memory at the failing level is stated beside it", () => {
    const memory: MemoryPeak = { samples: 9, hostPeakGb: 30.4, hostTotalGb: 32, gpuPeakGb: null, gpuTotalGb: null, gpus: 0, swapPeakGb: 0 };
    const [s] = sustainedStreams(climb([1, 2, 4], { 4: { failedStreams: 1, memory } }));
    expect(s!.sentence).toBe("Studio sustained 2 streams at 4k: at 4, 1 of 12 streams failed. Memory at 4: host 30.4 of 32.0 GB (95%).");
  });

  test("one row per machine and prompt size; a single stream count is not a climb", () => {
    const rows = [
      ...climb([1, 2]),
      ...climb([1, 2], {}, { laneId: "lane-1", label: "Box" }),
      ...climb([1, 2], { 2: { failedStreams: 1 } }, { preset: "16k" }),
      ...climb([4], {}, { preset: "32k" }),
    ];
    const out = sustainedStreams(rows);
    expect(out.map((s) => `${s.label} ${s.preset} ${s.sustained}`)).toEqual(["Studio 4k 2", "Box 4k 2", "Studio 16k 1"]);
  });

  test("the order the rows arrive in does not matter", () => {
    const [s] = sustainedStreams(climb([8, 1, 4, 2], { 8: { failedStreams: 3 } }));
    expect(s!.sustained).toBe(4);
  });
});

// ------------------------------------------------------------------ in a sweep

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
function mock(over: Partial<MockLaneOptions> = {}): Server {
  const server = startMockLane({ port: 0, firstWordDelayMs: 10, chunkIntervalMs: 2, chunks: 10, includeUsage: true, ...over });
  servers.push(server);
  return server;
}
const laneFor = (s: Server, label: string): LaneConfig => ({ label, baseUrl: `http://localhost:${s.port}`, model: "mock-model", displayModel: "mock-model" });
const raceConfig = (lanes: LaneConfig[]): RaceConfig => ({
  port: 0, maxTokens: 512, temperature: 0, charsPerToken: 4, promptFile: "prompts/sample.txt", requestTimeoutMs: 5000, preflightTimeoutMs: 2000, lanes,
});

function result(over: Partial<LaneResult> = {}): LaneResult {
  return {
    laneId: "lane-0", label: "Studio", model: "m", displayModel: "m", baseUrl: "http://x",
    firstResponseSec: 1, firstWordSec: 2, firstWordField: "content", lastWordSec: 12, chunks: 100, tokens: 101,
    tokenSource: "usage", promptTokens: 4000, cachedTokens: 0, systemFingerprint: null, totalSec: 12.1,
    error: null, blocked: null, usageSupported: true, ...over,
  };
}
const peak = (hostPeakGb: number, gpuPeakGb: number | null = null): MemoryPeak => ({
  samples: 5, hostPeakGb, hostTotalGb: 64, gpuPeakGb, gpuTotalGb: gpuPeakGb === null ? null : 32, gpus: gpuPeakGb === null ? 0 : 4, swapPeakGb: 0,
});

describe("memory and failed streams in a sweep's rows", () => {
  test("a cell's row carries the highest peak over its runs, failed streams added up, and the machine's slots", () => {
    const runs = [
      [result({ concurrency: 4, failedStreams: 1, slots: 4 })],
      [result({ concurrency: 4, failedStreams: 2, slots: 4 })],
      [result({ error: "all 4 streams failed: HTTP 500", totalSec: null, concurrency: 4, failedStreams: 4 })],
    ];
    const [row] = summarizeCell("4k", 4, runs, [{ "lane-0": peak(20, 28) }, { "lane-0": peak(31, 30) }, { "lane-0": null }]);
    expect(row!.finished).toBe(2);
    expect(row!.failedStreams).toBe(3); // the run that failed outright is counted in `finished`, not here
    expect(row!.slots).toBe(4);
    expect(row!.memory).toMatchObject({ hostPeakGb: 31, gpuPeakGb: 30, samples: 10 });
  });

  test("without sampling a row has no memory at all, and the CSV leaves those columns blank", () => {
    const [row] = summarizeCell("4k", 1, [[result()]]);
    expect("memory" in row!).toBe(false);
    expect(row!.failedStreams).toBe(0);
    const [head, line] = sweepCsv([row!]).trimEnd().split("\n");
    const at = (name: string) => line!.split(",")[head!.split(",").indexOf(name)];
    expect(at("failed_streams")).toBe("0");
    expect(at("host_mem_peak_gb")).toBe("");
    expect(at("gpu_mem_peak_gb")).toBe("");
  });

  test("with sampling the CSV carries the peaks under their own names", () => {
    const [row] = summarizeCell("4k", 1, [[result()]], [{ "lane-0": peak(41.25, 30.5) }]);
    const [head, line] = sweepCsv([row!]).trimEnd().split("\n");
    const at = (name: string) => line!.split(",")[head!.split(",").indexOf(name)];
    expect(at("host_mem_peak_gb")).toBe("41.25");
    expect(at("host_mem_total_gb")).toBe("64");
    expect(at("gpu_mem_peak_gb")).toBe("30.5");
    expect(at("gpu_mem_total_gb")).toBe("32");
    expect(at("memory_samples")).toBe("5");
  });

  test("the request and the command line both take a memory switch, off unless asked", () => {
    const limits = { laneIds: ["lane-0"], maxConcurrency: 16 };
    const base = { presets: ["short"], concurrencies: [1] };
    const off = parseSweepRequest(base, limits);
    expect(off.ok && off.request.memory).toBeUndefined();
    const on = parseSweepRequest({ ...base, memory: true }, limits);
    expect(on.ok && on.request.memory).toBe(true);
    expect(parseSweepRequest({ ...base, memory: "yes" }, limits).ok).toBe(false);

    const args = parseSweepArgs(["--streams", "1,2", "--memory"]);
    expect(args.ok && args.args.memory).toBe(true);
    const plain = parseSweepArgs([]);
    expect(plain.ok && plain.args.memory).toBe(false);
  });
});

describe("runSweep with a memory watch", () => {
  test("says once who is being sampled, marks every race, and ends with sustained streams", async () => {
    const good = mock();
    const marks: number[] = [];
    let n = 0;
    const watch: SweepMemoryWatch = {
      ready: async () => [{ laneId: "lane-0", label: "Studio", ok: true, message: "Memory sampling is on for Studio." }],
      mark: () => {
        marks.push(++n);
        return n;
      },
      // Each race's peak is its mark, so the row's memory shows which races it came from.
      peaksSince: (mark) => ({ "lane-0": peak(mark) }),
    };
    const events: SweepEvent[] = [];
    const done = await runSweep({
      config: raceConfig([laneFor(good, "Studio")]),
      sourceText: "",
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0"], presets: ["short"], concurrencies: [1, 2, 4], repeats: 2, warmup: true, memory: true },
      memory: watch,
      emit: (e) => {
        if (e.type.startsWith("sweep-")) events.push(e as SweepEvent);
      },
    });

    expect(events[0]).toMatchObject({ type: "sweep-memory", ok: true, laneId: "lane-0" });
    expect(events[1]!.type).toBe("sweep-warmup");
    expect(marks.length).toBe(6); // the warm-up race is not measured, so it is not marked
    expect(done.rows.map((r) => r.memory!.hostPeakGb)).toEqual([2, 4, 6]);
    expect(done.rows.every((r) => r.memory!.samples === 10)).toBe(true);
    expect(done.sustained.length).toBe(1);
    expect(done.sustained[0]).toMatchObject({ label: "Studio", sustained: 4, top: 4, stoppedAt: null });
  });

  test("a machine that fails at every level sustains none, and the sweep still finishes", async () => {
    const broken = mock({ failWithStatus: 500 });
    const done = await runSweep({
      config: raceConfig([laneFor(broken, "Box")]),
      sourceText: "",
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0"], presets: ["short"], concurrencies: [1, 2], repeats: 1, warmup: false },
      emit: () => {},
    });
    expect(done.complete).toBe(true);
    expect(done.sustained[0]).toMatchObject({ sustained: null, stoppedAt: 1, stop: "failed-runs" });
  });

  test("without a watch nothing about memory is said or saved", async () => {
    const good = mock();
    const types: string[] = [];
    const done = await runSweep({
      config: raceConfig([laneFor(good, "Studio")]),
      sourceText: "",
      logPath: null,
      skipUsageProbe: true,
      tickMs: 20,
      pauseMs: 0,
      request: { laneIds: ["lane-0"], presets: ["short"], concurrencies: [1], repeats: 1, warmup: false },
      emit: (e) => types.push(e.type),
    });
    expect(types).not.toContain("sweep-memory");
    expect(done.rows.every((r) => !("memory" in r))).toBe(true);
    expect(done.sustained).toEqual([]); // one stream count is not a climb
  });
});

describe("the run file and the results page", () => {
  const rows = [
    ...summarizeCell("4k", 1, [[result()]], [{ "lane-0": peak(20, 28) }]),
    ...summarizeCell("4k", 2, [[result({ concurrency: 2, failedStreams: 1 })]], [{ "lane-0": peak(31, 30) }]),
  ];
  const file = buildRunFile({
    kind: "sweep", rows, lanes: [{ laneId: "lane-0", label: "Studio", model: "/Users/someone/models/m" }], setups: {}, maxTokens: 512,
  });

  test("the file carries sustained streams worked out from its own rows, and still no address", () => {
    expect(file.sustained).toEqual([expect.objectContaining({ label: "Studio", preset: "4k", sustained: 1, stoppedAt: 2 })]);
    const text = JSON.stringify(file);
    expect(text).not.toContain("http://");
    expect(text).not.toContain("/Users/");
  });

  test("a sweep of one stream count has no sustained entry in its file", () => {
    const one = buildRunFile({ kind: "race", rows: rows.slice(0, 1), lanes: [{ laneId: "lane-0", label: "Studio", model: "m" }], setups: {}, maxTokens: 512 });
    expect("sustained" in one).toBe(false);
  });

  test("the results page reads memory into charts, a table line and the CSV", () => {
    const read = charts.readRunFile(JSON.parse(JSON.stringify(file)));
    expect(read.ok).toBe(true);
    const row = read.file.rows[1];
    expect(row.failedStreams).toBe(1);
    expect(row.hostMemory).toEqual({ median: 31, min: 31, max: 31 });
    expect(row.gpuMemory).toEqual({ median: 30, min: 30, max: 30 });
    expect(charts.memoryText(row.memory)).toBe("host 31.0 of 64.0 GB (48%), GPU 30.0 of 32.0 GB (94%) over 4 cards");
    expect(read.file.sustained[0]).toMatchObject({ label: "Studio", sustained: 1, stoppedAt: 2 });
    expect(charts.METRICS.map((m: { key: string }) => m.key)).toEqual(expect.arrayContaining(["hostMemory", "gpuMemory"]));

    const csv: string = charts.rowsToCsv(charts.buildSeries([{ name: "me", file: read.file }]));
    const [head, , second] = csv.trimEnd().split("\n");
    const at = (name: string) => second!.split(",")[head!.split(",").indexOf(name)];
    expect(at("failed_streams")).toBe("1");
    expect(at("host_mem_peak_gb")).toBe("31");
    expect(at("gpu_mem_total_gb")).toBe("32");
  });

  test("an older file, and a file with nonsense in those fields, reads as no memory and no sustained streams", () => {
    const old = JSON.parse(JSON.stringify(file));
    delete old.sustained;
    for (const r of old.rows) {
      delete r.memory;
      delete r.failedStreams;
    }
    const a = charts.readRunFile(old);
    expect(a.file.sustained).toEqual([]);
    expect(a.file.rows[0].memory).toBeNull();
    expect(a.file.rows[0].hostMemory).toBeNull();

    const bad = JSON.parse(JSON.stringify(file));
    bad.rows[0].memory = { hostPeakGb: "lots", hostTotalGb: -1 };
    bad.sustained = [{ label: "<img src=x>", preset: "4k", top: 2, sustained: "many", sentence: "x".repeat(900) }, 7, null];
    const b = charts.readRunFile(bad);
    expect(b.file.rows[0].memory).toBeNull();
    expect(b.file.sustained.length).toBe(1);
    expect(b.file.sustained[0].sustained).toBeNull();
    expect(b.file.sustained[0].sentence.length).toBe(400);
  });
});

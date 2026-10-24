import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_NAME, listRuns, readRunText, runFileName, saveRun } from "../src/runstore.ts";
import { buildRunFile } from "../src/runfile.ts";
import { PROBE_PATHS, probeReport, redact } from "../src/probe.ts";
import { laneIdsFor, parseSweepArgs } from "../src/sweepcli.ts";
import { validateConfig } from "../src/config.ts";
import { parseEditedLanes } from "../src/editor.ts";
// @ts-expect-error plain browser module
import * as c from "../public/charts.js";

const sp = (n: number) => ({ median: n, min: n - 1, max: n + 1 });
const row = { preset: "short", concurrency: 1, laneId: "lane-0", label: "A", repeats: 1, finished: 1, speedUnit: "tokens/sec", firstWordSec: sp(2), speed: sp(60), throughput: null, promptSpeed: null, totalSec: sp(5), promptTokens: 10 };
const file = (extra: object = {}) => buildRunFile({ kind: "sweep", rows: [row as never], lanes: [{ laneId: "lane-0", label: "A", model: "m", watts: 300 }], setups: {}, maxTokens: 512, now: new Date("2026-10-24T04:05:24.350Z"), tool: { version: "1.1.0", commit: "a".repeat(40) }, ...extra });

describe("saved runs", () => {
  test("names: only the exact shape is ever opened", async () => {
    expect(runFileName(file())).toBe("run-sweep-2026-10-24T04-05-24-350Z.json");
    expect(RUN_NAME.test(runFileName(file()))).toBe(true);
    for (const bad of ["../race.config.json", "run-sweep-x.json", "run-sweep-2026-10-24T04-05-24-350Z.json/../x", "results/run-race-2026-10-24T04-05-24-350Z.json", "run-evil-2026-10-24T04-05-24-350Z.json"]) {
      expect(RUN_NAME.test(bad)).toBe(false);
      expect(await readRunText(bad)).toBeNull();
    }
  });
  test("save, list and read back; an empty run is not kept; strangers in the folder are skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runs-"));
    try {
      const name = await saveRun(file(), dir);
      expect(name).toBe("run-sweep-2026-10-24T04-05-24-350Z.json");
      expect(await saveRun(file({ rows: [{ ...row, finished: 0 } as never] }), dir)).toBeNull();
      await writeFile(join(dir, "run-race-2026-10-24T04-05-25-000Z.json"), "not json");
      await writeFile(join(dir, "notes.txt"), "x");
      const runs = await listRuns(dir);
      expect(runs.map((r) => r.name)).toEqual([name!]);
      expect(JSON.parse((await readRunText(name!, dir))!).tool.version).toBe("1.1.0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run files carry the tool version and the entered watts", () => {
  test("and the results page reads them back safely", () => {
    const f = file();
    expect(f.machines[0]!.watts).toBe(300);
    const read = c.readRunFile(JSON.parse(JSON.stringify(f)));
    expect(read.file.tool).toEqual({ version: "1.1.0", commit: "a".repeat(40) });
    expect(read.file.machines[0].watts).toBe(300);
    const evil = JSON.parse(JSON.stringify(f));
    evil.tool = { version: "<script>", commit: "not-hex!" };
    evil.machines[0].watts = 99999;
    const r2 = c.readRunFile(evil);
    expect(r2.file.tool.commit).toBeNull();
    expect(r2.file.machines[0].watts).toBeNull();
  });
  test("speed per watt is speed divided by the watts, and absent without watts", () => {
    const withW = c.buildSeries([{ name: "n", file: c.readRunFile(JSON.parse(JSON.stringify(file()))).file }]);
    expect(withW[0].rows[0].efficiency.median).toBeCloseTo(0.2, 5);
    const noW = c.buildSeries([{ name: "n", file: c.readRunFile(JSON.parse(JSON.stringify(file({ lanes: [{ laneId: "lane-0", label: "A", model: "m" }] })))).file }]);
    expect(noW[0].rows[0].efficiency).toBeUndefined();
    expect(c.rowsToCsv(withW)).toContain("speed_per_watt_median");
  });
});

describe("watts in config and editor", () => {
  const base = { port: 1, maxTokens: 512, temperature: 0, charsPerToken: 4, promptFile: "x", requestTimeoutMs: 1000 };
  test("validated", () => {
    expect(validateConfig({ ...base, lanes: [{ label: "A", baseUrl: "http://a:1", model: "m", watts: 350 }] } as never).lanes[0]!.watts).toBe(350);
    for (const w of [0, -5, 6000, "x"]) expect(() => validateConfig({ ...base, lanes: [{ label: "A", baseUrl: "http://a:1", model: "m", watts: w }] } as never)).toThrow();
    expect(parseEditedLanes({ lanes: [{ label: "A", baseUrl: "http://a:1", watts: "250" }] })).toMatchObject({ ok: true });
    expect(parseEditedLanes({ lanes: [{ label: "A", baseUrl: "http://a:1", watts: "abc" }] }).ok).toBe(false);
  });
});

describe("probe", () => {
  test("masks addresses, hosts and home folders", () => {
    const out = redact("at 192.168.10.230 and mini.local in /Users/jody/models and /home/bob/x C:\\Users\\Al\\m");
    expect(out).not.toMatch(/192\.168|mini\.local|jody|bob|Al\\/);
  });
  test("asks every address, only with GET, and names the engine", async () => {
    const seen: { path: string; method?: string }[] = [];
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const path = new URL(u).pathname;
      seen.push({ path, method: init?.method });
      if (path === "/v1/models") return new Response(JSON.stringify({ data: [{ id: "m" }] }), { headers: { "content-type": "application/json" } });
      if (path === "/api/version") return new Response(JSON.stringify({ version: "0.12.3" }));
      return new Response("no", { status: 404 });
    }) as never;
    const text = await probeReport("http://10.1.2.3:8000", { fetchImpl });
    expect(text).toContain("engine:            Ollama");
    expect(text).not.toContain("10.1.2.3");
    for (const p of PROBE_PATHS) expect(seen.some((s) => s.path === p)).toBe(true);
    expect(seen.every((s) => s.method === undefined || s.method === "GET")).toBe(true);
  });
});

describe("headless sweep arguments", () => {
  test("defaults and a full command line", () => {
    expect(parseSweepArgs([])).toMatchObject({ ok: true, args: { presets: ["short", "4k"], concurrencies: [1], repeats: 1, warmup: true } });
    const r = parseSweepArgs(["--sizes", "short,16k", "--streams", "1,4", "--repeats", "3", "--machines", "A,B", "--no-warmup", "--thinking", "low", "--max-tokens", "1024"]);
    expect(r).toMatchObject({ ok: true, args: { presets: ["short", "16k"], concurrencies: [1, 4], repeats: 3, machines: ["A", "B"], warmup: false, thinking: "low", maxTokens: 1024 } });
  });
  test("bad input is refused with a reason", () => {
    expect(parseSweepArgs(["--sizes", "huge"]).ok).toBe(false);
    expect(parseSweepArgs(["--bogus"]).ok).toBe(false);
    expect(parseSweepArgs(["--thinking", "max"]).ok).toBe(false);
    expect(parseSweepArgs(["--max-tokens", "5"]).ok).toBe(false);
  });
  test("machines are found by name, ignoring case", () => {
    const cfg = { lanes: [{ label: "Mac Studio" }, { label: "Box" }] } as never;
    expect(laneIdsFor(cfg, ["box"])).toEqual({ ok: true, ids: ["lane-1"] });
    expect(laneIdsFor(cfg, null)).toEqual({ ok: true, ids: ["lane-0", "lane-1"] });
    expect(laneIdsFor(cfg, ["nope"]).ok).toBe(false);
  });
});

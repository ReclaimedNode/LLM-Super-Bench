import { describe, expect, test } from "bun:test";
import { buildRunFile, hasFinishedRun, RUN_FORMAT } from "../src/runfile.ts";
import type { SweepRow } from "../src/sweep.ts";

const sp = (n: number) => ({ median: n, min: n - 1, max: n + 1 });
const row = (laneId: string, finished = 1): SweepRow => ({
  preset: "short" as never, concurrency: 1, laneId, label: `Lane ${laneId}`, repeats: 1, finished,
  speedUnit: "tokens/sec", firstWordSec: sp(2), speed: sp(50), throughput: null, promptSpeed: null, totalSec: sp(5), promptTokens: 100,
});

describe("run file", () => {
  test("carries no address and only the machines that have rows", () => {
    const file = buildRunFile({
      kind: "race",
      rows: [row("a")],
      lanes: [
        { laneId: "a", label: "Lane A", model: "/models/secret/Qwen.gguf", baseUrl: "http://192.168.10.220:8000" } as never,
        { laneId: "b", label: "Lane B", model: "x" },
      ],
      setups: {},
      maxTokens: 512,
      thinking: "low",
    });
    expect(file.format).toBe(RUN_FORMAT);
    expect(file.machines.map((m) => m.id)).toEqual(["a"]);
    expect(file.settings).toEqual({ maxTokens: 512, thinking: "low" });
    const text = JSON.stringify(file);
    expect(text).not.toContain("192.168");
    expect(text).not.toContain("/models/secret");
    expect(hasFinishedRun(file)).toBe(true);
    expect(hasFinishedRun({ ...file, rows: [row("a", 0)] })).toBe(false);
  });
});

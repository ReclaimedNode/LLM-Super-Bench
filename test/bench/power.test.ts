import { describe, expect, test } from "bun:test";
import { validateBenchConfig } from "../../src/bench/config.ts";
import { planPowerJobs } from "../../src/bench/power.ts";

function config(over: Record<string, unknown> = {}) {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [
      { name: "Small", id: "small" },
      { name: "Big", id: "big" },
    ],
    lanes: [
      { label: "Lane A", baseUrl: "http://localhost:9001" },
      { label: "Lane B", baseUrl: "http://localhost:9002" },
    ],
    ...over,
  });
}

describe("planning the power pass", () => {
  test("one idle reading per lane, then one under load per model", () => {
    const jobs = planPowerJobs(config());
    expect(jobs.map((j) => `${j.lane.label}/${j.kind}/${j.model?.id ?? "-"}`)).toEqual([
      "Lane A/idle/-",
      "Lane A/load/small",
      "Lane A/load/big",
      "Lane B/idle/-",
      "Lane B/load/small",
      "Lane B/load/big",
    ]);
  });

  test("the idle reading comes before anything is started on that machine", () => {
    const jobs = planPowerJobs(config());
    const firstA = jobs.findIndex((j) => j.lane.label === "Lane A");
    expect(jobs[firstA]!.kind).toBe("idle");
  });

  test("lanes are never interleaved: one meter, one machine at a time", () => {
    // A person holding a wall meter can only be at one machine, so every job
    // for a lane has to be finished before the next lane starts.
    const order = planPowerJobs(config()).map((j) => j.lane.label);
    const firstSeen = new Map<string, number>();
    order.forEach((label, i) => {
      if (!firstSeen.has(label)) firstSeen.set(label, i);
    });
    for (const [label, start] of firstSeen) {
      const mine = order.map((l, i) => (l === label ? i : -1)).filter((i) => i >= 0);
      // Contiguous run: last index is start + count - 1.
      expect(mine.at(-1)).toBe(start + mine.length - 1);
    }
  });

  test("a lane restricted to one model only gets that model's reading", () => {
    const jobs = planPowerJobs(
      config({
        lanes: [
          { label: "Lane A", baseUrl: "http://localhost:9001" },
          { label: "Lane B", baseUrl: "http://localhost:9002", models: ["big"] },
        ],
      }),
    );
    expect(jobs.filter((j) => j.lane.label === "Lane B").map((j) => j.model?.id ?? "-")).toEqual(["-", "big"]);
  });
});

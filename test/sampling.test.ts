import { describe, expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";
import { newLaneState, runLane } from "../src/lane.ts";
import { buildRunFile } from "../src/runfile.ts";
import { applySettings, parseSettings, samplingBody, samplingLabel, samplingOf, samplingWarning } from "../src/settings.ts";
import { parseSweepArgs, withSweepArgs } from "../src/sweepcli.ts";
import { readRunFile, samplingText } from "../public/charts.js";

const lanes = [{ label: "A", baseUrl: "http://a:1", model: "m" }];
const base = () => validateConfig({ lanes });

/** A fetch that records the request body and answers with one short streamed reply. */
function recordingFetch(): { fetchImpl: typeof fetch; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe("sampling is set for every machine, checked, and saved with the results", () => {
  test("the config defaults to temperature 0 and accepts top_p and top_k", () => {
    const c = base();
    expect(c.temperature).toBe(0);
    expect(c.topP).toBeUndefined();
    expect(c.topK).toBeUndefined();
    const set = validateConfig({ lanes, temperature: 0.7, topP: 0.95, topK: 20 });
    expect(samplingOf(set)).toEqual({ temperature: 0.7, topP: 0.95, topK: 20 });
  });

  test("bad sampling values say why", () => {
    for (const bad of [{ temperature: -1 }, { temperature: 3 }, { topP: 0 }, { topP: 1.5 }, { topK: 0 }, { topK: 2.5 }, { topK: 5000 }]) {
      expect(() => validateConfig({ lanes, ...bad })).toThrow();
    }
  });

  test("a machine's extraBody may not set top_p or top_k, so every machine gets the same request", () => {
    expect(() => validateConfig({ lanes: [{ ...lanes[0], extraBody: { top_p: 0.9 } }] })).toThrow(/top_p/);
    expect(() => validateConfig({ lanes: [{ ...lanes[0], extraBody: { top_k: 5 } }] })).toThrow(/top_k/);
  });

  test("the page can change temperature and set or clear top_p / top_k", async () => {
    expect(parseSettings({ temperature: 0.7, topP: 0.95, topK: 20 })).toEqual({ ok: true, change: { temperature: 0.7, topP: 0.95, topK: 20 } });
    expect(parseSettings({ topP: null })).toEqual({ ok: true, change: { topP: null } });
    for (const bad of [{ temperature: -0.1 }, { temperature: "hot" }, { topP: 2 }, { topK: 1.5 }]) {
      expect(parseSettings(bad).ok).toBe(false);
    }
    const set = await applySettings({ config: base(), change: { temperature: 0.7, topP: 0.95, topK: 20 } });
    expect(set.ok && samplingOf(set.config)).toEqual({ temperature: 0.7, topP: 0.95, topK: 20 });
    if (!set.ok) throw new Error("expected ok");
    const cleared = await applySettings({ config: set.config, change: { topP: null, topK: null } });
    expect(cleared.ok && samplingOf(cleared.config)).toEqual({ temperature: 0.7 });
  });

  test("top_p and top_k go in the request only when set", async () => {
    const plain = recordingFetch();
    await runLane({ laneId: "lane-0", lane: lanes[0]!, prompt: "x", maxTokens: 16, temperature: 0, timeoutMs: 5000, emit: () => {}, fetchImpl: plain.fetchImpl }, newLaneState("lane-0", "A"));
    expect(plain.bodies[0]!.temperature).toBe(0);
    expect("top_p" in plain.bodies[0]!).toBe(false);
    expect("top_k" in plain.bodies[0]!).toBe(false);

    const set = recordingFetch();
    await runLane({ laneId: "lane-0", lane: lanes[0]!, prompt: "x", maxTokens: 16, temperature: 0.7, topP: 0.95, topK: 20, timeoutMs: 5000, emit: () => {}, fetchImpl: set.fetchImpl }, newLaneState("lane-0", "A"));
    expect(set.bodies[0]).toMatchObject({ temperature: 0.7, top_p: 0.95, top_k: 20 });
    expect(samplingBody({ temperature: 0.7, topP: 0.95 })).toEqual({ temperature: 0.7, top_p: 0.95 });
  });

  test("above temperature 0 with top_p or top_k unset, the tool warns; at 0 or fully set it does not", () => {
    expect(samplingWarning({ temperature: 0 })).toBeNull();
    expect(samplingWarning({ temperature: 0.7, topP: 0.95, topK: 20 })).toBeNull();
    expect(samplingWarning({ temperature: 0.7 })).toContain("top_p and top_k are not set");
    expect(samplingWarning({ temperature: 0.7, topP: 0.95 })).toContain("top_k is not set");
    expect(samplingLabel({ temperature: 0.7, topP: 0.95, topK: 20 })).toBe("temp 0.7, top_p 0.95, top_k 20");
  });

  test("the sweep command line sets sampling for one sweep, and none clears a saved value", () => {
    const parsed = parseSweepArgs(["--temperature", "0.7", "--top-p", "0.95", "--top-k", "20"]);
    expect(parsed).toMatchObject({ ok: true, args: { temperature: 0.7, topP: 0.95, topK: 20 } });
    expect(parseSweepArgs(["--temperature", "9"]).ok).toBe(false);
    expect(parseSweepArgs(["--top-p", "abc"]).ok).toBe(false);
    const saved = validateConfig({ lanes, temperature: 0.7, topP: 0.9, topK: 40 });
    const none = parseSweepArgs(["--top-p", "none"]);
    if (!none.ok) throw new Error("expected ok");
    expect(samplingOf(withSweepArgs(saved, none.args))).toEqual({ temperature: 0.7, topK: 40 });
  });

  test("the run file carries the sampling, and the results page reads it back", () => {
    const file = buildRunFile({ kind: "race", rows: [], lanes: [], setups: {}, maxTokens: 512, sampling: { temperature: 0.7, topP: 0.95 } });
    expect(file.settings).toEqual({ maxTokens: 512, thinking: "auto", temperature: 0.7, topP: 0.95 });
    const read = readRunFile({ ...file, rows: [{ preset: "short", concurrency: 1, laneId: "lane-0", label: "A", finished: 1, repeats: 1, speedUnit: "tokens/sec", firstWordSec: { median: 1, min: 1, max: 1 }, speed: { median: 50, min: 50, max: 50 } }], machines: [{ id: "lane-0", label: "A", model: "m", setup: null }] });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(samplingText(read.file.settings)).toBe("temp 0.7, top_p 0.95");
    // A file made before sampling was recorded says so instead of guessing.
    expect(samplingText({ maxTokens: 512, thinking: "auto", temperature: null, topP: null, topK: null })).toBe("not recorded");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecords, readRecords, toRecord } from "../src/log.ts";
import type { LaneResult, RunLogRecord } from "../src/types.ts";

const dirs: string[] = [];

async function tempLog(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-race-log-"));
  dirs.push(dir);
  return join(dir, "nested", "runs.jsonl");
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const result: LaneResult = {
  laneId: "lane-0",
  label: "Lane A",
  model: "/models/qwen3-14b-4bit",
  displayModel: "qwen3-14b-4bit",
  baseUrl: "http://localhost:8090",
  firstResponseSec: 0.081,
  firstWordSec: 0.412,
  firstWordField: "content",
  lastWordSec: 6.03,
  chunks: 184,
  tokens: 203,
  tokenSource: "usage",
  promptTokens: 4096,
  cachedTokens: 0,
  systemFingerprint: "0.31.3-0.31.2-testOS-testgpu",
  totalSec: 6.12,
  error: null,
  blocked: null,
  usageSupported: true,
};

describe("toRecord", () => {
  test("carries every field the report and a later audit need", () => {
    const record = toRecord({ result, runId: "r-1", preset: "8k", promptChars: 32800, ts: "2026-09-19T10:00:00.000Z" });
    expect(record).toEqual({
      ts: "2026-09-19T10:00:00.000Z",
      runId: "r-1",
      lane: "Lane A",
      baseUrl: "http://localhost:8090",
      model: "/models/qwen3-14b-4bit",
      preset: "8k",
      promptChars: 32800,
      promptTokens: 4096,
      firstResponseSec: 0.081,
      firstWordSec: 0.412,
      firstWordField: "content",
      lastWordSec: 6.03,
      chunks: 184,
      tokens: 203,
      tokenSource: "usage",
      totalSec: 6.12,
      error: null,
    });
  });

  test("records a blocked lane's reason in the error field", () => {
    const blocked = { ...result, blocked: "model not listed", firstWordSec: null, totalSec: null, tokens: null };
    const record = toRecord({ result: blocked, runId: "r-2", preset: "short", promptChars: 90 });
    expect(record.error).toBe("model not listed");
    expect(record.totalSec).toBeNull();
  });

  test("logs first response and first word as separate fields", () => {
    // An instant empty chunk answered at 0.081s; real text only at 0.412s.
    const record = toRecord({ result, runId: "r-4", preset: "short", promptChars: 90 });
    expect(record.firstResponseSec).toBe(0.081);
    expect(record.firstWordSec).toBe(0.412);
    expect(record.firstResponseSec).not.toBe(record.firstWordSec);
    expect(record.lastWordSec).toBe(6.03);
  });

  test("stamps an ISO timestamp when none is given", () => {
    const record = toRecord({ result, runId: "r-3", preset: "short", promptChars: 90 });
    expect(new Date(record.ts).toISOString()).toBe(record.ts);
  });
});

describe("appendRecords / readRecords", () => {
  test("writes exactly one line per lane and reads them back unchanged", async () => {
    const path = await tempLog();
    const a = toRecord({ result, runId: "r-1", preset: "8k", promptChars: 100 });
    const b = toRecord({ result: { ...result, label: "Lane B" }, runId: "r-1", preset: "8k", promptChars: 100 });

    await appendRecords([a, b], path);
    const raw = await Bun.file(path).text();
    expect(raw.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
    expect(raw.endsWith("\n")).toBe(true);
    // Every line is independently parseable JSON -- that is the point of JSONL.
    for (const line of raw.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();

    expect(await readRecords(path)).toEqual([a, b]);
  });

  test("appends across races rather than overwriting", async () => {
    const path = await tempLog();
    await appendRecords([toRecord({ result, runId: "r-1", preset: "short", promptChars: 1 })], path);
    await appendRecords([toRecord({ result, runId: "r-2", preset: "short", promptChars: 1 })], path);
    const records = await readRecords(path);
    expect(records.map((r) => r.runId)).toEqual(["r-1", "r-2"]);
  });

  test("a missing log reads as no runs, not an error", async () => {
    expect(await readRecords(join(tmpdir(), "llm-race-does-not-exist", "runs.jsonl"))).toEqual([]);
  });

  test("a half-written line does not break the read", async () => {
    const path = await tempLog();
    const good = toRecord({ result, runId: "r-1", preset: "short", promptChars: 1 });
    await appendRecords([good], path);
    await Bun.write(path, (await Bun.file(path).text()) + '{"ts":"broken\n');
    const records: RunLogRecord[] = await readRecords(path);
    expect(records).toHaveLength(1);
    expect(records[0]!.runId).toBe("r-1");
  });
});

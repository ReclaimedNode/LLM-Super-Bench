import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildQualityFile, formatTable, parseQualityArgs } from "../../src/quality/cli.ts";
import { parseIfEval } from "../../src/quality/data.ts";
import { checkResponse } from "../../src/quality/ifeval.ts";
import { SUITES } from "../../src/quality/suites.ts";
import { ask, runQuality } from "../../src/quality/runner.ts";
import type { LaneConfig, RaceConfig } from "../../src/types.ts";

const ifRows = (parseIfEval(readFileSync(resolve(import.meta.dir, "ifeval-sample.jsonl"), "utf8"), 3) as { rows: any[] }).rows;
const rows = ifRows.map((row) => ({ key: row.key, prompt: row.prompt, check: (r: string) => checkResponse(row, r) }));
// Row 1001 asks for no commas, row 1005 asks for 12 [placeholders]; row 1000 wants 300 words.
const laneA: LaneConfig = { label: "A", baseUrl: "http://a", model: "m" };
const laneB: LaneConfig = { label: "B", baseUrl: "http://b", model: "m", apiKey: "secret" };

const reply = (content: string, extra: Record<string, unknown> = {}, finish = "stop") =>
  Response.json({ choices: [{ message: { content, ...extra }, finish_reason: finish }] });

describe("ask", () => {
  test("sends one non-streaming request with the machine's own settings and key", async () => {
    let seen: { url: string; headers: Record<string, string>; body: any } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return reply("hi");
    }) as unknown as typeof fetch;
    const a = await ask(laneB, "Q?", { maxTokens: 77, extraBody: { chat_template_kwargs: { enable_thinking: false } }, timeoutMs: 1000, fetchImpl });
    expect(a).toEqual({ text: "hi", thinkingOnly: false, truncated: false, error: null });
    expect(seen!.url).toBe("http://b/v1/chat/completions");
    expect(seen!.headers.Authorization).toBe("Bearer secret");
    expect(seen!.body).toMatchObject({ model: "m", stream: false, max_tokens: 77, temperature: 0, chat_template_kwargs: { enable_thinking: false } });
    expect(seen!.body.messages).toEqual([{ role: "user", content: "Q?" }]);
  });
  test("tells thinking-only and cut-off replies apart from empty ones", async () => {
    const think = await ask(laneA, "q", { maxTokens: 5, timeoutMs: 1000, fetchImpl: (async () => reply("", { reasoning_content: "hmm" }, "length")) as unknown as typeof fetch });
    expect(think.thinkingOnly).toBe(true);
    expect(think.truncated).toBe(true);
  });
  test("a server error is an error, not a wrong answer", async () => {
    const a = await ask(laneA, "q", { maxTokens: 5, timeoutMs: 1000, fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch });
    expect(a.error).toContain("HTTP 500");
  });
  test("a request that never answers times out", async () => {
    const a = await ask(laneA, "q", { maxTokens: 5, timeoutMs: 30, fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("x", "TimeoutError"))))) as unknown as typeof fetch });
    expect(a.error).toContain("Timed out");
  });
});

describe("runQuality", () => {
  // Machine A answers without commas; machine B always writes one.
  const fetchImpl = (async (url: string) => (url.startsWith("http://a") ? reply("A trip in verse") : reply("A trip, in verse"))) as unknown as typeof fetch;
  test("every machine is asked every question and scored on its own answers", async () => {
    const results = await runQuality({
      lanes: [{ laneId: "lane-0", lane: laneA }, { laneId: "lane-1", lane: laneB }],
      questions: [rows[1]],
      maxTokens: 100,
      streams: 2,
      timeoutMs: 1000,
      fetchImpl,
    });
    expect(results.map((r) => r.score.promptStrict)).toEqual([1, 0]);
    expect(results[0]!.outcomes[0]!.response).toBe("A trip in verse");
    expect(results[1]!.byRule["punctuation:no_comma"]).toEqual({ total: 1, strict: 0 });
  });
  test("a machine that errors on every question scores zero and says why", async () => {
    const [r] = await runQuality({ lanes: [{ laneId: "lane-0", lane: laneA }], questions: rows, maxTokens: 10, streams: 1, timeoutMs: 1000, fetchImpl: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch });
    expect(r!.errors).toBe(3);
    expect(r!.answered).toBe(0);
    expect(r!.score.promptStrict).toBe(0);
  });
  test("the work is spread over the streams asked for and reports progress", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return reply("x");
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    await runQuality({ lanes: [{ laneId: "lane-0", lane: laneA }], questions: rows, maxTokens: 10, streams: 2, timeoutMs: 1000, fetchImpl: slow, onProgress: (_l, d) => seen.push(d) });
    expect(peak).toBe(2);
    expect(seen.length).toBe(3);
  });
});

describe("the command line and the saved file", () => {
  test("arguments", () => {
    expect(parseQualityArgs([])).toEqual({ ok: true, args: { suite: "ifeval", sizes: ["4k", "8k", "16k", "32k"], limit: null, machines: null, maxTokens: 1024, streams: 1 } });
    const p = parseQualityArgs(["--limit", "60", "--machines", "A,B", "--max-tokens", "2048", "--thinking", "off", "--streams", "4"]);
    expect(p.ok && p.args).toMatchObject({ limit: 60, machines: ["A", "B"], maxTokens: 2048, thinking: "off", streams: 4 });
    expect(parseQualityArgs(["--limit", "0"]).ok).toBe(false);
    expect(parseQualityArgs(["--limit", "9999"]).ok).toBe(false);
    expect(parseQualityArgs(["--streams", "0"]).ok).toBe(false);
    expect(parseQualityArgs(["--wat"]).ok).toBe(false);
    expect(parseQualityArgs(["--suite", "nope"]).ok).toBe(false);
    const suite = parseQualityArgs(["--suite", "longctx", "--sizes", "8k,128k"]);
    expect(suite.ok && suite.args).toMatchObject({ suite: "longctx", sizes: ["8k", "128k"] });
    expect(parseQualityArgs(["--suite", "longctx", "--limit", "5"]).ok).toBe(false);
    expect(parseQualityArgs(["--sizes", "short"]).ok).toBe(false);
    expect(parseQualityArgs(["--suite", "gsm8k", "--limit", "1320"]).ok).toBe(false);
  });
  test("the saved file names the benchmark and its licence and holds no addresses", async () => {
    const results = await runQuality({ lanes: [{ laneId: "lane-0", lane: { ...laneA, baseUrl: "http://10.1.2.3:8000" } }], questions: [rows[1]], maxTokens: 100, streams: 1, timeoutMs: 1000, fetchImpl: (async () => reply("fine")) as unknown as typeof fetch });
    const config = { lanes: [{ ...laneA, baseUrl: "http://10.1.2.3:8000", model: "/Users/me/models/Big-Q4.gguf", watts: 150 }] } as unknown as RaceConfig;
    const file = buildQualityFile({ suite: SUITES.ifeval, config, setups: {}, results, questions: 1, maxTokens: 100, thinking: "off" });
    const text = JSON.stringify(file);
    expect(file.format).toBe("llm-super-bench-quality");
    expect(file.benchmark).toMatchObject({ name: "IFEval", license: "Apache-2.0", questions: 1, of: 541 });
    expect(file.machines[0]).toMatchObject({ label: "A", model: "Big-Q4.gguf", watts: 150 });
    expect(text).not.toContain("10.1.2.3");
    expect(text).not.toContain("/Users/me");
    expect(formatTable(file)).toContain("100.0%");
  });
});

describe("against the mock server", () => {
  test("a non-streaming question gets one JSON reply the quality test can read", async () => {
    const { startMockLane } = await import("../../src/mock.ts");
    const server = startMockLane({ port: 0, firstWordDelayMs: 1, chunkIntervalMs: 1, chunks: 5, includeUsage: false, modelId: "mock-model" } as any);
    try {
      const port = (server as any).port ?? (server as any).server?.port;
      const lane: LaneConfig = { label: "M", baseUrl: `http://localhost:${port}`, model: "mock-model" };
      const a = await ask(lane, "hello", { maxTokens: 100, timeoutMs: 5000 });
      expect(a.error).toBeNull();
      expect(a.text.length).toBeGreaterThan(0);
    } finally {
      (server as any).stop?.(true);
      (server as any).server?.stop?.(true);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { probeDetails, readDetails } from "../src/details.ts";
import { extraBodyFor } from "../src/settings.ts";
import { validateConfig } from "../src/config.ts";
import { parseEditedLanes } from "../src/editor.ts";
import { buildScoreboard } from "../src/timing.ts";

const lane = { label: "X", slots: undefined, notes: undefined, engine: undefined } as never;
const models = (id: string, extra: object = {}) => ({ data: [{ id, ...extra }] });

describe("engine detection", () => {
  test("llama.cpp and vLLM are named", () => {
    expect(readDetails(lane, "a", { props: { model_path: "/m/Foo-Q8_0.gguf", build_info: "b1" }, slots: null, models: null }).engine).toBe("llama.cpp");
    expect(readDetails(lane, "a", { props: null, slots: null, models: models("m", { owned_by: "vllm", root: "org/Foo-AWQ" }) }).engine).toBe("vLLM");
  });

  test("Ollama: version, quant and loaded context", () => {
    const d = readDetails(lane, "a", {
      props: null, slots: null, models: models("llama3:8b", { owned_by: "library" }),
      extra: {
        ollamaVersion: { version: "0.12.3" },
        ollamaTags: { models: [{ name: "llama3:8b", details: { quantization_level: "Q4_K_M" } }] },
        ollamaPs: { models: [{ name: "llama3:8b", context_length: 4096 }] },
      },
    });
    expect(d.engine).toBe("Ollama");
    expect(d.build).toBe("Ollama 0.12.3");
    expect(d.quant).toBe("Q4_K_M");
    expect(d.contextPerSlot).toBe(4096);
    expect(d.reachable).toBe(true);
  });

  test("LM Studio, SGLang, KoboldCpp, TGI and TensorRT-LLM", () => {
    const lm = readDetails(lane, "a", { props: null, slots: null, models: models("qwen"), extra: { lmstudio: { data: [{ id: "qwen", state: "loaded", compatibility_type: "mlx", quantization: "4bit", loaded_context_length: 32768 }] } } });
    expect([lm.engine, lm.quant, lm.contextPerSlot]).toEqual(["LM Studio (MLX)", "4bit", 32768]);
    const sg = readDetails(lane, "a", { props: null, slots: null, models: models("m", { owned_by: "sglang" }), extra: { sglang: { version: "0.5", model_path: "/x/Foo", max_running_requests: 64, context_length: 8192 } } });
    expect([sg.engine, sg.build, sg.slots, sg.contextPerSlot]).toEqual(["SGLang", "SGLang 0.5", 64, 8192]);
    const kb = readDetails(lane, "a", { props: null, slots: null, models: models("m"), extra: { kobold: { result: "KoboldCpp", version: "1.80" } } });
    expect([kb.engine, kb.build]).toEqual(["KoboldCpp", "KoboldCpp 1.80"]);
    const tg = readDetails(lane, "a", { props: null, slots: null, models: models("m"), extra: { tgi: { model_id: "org/Foo", version: "3.0", max_concurrent_requests: 128, max_total_tokens: 4096 } } });
    expect([tg.engine, tg.slots, tg.modelFile]).toEqual(["TGI", 128, "Foo"]);
    expect(readDetails(lane, "a", { props: null, slots: null, models: models("m", { owned_by: "tensorrt_llm" }) }).engine).toBe("TensorRT-LLM");
  });

  test("Strata is told apart from other servers that answer /health", () => {
    const d = readDetails(lane, "a", { props: null, slots: null, models: models("any"), extra: { strata: { status: "ok", model: "/m/Qwen3.8-Flash-Next-Q4.gguf", max_context: 65536, images: true, api_key: true, loaded: true } } });
    expect([d.engine, d.modelFile, d.contextPerSlot, d.vision]).toEqual(["Strata", "Qwen3.8-Flash-Next-Q4.gguf", 65536, true]);
    // llama-server's and vLLM's /health say nothing like that.
    expect(readDetails(lane, "a", { props: null, slots: null, models: models("m"), extra: { strata: { status: "ok" } } }).engine).toBeNull();
  });

  test("an unknown server stays unnamed, and a typed engine wins", () => {
    expect(readDetails(lane, "a", { props: null, slots: null, models: models("m") }).engine).toBeNull();
    const typed = { ...lane, engine: "TensorFold" } as never;
    expect(readDetails(typed, "a", { props: null, slots: null, models: models("m") }).engine).toBe("TensorFold");
  });

  test("probing asks every engine's address and survives all of them being absent", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(new URL(url).pathname);
      if (url.endsWith("/v1/models")) return new Response(JSON.stringify(models("m")));
      if (url.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.1.2" }));
      return new Response("no", { status: 404 });
    }) as never;
    const d = await probeDetails({ label: "X", baseUrl: "http://h:1", model: "m" } as never, "a", { fetchImpl });
    expect(d.engine).toBe("Ollama");
    for (const p of ["/api/version", "/api/v0/models", "/get_server_info", "/info", "/api/extra/version", "/health"]) expect(seen).toContain(p);
  });
});

describe("engine in config and editor", () => {
  const base = { port: 1, maxTokens: 512, temperature: 0, charsPerToken: 4, promptFile: "x", requestTimeoutMs: 1000, lanes: [{ label: "A", baseUrl: "http://a:1", model: "m", engine: " TensorFold " }] };
  test("a typed engine is trimmed, and a long one is refused", () => {
    expect(validateConfig(base as never).lanes[0]!.engine).toBe("TensorFold");
    expect(() => validateConfig({ ...base, lanes: [{ ...base.lanes[0], engine: "x".repeat(41) }] } as never)).toThrow();
  });
  test("the editor keeps it", () => {
    const r = parseEditedLanes({ lanes: [{ label: "A", baseUrl: "http://a:1", engine: "MLX-LM" }] });
    expect(r.ok && r.lanes[0]!.engine).toBe("MLX-LM");
  });
});

describe("thinking switch per engine", () => {
  test("Ollama gets reasoning_effort, others keep chat_template_kwargs, own extraBody wins", () => {
    expect(extraBodyFor({}, "off", "Ollama")).toEqual({ reasoning_effort: "none" });
    expect(extraBodyFor({}, "low", "Ollama")).toEqual({ reasoning_effort: "low" });
    expect(extraBodyFor({}, "off", "Strata")).toEqual({ reasoning_effort: "none" });
    expect(extraBodyFor({}, "off", "vLLM")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(extraBodyFor({ extraBody: { reasoning_effort: "high" } }, "off", "Ollama")).toEqual({ reasoning_effort: "high" });
  });
});

describe("honesty warnings", () => {
  const done = (o: object) => ({ laneId: "a", label: "A", model: "m", displayModel: "m", baseUrl: "", firstResponseSec: 1, firstWordSec: 1, firstWordField: "content", lastWordSec: 5, chunks: 100, tokens: 100, tokenSource: "usage", promptTokens: 1000, cachedTokens: 0, systemFingerprint: null, totalSec: 5, error: null, blocked: null, usageSupported: true, ...o }) as never;
  test("a server that reused cached prompt tokens is called out", () => {
    const board = buildScoreboard([done({ cachedTokens: 900 }), done({ laneId: "b", label: "B" })]);
    expect(board.notes.some((n) => n.includes("A's server reused 900 prompt tokens"))).toBe(true);
  });
  test("a one-or-two token reply is called out", () => {
    const board = buildScoreboard([done({ tokens: 2 }), done({ laneId: "b", label: "B" })]);
    expect(board.notes.some((n) => n.includes("A wrote only 2 tokens"))).toBe(true);
  });
});

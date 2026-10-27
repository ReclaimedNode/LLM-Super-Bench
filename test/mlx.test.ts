import { describe, expect, test } from "bun:test";
import { mlxQuantOf, probeDetails, readDetails, shortModelName } from "../src/details.ts";
import { notLoadedModel, preflightLane } from "../src/preflight.ts";
import { PROBE_PATHS } from "../src/probe.ts";

const lane = { label: "Studio MLX", slots: undefined, notes: undefined, engine: undefined } as never;
const VLM_PATH = "/Users/me/models/Foo-27B-MLX/8-bit";

// What mlx-vlm 0.7.10 answers at /health and /v1/models, trimmed.
const vlmHealth = {
  status: "healthy",
  loaded_model: VLM_PATH,
  loaded_adapter: null,
  loaded_models: { text_generation: { model: VLM_PATH, adapter: null, model_kind: "text_generation" } },
  loaded_context_size: 262144,
  configured_context_limit: null,
  effective_context_limit: 262144,
  loaded_tool_parser: null,
  continuous_batching_enabled: true,
  apc_enabled: false,
};
const vlmModels = { object: "list", data: [{ id: VLM_PATH, object: "model", created: 1, loaded: true }, { id: "org/Other-MLX-8bit", object: "model", created: 1, loaded: false }] };

/** A fetch that answers like a server, with a Server header on every reply. */
function server(routes: Record<string, unknown>, serverHeader: string): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    if (!(path in routes)) return new Response("Not Found", { status: 404, headers: { Server: serverHeader } });
    return Response.json(routes[path], { headers: { Server: serverHeader } });
  }) as unknown as typeof fetch;
}

describe("MLX servers are recognised", () => {
  test("names: a bit-width folder keeps its parent, and the bit width becomes the quant", () => {
    expect(shortModelName(VLM_PATH)).toBe("Foo-27B-MLX/8-bit");
    expect(shortModelName("/m/Foo-Q8_0.gguf")).toBe("Foo-Q8_0.gguf");
    expect(mlxQuantOf(VLM_PATH)).toBe("MLX 8-bit");
    expect(mlxQuantOf("mlx-community/Qwen3-8B-4bit")).toBe("MLX 4-bit");
    expect(mlxQuantOf("mlx-community/Qwen3-8B-bf16")).toBe("BF16");
    expect(mlxQuantOf(null)).toBeNull();
  });

  test("mlx-vlm: version from its Server header, loaded model, quant, context and drafter", () => {
    const d = readDetails(lane, "a", {
      props: null, slots: null, models: vlmModels,
      extra: { health: vlmHealth, server: "mlx_vlm/0.7.10", mlxSettings: { current: { draft_model: "/m/mtp", draft_kind: "mtp" } } },
    });
    expect(d.engine).toBe("mlx-vlm");
    expect(d.build).toBe("mlx-vlm 0.7.10, mtp drafter");
    expect(d.modelFile).toBe("Foo-27B-MLX/8-bit");
    expect(d.quant).toBe("MLX 8-bit");
    expect(d.contextPerSlot).toBe(262144);
    expect(d.slots).toBeNull(); // --max-num-seqs is not reported: set `slots` on the machine
    expect(d.modelId).toBe("Foo-27B-MLX/8-bit");
  });

  test("mlx-vlm is recognised from /health alone, and without a drafter says nothing about one", () => {
    const d = readDetails(lane, "a", { props: null, slots: null, models: vlmModels, extra: { health: vlmHealth } });
    expect([d.engine, d.build]).toEqual(["mlx-vlm", "mlx-vlm"]);
  });

  test("mlx-lm: Python's server header and plain answers; the configured model is read from its list", () => {
    const models = { object: "list", data: [{ id: "mlx-community/Cached-4bit", object: "model", created: 1 }, { id: "/Users/me/models/Mine-8bit", object: "model", created: 1 }] };
    const extra = { health: { status: "ok" }, server: "BaseHTTP/0.6 Python/3.12.9" };
    const started = readDetails(lane, "a", { props: null, slots: null, models, extra });
    expect([started.engine, started.build, started.modelFile, started.quant]).toEqual(["mlx-lm", "mlx-lm", "Mine-8bit", "MLX 8-bit"]);
    const configured = readDetails({ ...(lane as object), model: "mlx-community/Cached-4bit" } as never, "a", { props: null, slots: null, models, extra });
    expect([configured.modelFile, configured.quant]).toEqual(["Cached-4bit", "MLX 4-bit"]);
  });

  test("other servers are not mistaken for MLX ones", () => {
    // llama-server also answers {"status":"ok"} at /health, but lists owned_by and has /props.
    const llama = readDetails(lane, "a", {
      props: { model_path: "/m/Foo-Q8_0.gguf", build_info: "b1" }, slots: null,
      models: { data: [{ id: "/m/Foo-Q8_0.gguf", owned_by: "llamacpp" }] },
      extra: { health: { status: "ok" }, server: "llama.cpp" },
    });
    expect(llama.engine).toBe("llama.cpp");
    // A Python server whose list says who owns the model is not called mlx-lm.
    const other = readDetails(lane, "a", { props: null, slots: null, models: { data: [{ id: "m", owned_by: "someone" }] }, extra: { health: { status: "ok" }, server: "BaseHTTP/0.6 Python/3.12" } });
    expect(other.engine).toBeNull();
  });

  test("probeDetails asks mlx-vlm for its settings, read from a live-shaped server", async () => {
    const fetchImpl = server({ "/v1/models": vlmModels, "/health": vlmHealth, "/v1/settings": { current: { draft_model: "/m/mtp", draft_kind: "mtp" } } }, "mlx_vlm/0.7.10");
    const d = await probeDetails({ label: "Studio MLX", baseUrl: "http://studio:8001", model: VLM_PATH }, "lane-0", { fetchImpl });
    expect([d.engine, d.build, d.quant]).toEqual(["mlx-vlm", "mlx-vlm 0.7.10, mtp drafter", "MLX 8-bit"]);
    const lm = await probeDetails({ label: "LM", baseUrl: "http://studio:8080", model: "x" }, "lane-1", {
      fetchImpl: server({ "/v1/models": { data: [{ id: "/m/Mine-4bit", object: "model", created: 1 }] }, "/health": { status: "ok" } }, "BaseHTTP/0.6 Python/3.12.9"),
    });
    expect([lm.engine, lm.modelFile]).toEqual(["mlx-lm", "Mine-4bit"]);
    expect(PROBE_PATHS).toContain("/v1/settings");
  });

  test("a machine set to a model mlx-vlm lists but has not loaded is refused, so it cannot swap models mid-race", async () => {
    expect(notLoadedModel(vlmModels, "org/Other-MLX-8bit")).toEqual({ loaded: VLM_PATH });
    expect(notLoadedModel(vlmModels, VLM_PATH)).toBeNull();
    expect(notLoadedModel({ data: [{ id: "a" }, { id: "b" }] }, "b")).toBeNull(); // servers that do not mark entries
    const fetchImpl = server({ "/v1/models": vlmModels }, "mlx_vlm/0.7.10");
    const r = await preflightLane({ lane: { label: "Studio MLX", baseUrl: "http://studio:8001", model: "org/Other-MLX-8bit" }, timeoutMs: 2000, skipUsageProbe: true, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("unload and load models");
  });
});

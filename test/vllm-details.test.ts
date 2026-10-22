import { afterAll, describe, expect, test } from "bun:test";
import { probeDetails, quantOf, readDetails } from "../src/details.ts";
import { startMockLane } from "../src/mock.ts";

const lane = { label: "vLLM box", baseUrl: "", model: "m" } as never;

describe("a vLLM machine reports what it can", () => {
  test("model, context, version and the quant in its name are read from /v1/models and /version", () => {
    const d = readDetails({ label: "V", notes: undefined, slots: undefined }, "v", {
      props: null,
      slots: null,
      models: {
        data: [{ id: "qwen", owned_by: "vllm", root: "/models/Qwen3-32B-AWQ", max_model_len: 40960 }],
      },
      version: { version: "0.11.0" },
      metrics: null,
    });
    expect(d.reachable).toBe(true);
    expect(d.modelFile).toBe("Qwen3-32B-AWQ");
    expect(d.quant).toBe("AWQ");
    expect(d.build).toBe("vLLM 0.11.0");
    expect(d.contextPerSlot).toBe(40960);
    expect(d.slots).toBeNull();
  });

  test("slots come from max_num_seqs in /metrics when the server says it, and are left unknown when not", () => {
    const base = { props: null, slots: null, models: { data: [{ id: "x", owned_by: "vllm", max_model_len: 8192 }] } };
    const l = { label: "V", notes: undefined, slots: undefined };
    const yes = readDetails(l, "v", { ...base, metrics: 'vllm:cache_config_info{block_size="16",max_num_seqs="64"} 1.0' });
    expect(yes.slots).toBe(64);
    expect(yes.slotsSource).toBe("server");
    expect(readDetails(l, "v", { ...base, metrics: "# nothing useful" }).slots).toBeNull();
  });

  test("a llama-server answer is untouched by the vLLM reading", () => {
    const d = readDetails({ label: "L", notes: undefined, slots: undefined }, "l", {
      props: { total_slots: 2, model_path: "/m/Foo-Q8_0.gguf", build_info: "b1", default_generation_settings: { n_ctx: 131072 } },
      slots: null,
      models: { data: [{ id: "/m/Foo-Q8_0.gguf" }] },
    });
    expect(d.build).toBe("b1");
    expect(d.slots).toBe(2);
    expect(d.contextPerSlot).toBe(131072);
  });

  test("the usual vLLM quantisations are recognised, and a plain name is not guessed at", () => {
    expect(quantOf("Llama-3.1-8B-Instruct-FP8")).toBe("FP8");
    expect(quantOf("Qwen3-32B-GPTQ-Int4")).toBe("GPTQ");
    expect(quantOf("Qwen3-32B")).toBeNull();
  });

  const server = startMockLane({
    port: 0,
    modelId: "qwen-alias",
    vllm: { root: "Qwen/Qwen3-32B-AWQ", maxModelLen: 32768, version: "0.11.0" },
  });
  afterAll(() => server.stop(true));

  test("asked over HTTP, a server with no /props still fills the card", async () => {
    const d = await probeDetails({ ...(lane as object), baseUrl: `http://localhost:${server.port}` } as never, "v");
    expect(d.reachable).toBe(true);
    expect(d.modelFile).toBe("Qwen3-32B-AWQ");
    expect(d.quant).toBe("AWQ");
    expect(d.build).toBe("vLLM 0.11.0");
    expect(d.contextPerSlot).toBe(32768);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { validateConfig } from "../src/config.ts";
import { baseName, differences, probeDetails, quantOf, readDetails, setupOf } from "../src/details.ts";
import type { MachineDetails } from "../src/details.ts";
import { readRecords } from "../src/log.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import { startMockLane } from "../src/mock.ts";
import { runRace } from "../src/race.ts";
import { sweepCsv, summarizeCell } from "../src/sweep.ts";
import type { LaneConfig, LaneResult } from "../src/types.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function mock(over: Partial<MockLaneOptions> = {}): Server {
  const s = startMockLane({ port: 0, firstWordDelayMs: 10, chunkIntervalMs: 2, chunks: 10, includeUsage: true, ...over });
  servers.push(s);
  return s;
}
const laneFor = (s: Server, label: string, extra: Partial<LaneConfig> = {}): LaneConfig => ({
  label,
  baseUrl: `http://localhost:${s.port}`,
  model: "mock-model",
  displayModel: "mock-model",
  ...extra,
});

describe("reading a file name", () => {
  test("quantization comes out of the name, and only when the name has one", () => {
    expect(quantOf("Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf")).toBe("Q8_0");
    expect(quantOf("Model-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantOf("model.IQ3_XXS.gguf")).toBe("IQ3_XXS");
    expect(quantOf("Model-BF16.gguf")).toBe("BF16");
    expect(quantOf("mystery.gguf")).toBeNull();
    expect(quantOf(null)).toBeNull();
  });

  test("the folder is dropped, on either kind of path", () => {
    expect(baseName("/Users/me/models/Foo-Q8_0.gguf")).toBe("Foo-Q8_0.gguf");
    expect(baseName("C:\\models\\Foo.gguf")).toBe("Foo.gguf");
    expect(baseName("Foo.gguf")).toBe("Foo.gguf");
  });
});

describe("readDetails", () => {
  const props = {
    default_generation_settings: { n_ctx: 131072 },
    total_slots: 2,
    model_path: "/Users/me/models/Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf",
    build_info: "b6789-abcdef",
    modalities: { vision: true, audio: false },
    chat_template: "{% if enable_thinking %}<think>{% endif %}",
  };
  const slots = [{ id: 0, n_ctx: 131072 }, { id: 1, n_ctx: 131072 }];
  const models = { data: [{ id: "/Users/me/models/Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf", meta: { n_params: 27e9, n_ctx_train: 262144 } }] };

  test("takes what matters and never keeps a folder", () => {
    const d = readDetails({ label: "Studio" }, "lane-0", { props, slots, models });
    expect(d).toMatchObject({
      label: "Studio",
      reachable: true,
      modelFile: "Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf",
      quant: "Q8_0",
      build: "b6789-abcdef",
      slots: 2,
      slotsSource: "server",
      contextPerSlot: 131072,
      slotContexts: [131072, 131072],
      vision: true,
      templateMentionsThinking: true,
      trainContext: 262144,
      parameters: 27e9,
      modelId: "Huihui-Qwen3.8-27B-abliterated-Q8_0.gguf",
    });
    expect(JSON.stringify(d)).not.toContain("/Users/");
  });

  test("a number in the config beats the server's slot count", () => {
    const d = readDetails({ label: "A", slots: 8 }, "lane-0", { props, slots, models });
    expect(d.slots).toBe(8);
    expect(d.slotsSource).toBe("config");
  });

  test("a silent machine is unknown all the way down, not zero", () => {
    const d = readDetails({ label: "A" }, "lane-0", { props: null, slots: null, models: null });
    expect(d.reachable).toBe(false);
    expect(d.slots).toBeNull();
    expect(d.contextPerSlot).toBeNull();
    expect(d.modelFile).toBeNull();
    expect(d.vision).toBeNull();
  });

  test("a server with /props but no /slots still gives its context", () => {
    const d = readDetails({ label: "A" }, "lane-0", { props, slots: null, models: null });
    expect(d.slotContexts).toBeNull();
    expect(d.contextPerSlot).toBe(131072);
  });
});

describe("differences", () => {
  const base = (over: Partial<MachineDetails>): MachineDetails =>
    ({
      laneId: "lane-0", label: "A", reachable: true, modelFile: "M-Q8_0.gguf", quant: "Q8_0", build: "b1", slots: 2,
      slotsSource: "server", contextPerSlot: 131072, slotContexts: null, vision: false, notes: null, modelId: null,
      trainContext: null, parameters: null, templateMentionsThinking: null, ...over,
    }) as MachineDetails;

  test("identical machines have none", () => {
    expect(differences([base({}), base({ label: "B", laneId: "lane-1" })])).toEqual([]);
  });

  test("says what differs and for whom", () => {
    const out = differences([base({}), base({ label: "B", laneId: "lane-1", quant: "Q4_K_M", build: "b2", slots: 4 })]);
    expect(out.some((l) => l.startsWith("Quantization differs: A Q8_0, B Q4_K_M"))).toBe(true);
    expect(out.some((l) => l.includes("Server build differs"))).toBe(true);
    expect(out.some((l) => l.startsWith("Slots differs"))).toBe(true);
  });

  test("a machine that did not say is not 'different', it is reported as silent", () => {
    const out = differences([base({}), base({ label: "B", laneId: "lane-1", reachable: false, quant: null, build: null, slots: null, modelFile: null, contextPerSlot: null, vision: null })]);
    expect(out.length).toBe(1);
    expect(out[0]).toContain("B did not answer");
  });

  test("one machine on its own has nothing to differ from", () => {
    expect(differences([base({})])).toEqual([]);
  });

  test("different notes are shown side by side", () => {
    const out = differences([base({ notes: "spec decoding on" }), base({ label: "B", laneId: "lane-1" })]);
    expect(out[0]).toBe("Notes differ: A: spec decoding on; B: none given.");
  });
});

describe("probeDetails against a server", () => {
  test("a llama-server-like mock answers all three", async () => {
    const s = mock({ slots: 3, contextTokens: 8192, modelPath: "/m/Foo-Q6_K.gguf", build: "b42" });
    const d = await probeDetails(laneFor(s, "A"), "lane-0");
    expect(d).toMatchObject({ reachable: true, slots: 3, contextPerSlot: 8192, modelFile: "Foo-Q6_K.gguf", quant: "Q6_K", build: "b42" });
    expect(d.slotContexts).toEqual([8192, 8192, 8192]);
  });

  test("a server with none of it is reachable (it has /v1/models) but says nothing else", async () => {
    const s = mock();
    const d = await probeDetails(laneFor(s, "A"), "lane-0");
    expect(d.reachable).toBe(true);
    expect(d.slots).toBeNull();
    expect(d.build).toBeNull();
  });

  test("a machine that is down comes back unreachable, without throwing", async () => {
    const s = mock();
    const lane = laneFor(s, "A");
    s.stop(true);
    const d = await probeDetails(lane, "lane-0", { timeoutMs: 400 });
    expect(d.reachable).toBe(false);
  });
});

describe("notes in the config", () => {
  const cfg = (notes: unknown) => ({
    lanes: [
      { label: "A", baseUrl: "http://a:1", model: "m", ...(notes === undefined ? {} : { notes }) },
      { label: "B", baseUrl: "http://b:1", model: "m" },
    ],
  });
  test("kept, trimmed; blank is dropped; too long or not text is refused", () => {
    expect(validateConfig(cfg("  -c 262144, spec decoding  ")).lanes[0]!.notes).toBe("-c 262144, spec decoding");
    expect(validateConfig(cfg("   ")).lanes[0]!.notes).toBeUndefined();
    expect(() => validateConfig(cfg("x".repeat(301)))).toThrow(/notes/);
    expect(() => validateConfig(cfg(5))).toThrow(/notes/);
  });
});

describe("the setup travels with the results", () => {
  test("every logged run carries the machine's setup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "details-"));
    dirs.push(dir);
    const logPath = join(dir, "runs.jsonl");
    const a = mock({ slots: 2, modelPath: "/m/Foo-Q8_0.gguf", build: "b1" });
    const lane = laneFor(a, "Studio", { notes: "spec decoding on" });
    const d = await probeDetails(lane, "lane-0");
    await runRace({
      config: { port: 0, maxTokens: 512, temperature: 0, charsPerToken: 4, promptFile: "p", requestTimeoutMs: 20_000, preflightTimeoutMs: 10_000, lanes: [lane, laneFor(mock(), "Box")] },
      preset: "short", sourceText: "x", emit: () => {}, logPath, skipUsageProbe: true, tickMs: 20,
      laneSetups: { "lane-0": setupOf(d) },
    });
    const records = await readRecords(logPath);
    const studio = records.find((r) => r.lane === "Studio")!;
    expect(studio.setup).toEqual({ engine: "llama.cpp", modelFile: "Foo-Q8_0.gguf", quant: "Q8_0", build: "b1", slots: 2, contextPerSlot: 32768, vision: false, notes: "spec decoding on" });
    expect(records.find((r) => r.lane === "Box")!.setup).toBeUndefined();
  });

  test("the sweep CSV gets the setup columns", () => {
    const result = { laneId: "lane-0", label: "Studio", firstWordSec: 1, lastWordSec: 11, chunks: 101, tokens: 101, totalSec: 11, error: null, blocked: null, promptTokens: 4000, cachedTokens: 0, firstWordField: "content" } as unknown as LaneResult;
    const rows = summarizeCell("4k", 1, [[result]]);
    const csv = sweepCsv(rows, { "lane-0": { engine: "llama.cpp", modelFile: "Foo-Q8_0.gguf", quant: "Q8_0", build: "b1", slots: 2, contextPerSlot: 131072, vision: false, notes: "a, b" } }, { maxTokens: 512, thinking: "low" });
    const [head, line] = csv.trimEnd().split("\n");
    expect(head).toEndWith("engine,model_file,quant,llama_cpp_build,slots,context_per_slot,machine_notes,reply_length,thinking");
    expect(line).toEndWith('llama.cpp,Foo-Q8_0.gguf,Q8_0,b1,2,131072,"a, b",512,low');
  });
});

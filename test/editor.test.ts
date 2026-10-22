import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.ts";
import { applyEdit, checkMachine, mergeLanes, parseEditedLanes } from "../src/editor.ts";
import { normalizeAddress } from "../src/init.ts";
import { startMockLane } from "../src/mock.ts";
import type { MockLaneOptions } from "../src/mock.ts";
import type { LaneConfig, RaceConfig } from "../src/types.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop(true);
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const mock = (over: Partial<MockLaneOptions> = {}) => {
  const s = startMockLane({ port: 0, firstWordDelayMs: 1, chunkIntervalMs: 1, chunks: 3, ...over });
  servers.push(s);
  return s;
};
const url = (s: Server) => `http://localhost:${s.port}`;

const baseConfig = (lanes: LaneConfig[]): RaceConfig =>
  validateConfig({ port: 9500, lanes, maxTokens: 256, password: "pw" });

describe("normalizeAddress", () => {
  test("accepts what people type", () => {
    expect(normalizeAddress("192.168.1.50:8000")).toBe("http://192.168.1.50:8000");
    expect(normalizeAddress(" http://h:8000/ ")).toBe("http://h:8000");
    expect(normalizeAddress("https://h/v1")).toBe("https://h");
  });
  test("refuses what is not an address", () => {
    expect(normalizeAddress("")).toBeNull();
    expect(normalizeAddress("   ")).toBeNull();
    expect(normalizeAddress("http://")).toBeNull();
  });
});

describe("parseEditedLanes", () => {
  const ok = [{ label: "A", baseUrl: "h:1" }, { label: "B", baseUrl: "http://h:2", notes: " spec on " }];

  test("a good list is tidied", () => {
    expect(parseEditedLanes({ lanes: ok })).toEqual({
      ok: true,
      lanes: [{ label: "A", baseUrl: "http://h:1" }, { label: "B", baseUrl: "http://h:2", notes: "spec on" }],
    });
  });

  test("every mistake is a sentence that names the machine", () => {
    const err = (lanes: unknown) => {
      const r = parseEditedLanes({ lanes });
      return r.ok ? null : r.error;
    };
    expect(err("nope")).toContain("list of machines");
    expect(err([])).toContain("between 1 and 4");
    expect(err([...ok, ...ok, ok[0]])).toContain("between 1 and 4");
    expect(err([{ label: " ", baseUrl: "h:1" }, ok[1]])).toContain("Machine 1 needs a name");
    expect(err([{ label: "A", baseUrl: "h:1" }, { label: "A", baseUrl: "h:2" }])).toContain('Two machines are called "A"');
    expect(err([ok[0], { label: "B", baseUrl: "" }])).toContain("B needs an address");
    expect(err([ok[0], { label: "B", baseUrl: "h:2", notes: "x".repeat(301) }])).toContain("notes");
    expect(err([ok[0], { label: "x".repeat(41), baseUrl: "h:2" }])).toContain("40 characters");
  });
});

describe("mergeLanes", () => {
  const existing: LaneConfig[] = [
    { label: "Studio", baseUrl: "http://a:1", model: "m1", displayModel: "Model One", apiKey: "k", slots: 4, extraBody: { x: 1 }, notes: "old" },
  ];

  test("a machine you keep keeps what the page does not edit", () => {
    const [l] = mergeLanes(existing, [{ label: "Studio", baseUrl: "http://a:1", notes: "new" }], ["m1"]);
    expect(l).toMatchObject({ model: "m1", displayModel: "Model One", apiKey: "k", slots: 4, extraBody: { x: 1 }, notes: "new" });
  });

  test("renamed but same address still counts as the same machine", () => {
    const [l] = mergeLanes(existing, [{ label: "Mac Studio", baseUrl: "http://a:1" }], ["m1"]);
    expect(l!.apiKey).toBe("k");
    expect(l!.notes).toBeUndefined(); // notes are what the page says, so clearing them clears them
  });

  test("a changed model loses the old short name; a new machine inherits nothing", () => {
    const [changed, fresh] = mergeLanes(existing, [{ label: "Studio", baseUrl: "http://a:1" }, { label: "New", baseUrl: "http://b:2" }], ["m2", "m3"]);
    expect(changed!.displayModel).toBeUndefined();
    expect(fresh).toEqual({ label: "New", baseUrl: "http://b:2", model: "m3" });
  });
});

describe("applyEdit", () => {
  test("asks every machine, writes the config, and returns it", async () => {
    const a = mock({ modelId: "/m/A-Q8_0.gguf" });
    const b = mock({ modelId: "bee" });
    const dir = await mkdtemp(join(tmpdir(), "editor-"));
    dirs.push(dir);
    const path = join(dir, "race.config.json");
    const result = await applyEdit({
      config: baseConfig([{ label: "Old1", baseUrl: "http://x:1", model: "m" }, { label: "Old2", baseUrl: "http://y:1", model: "m" }]),
      edited: [{ label: "Studio", baseUrl: url(a) }, { label: "Box", baseUrl: url(b), notes: "n" }],
      writePath: path,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.lanes.map((l) => [l.label, l.model])).toEqual([["Studio", "/m/A-Q8_0.gguf"], ["Box", "bee"]]);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.lanes[1].notes).toBe("n");
    expect(saved.password).toBe("pw"); // top-level settings survive
    expect(saved.maxTokens).toBe(256);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    validateConfig(saved);
  });

  test("one machine that does not answer means nothing is saved, and it is named", async () => {
    const a = mock();
    const b = mock();
    const dead = url(b);
    b.stop(true);
    const dir = await mkdtemp(join(tmpdir(), "editor-"));
    dirs.push(dir);
    const path = join(dir, "race.config.json");
    const result = await applyEdit({
      config: baseConfig([{ label: "O1", baseUrl: "http://x:1", model: "m" }, { label: "O2", baseUrl: "http://y:1", model: "m" }]),
      edited: [{ label: "Studio", baseUrl: url(a) }, { label: "Box", baseUrl: dead }],
      writePath: path,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("Box");
    expect(existsSync(path)).toBe(false);
  });
});

describe("checkMachine", () => {
  test("says what a llama-server-like machine is, with no folder in it", async () => {
    const s = mock({ slots: 2, contextTokens: 131072, modelPath: "/Users/me/models/Foo-Q8_0.gguf", build: "b9" });
    const c = await checkMachine(url(s));
    expect(c).toMatchObject({ ok: true, modelFile: "Foo-Q8_0.gguf", quant: "Q8_0", build: "b9", slots: 2, contextPerSlot: 131072 });
    expect(JSON.stringify(c)).not.toContain("/Users/");
  });

  test("a machine with no /props still answers with its model", async () => {
    const s = mock({ modelId: "/models/Bar-Q4_K_M.gguf" });
    const c = await checkMachine(url(s));
    expect(c).toMatchObject({ ok: true, modelFile: "Bar-Q4_K_M.gguf", slots: null });
  });

  test("a bad or dead address is a sentence, not a crash", async () => {
    expect((await checkMachine("")).ok).toBe(false);
    const s = mock();
    const dead = url(s);
    s.stop(true);
    const c = await checkMachine(dead);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain("could not be reached");
  });
});

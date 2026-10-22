import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.ts";
import { mergeLanes, parseEditedLanes } from "../src/editor.ts";
import { applySettings, extraBodyFor, parseSettings } from "../src/settings.ts";

const base = () =>
  validateConfig({ lanes: [{ label: "A", baseUrl: "http://a:1", model: "m" }, { label: "B", baseUrl: "http://b:1", model: "m" }] });

describe("reply length and thinking are asked for, and checked", () => {
  test("a good change is accepted, a bad one says why", () => {
    expect(parseSettings({ maxTokens: 4096, thinking: "off" })).toEqual({ ok: true, change: { maxTokens: 4096, thinking: "off" } });
    for (const bad of [{ maxTokens: 10 }, { maxTokens: 1.5 }, { maxTokens: "big" }, { maxTokens: 99999 }]) {
      const r = parseSettings(bad);
      expect(r.ok).toBe(false);
    }
    expect(parseSettings({ thinking: "maybe" }).ok).toBe(false);
    expect(parseSettings({}).ok).toBe(false);
  });

  test("thinking off sends the same switch to a machine, and a machine's own setting wins", () => {
    expect(extraBodyFor({}, "auto")).toBeUndefined();
    expect(extraBodyFor({}, undefined)).toBeUndefined();
    expect(extraBodyFor({}, "off")).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(extraBodyFor({ extraBody: { top_k: 5 } }, "off")).toEqual({ top_k: 5, chat_template_kwargs: { enable_thinking: false } });
    expect(extraBodyFor({ extraBody: { chat_template_kwargs: { enable_thinking: true, x: 1 } } }, "off")).toEqual({
      chat_template_kwargs: { enable_thinking: true, x: 1 },
    });
  });

  test("applying a change validates it, and writes it only when asked to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "settings-"));
    try {
      const path = join(dir, "race.config.json");
      const dry = await applySettings({ config: base(), change: { maxTokens: 2048, thinking: "off" } });
      expect(dry.ok && dry.config.maxTokens === 2048 && dry.config.thinking === "off").toBe(true);
      expect(await Bun.file(path).exists()).toBe(false);

      const wet = await applySettings({ config: base(), change: { maxTokens: 4096 }, writePath: path });
      expect(wet.ok).toBe(true);
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.maxTokens).toBe(4096);
      expect(saved.lanes).toHaveLength(2);
      // what was written loads back
      expect(validateConfig(saved).maxTokens).toBe(4096);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a config that says thinking is neither auto nor off is refused", () => {
    expect(() => validateConfig({ ...base(), thinking: "sometimes" })).toThrow("thinking");
  });
});

describe("streams at once, per machine", () => {
  const row = (extra: object) => ({ lanes: [{ label: "A", baseUrl: "h:1", ...extra }] });

  test("a number is kept, empty clears it, and nonsense says which machine", () => {
    const ok = (extra: object) => {
      const r = parseEditedLanes(row(extra));
      return r.ok ? r.lanes[0]!.slots : "refused";
    };
    expect(ok({ slots: 64 })).toBe(64);
    expect(ok({ slots: "8" })).toBe(8);
    expect(ok({ slots: null })).toBeNull();
    expect(ok({ slots: "" })).toBeNull();
    expect(ok({})).toBeUndefined();
    const bad = parseEditedLanes(row({ slots: 0 }));
    expect(bad.ok ? "" : bad.error).toContain("A's streams at once");
    expect(parseEditedLanes(row({ slots: "lots" })).ok).toBe(false);
  });

  test("saving sets it, clears it, or keeps what was saved", () => {
    const existing = [{ label: "A", baseUrl: "http://a:1", model: "m", slots: 16 }];
    const edit = (e: object) => mergeLanes(existing, [{ label: "A", baseUrl: "http://a:1", ...e }], ["m"])[0]!.slots;
    expect(edit({ slots: 32 })).toBe(32);
    expect(edit({ slots: null })).toBeUndefined();
    expect(edit({})).toBe(16);
  });
});

describe("a race really sends the setting", () => {
  test("thinking off puts the switch in every machine's request, and auto leaves it out", async () => {
    const { startMockLane } = await import("../src/mock.ts");
    const { runRace } = await import("../src/race.ts");
    const servers = [startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 5 }), startMockLane({ port: 0, firstWordDelayMs: 5, chunkIntervalMs: 1, chunks: 5 })];
    try {
      const run = async (thinking: "off" | "auto") => {
        const bodies: Record<string, unknown>[] = [];
        const fetchImpl = (async (input: string, init?: RequestInit) => {
          if (init?.method === "POST") bodies.push(JSON.parse(String(init.body)));
          return fetch(input, init);
        }) as never;
        const lanes = servers.map((s, i) => ({ label: `L${i}`, baseUrl: `http://localhost:${s.port}`, model: "mock-model" }));
        await runRace({
          config: { port: 0, maxTokens: 777, thinking, temperature: 0, charsPerToken: 4, promptFile: "p", requestTimeoutMs: 20_000, preflightTimeoutMs: 10_000, maxConcurrency: 16, lanes } as never,
          preset: "short", sourceText: "x", emit: () => {}, skipUsageProbe: true, tickMs: 20, fetchImpl,
          logPath: join(tmpdir(), `settings-${Date.now()}-${thinking}.jsonl`),
        });
        return bodies.filter((b) => b.stream === true);
      };
      const off = await run("off");
      expect(off).toHaveLength(2);
      for (const b of off) {
        expect(b.chat_template_kwargs).toEqual({ enable_thinking: false });
        expect(b.max_tokens).toBe(777);
      }
      const auto = await run("auto");
      for (const b of auto) expect(b.chat_template_kwargs).toBeUndefined();
    } finally {
      for (const s of servers) s.stop(true);
    }
  });
});

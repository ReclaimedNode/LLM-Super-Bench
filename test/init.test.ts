import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { buildConfig, parseLaneArg, readModelId } from "../src/init.ts";
import { validateConfig } from "../src/config.ts";
import { startMockLane } from "../src/mock.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
const mock = (modelId: string) => {
  const s = startMockLane({ port: 0, firstWordDelayMs: 1, chunkIntervalMs: 1, chunks: 3, modelId });
  servers.push(s);
  return s;
};

describe("parseLaneArg", () => {
  test("label and address, with the tidy-ups people need", () => {
    expect(parseLaneArg("Mac Studio=http://192.168.1.50:8000")).toEqual({ label: "Mac Studio", baseUrl: "http://192.168.1.50:8000" });
    expect(parseLaneArg("Box=http://h:8000/v1/")).toEqual({ label: "Box", baseUrl: "http://h:8000" });
    expect(parseLaneArg("Box=h:8000")).toEqual({ label: "Box", baseUrl: "http://h:8000" });
  });
  test("a bad one says what is wrong", () => {
    expect(typeof parseLaneArg("nothing")).toBe("string");
    expect(typeof parseLaneArg("=http://x")).toBe("string");
  });
});

describe("buildConfig", () => {
  test("asks each machine for its exact model id and writes a config the server accepts", async () => {
    const a = mock("/models/Foo-Q8_0.gguf");
    const b = mock("bar-alias");
    const built = await buildConfig([
      { label: "Studio", baseUrl: `http://localhost:${a.port}`, notes: "spec on" },
      { label: "Box", baseUrl: `http://localhost:${b.port}` },
    ]);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const cfg = validateConfig(built.config);
    expect(cfg.lanes.map((l) => l.model)).toEqual(["/models/Foo-Q8_0.gguf", "bar-alias"]);
    expect(cfg.lanes[0]!.notes).toBe("spec on");
    expect(cfg.lanes[1]!.notes).toBeUndefined();
  });

  test("a machine that cannot be reached stops it, by name, and nothing is written", async () => {
    const a = mock("m");
    const b = mock("m");
    const dead = `http://localhost:${b.port}`;
    b.stop(true);
    const built = await buildConfig([
      { label: "Studio", baseUrl: `http://localhost:${a.port}` },
      { label: "Box", baseUrl: dead },
    ]);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.problems[0]).toContain("Box");
  });

  test("a server that lists no model is reported", async () => {
    const empty = (async () => new Response(JSON.stringify({ data: [] }))) as unknown as typeof fetch;
    expect(await readModelId("http://x", empty)).toEqual({ error: "lists no model at /v1/models" });
  });
});

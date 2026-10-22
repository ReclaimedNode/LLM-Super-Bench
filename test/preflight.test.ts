import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { startMockLane } from "../src/mock.ts";
import { extractModelIds, preflightLane } from "../src/preflight.ts";
import type { LaneConfig } from "../src/types.ts";

const servers: Server[] = [];

function mock(over: Partial<Parameters<typeof startMockLane>[0]> = {}): Server {
  const server = startMockLane({
    port: 0,
    firstWordDelayMs: 5,
    chunkIntervalMs: 1,
    chunks: 3,
    includeUsage: false,
    ...over,
  });
  servers.push(server);
  return server;
}

function lane(server: Server, over: Partial<LaneConfig> = {}): LaneConfig {
  return {
    label: "Lane A",
    baseUrl: `http://localhost:${server.port}`,
    model: "mock-model",
    displayModel: "mock-model",
    ...over,
  };
}

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

describe("extractModelIds", () => {
  test("reads the ids out of an OpenAI-shaped model list", () => {
    expect(extractModelIds({ object: "list", data: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  test("survives junk", () => {
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds({ data: "nope" })).toEqual([]);
    expect(extractModelIds({ data: [{ nope: 1 }, { id: "a" }] })).toEqual(["a"]);
  });
});

describe("preflightLane", () => {
  test("passes a lane whose configured model the endpoint actually lists", async () => {
    const result = await preflightLane({ lane: lane(mock()), timeoutMs: 5000, skipUsageProbe: true });
    expect(result.ok).toBe(true);
    expect(result.availableModels).toEqual(["mock-model"]);
  });

  test("refuses a lane whose model the endpoint does not list, and names what it does have", async () => {
    const result = await preflightLane({
      lane: lane(mock(), { model: "made-up-model" }),
      timeoutMs: 5000,
      skipUsageProbe: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("does not have the configured model");
    expect(result.message).toContain("mock-model");
  });

  test("refuses a lane that is not answering at all", async () => {
    const dead = mock();
    const url = `http://localhost:${dead.port}`;
    dead.stop(true);
    servers.pop();
    const result = await preflightLane({
      lane: { label: "Lane A", baseUrl: url, model: "mock-model" },
      timeoutMs: 3000,
      skipUsageProbe: true,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Cannot reach Lane A");
  });

  // Requirement 5: find out whether the endpoint honours include_usage, rather
  // than assuming either way.
  test("detects an endpoint that DOES return usage when asked", async () => {
    const result = await preflightLane({ lane: lane(mock({ includeUsage: true })), timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.usageSupported).toBe(true);
    expect(result.message).toContain("reports token usage");
  });

  test("detects an endpoint that does NOT return usage, and says speed will be chunks", async () => {
    const result = await preflightLane({ lane: lane(mock({ includeUsage: false })), timeoutMs: 5000 });
    expect(result.ok).toBe(true);
    expect(result.usageSupported).toBe(false);
    expect(result.message).toContain("counted in chunks");
  });
});

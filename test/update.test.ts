import { describe, expect, test } from "bun:test";
import { makeUpdateChecker, readCompare } from "../src/update.ts";

const SHA = "a".repeat(40);
const reply = (o: unknown, status = 200) => (async () => new Response(JSON.stringify(o), { status })) as never;

describe("reading GitHub's compare answer", () => {
  test("main ahead of you is an update; level or behind is not", () => {
    expect(readCompare({ status: "ahead", ahead_by: 3 })).toEqual({ available: true, behind: 3 });
    expect(readCompare({ status: "diverged", ahead_by: 1 })).toEqual({ available: true, behind: 1 });
    expect(readCompare({ status: "identical", ahead_by: 0 }).available).toBe(false);
    expect(readCompare({ status: "behind", ahead_by: 0 }).available).toBe(false);
  });
  test("rubbish says nothing", () => {
    for (const bad of [null, 5, "x", {}, { status: "ahead", ahead_by: "9" }, { status: "ahead", ahead_by: -2 }, { status: "ahead", ahead_by: 1.5 }])
      expect(readCompare(bad).available).toBe(false);
  });
});

describe("the checker", () => {
  const base = { localCommit: async () => SHA, now: () => 1_000_000, env: {} };
  test("reports an update, and asks only the public compare address", async () => {
    let asked = "";
    const c = makeUpdateChecker({ ...base, fetchImpl: (async (u: string) => { asked = u; return new Response(JSON.stringify({ status: "ahead", ahead_by: 2 })); }) as never });
    const s = await c.status();
    expect(s).toMatchObject({ enabled: true, available: true, behind: 2 });
    expect(asked).toBe(`https://api.github.com/repos/reclaimednode/LLM-Super-Bench/compare/${SHA}...main`);
  });
  test("asks once a day, not on every page load", async () => {
    let calls = 0, t = 0;
    const c = makeUpdateChecker({ ...base, now: () => t, fetchImpl: (async () => { calls++; return new Response("{}"); }) as never });
    await Promise.all([c.status(), c.status(), c.status()]);
    await c.status();
    expect(calls).toBe(1);
    t = 25 * 60 * 60 * 1000;
    await c.status();
    expect(calls).toBe(2);
  });
  test("switched off: no request at all", async () => {
    let calls = 0;
    const c = makeUpdateChecker({ ...base, env: { LLM_SUPER_BENCH_NO_UPDATE_CHECK: "1" }, fetchImpl: (async () => { calls++; return new Response("{}"); }) as never });
    expect((await c.status()).enabled).toBe(false);
    expect(calls).toBe(0);
  });
  test("not a git clone, an unpushed commit, no internet, rate limit: all silent", async () => {
    let calls = 0;
    const none = makeUpdateChecker({ ...base, localCommit: async () => null, fetchImpl: (async () => { calls++; return new Response("{}"); }) as never });
    expect((await none.status()).available).toBe(false);
    expect(calls).toBe(0);
    for (const f of [reply({ message: "Not Found" }, 404), reply({}, 403), (async () => { throw new Error("offline"); }) as never]) {
      expect((await makeUpdateChecker({ ...base, fetchImpl: f }).status()).available).toBe(false);
    }
  });
});

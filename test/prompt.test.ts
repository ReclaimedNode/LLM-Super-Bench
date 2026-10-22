import { describe, expect, test } from "bun:test";
import { PRESETS, buildPrompt, makeRunId, targetCharsFor, trimToChars } from "../src/prompt.ts";

const LOREM = "the quick brown fox jumps over the lazy dog. ".repeat(200); // 9000 chars

describe("targetCharsFor", () => {
  test("sizes the presets from tokens using the configured ratio", () => {
    expect(targetCharsFor("short", 4)).toBe(0);
    expect(targetCharsFor("8k", 4)).toBe(8192 * 4);
    expect(targetCharsFor("32k", 4)).toBe(32768 * 4);
    expect(targetCharsFor("8k", 3)).toBe(8192 * 3);
  });
});

describe("trimToChars", () => {
  test("trims a long source down to the target", () => {
    const out = trimToChars(LOREM, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.length).toBeGreaterThan(300);
  });

  test("does not cut in the middle of a word", () => {
    const out = trimToChars(LOREM, 500);
    expect(out.endsWith(" ")).toBe(false);
    // The character after the cut in the source is whitespace, so no word was split.
    expect(/\s/.test(LOREM[out.length] ?? " ")).toBe(true);
  });

  test("tiles a short source until it reaches the target", () => {
    const out = trimToChars("short text", 1000);
    expect(out.length).toBeGreaterThan(800);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.includes("short text\n\nshort text")).toBe(true);
  });

  test("a zero target produces nothing", () => {
    expect(trimToChars(LOREM, 0)).toBe("");
  });

  test("an empty source is an error the user can act on", () => {
    expect(() => trimToChars("   \n  ", 100)).toThrow(/empty/i);
  });
});

describe("makeRunId", () => {
  test("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => makeRunId()));
    expect(ids.size).toBe(500);
  });
});

describe("buildPrompt", () => {
  test("puts the unique run-id on the very first line, so no prefix cache can help", () => {
    const built = buildPrompt({ preset: "8k", sourceText: LOREM, charsPerToken: 4, runId: "RUNID-123" });
    expect(built.text.startsWith("[race-run RUNID-123]")).toBe(true);
    expect(built.text.split("\n")[0]).toBe("[race-run RUNID-123]");
    expect(built.runIdLine).toBe("[race-run RUNID-123]");
  });

  test("two runs of the same preset differ inside the first line, not at the tail", () => {
    const a = buildPrompt({ preset: "8k", sourceText: LOREM, charsPerToken: 4, runId: makeRunId() });
    const b = buildPrompt({ preset: "8k", sourceText: LOREM, charsPerToken: 4, runId: makeRunId() });
    expect(a.text).not.toBe(b.text);
    // The difference is in line 1. A prompt cache matching on a shared prefix
    // therefore has nothing to match beyond the opening bracket.
    expect(a.text.split("\n")[0]).not.toBe(b.text.split("\n")[0]);
    expect(a.text.slice(a.text.indexOf("\n"))).toBe(b.text.slice(b.text.indexOf("\n")));
  });

  test("carries the instruction and the trimmed source, and reports its own size", () => {
    const built = buildPrompt({ preset: "8k", sourceText: LOREM, charsPerToken: 4, runId: "r1" });
    expect(built.text).toContain(PRESETS["8k"].instruction);
    expect(built.targetChars).toBe(32768);
    expect(built.chars).toBe(built.text.length);
    // Run-id line + instruction + separators sit on top of the trimmed body.
    expect(built.chars).toBeGreaterThan(32768);
    expect(built.chars).toBeLessThan(32768 + 400);
  });

  test("the short preset carries no source text", () => {
    const built = buildPrompt({ preset: "short", sourceText: LOREM, charsPerToken: 4, runId: "r1" });
    expect(built.targetChars).toBe(0);
    expect(built.text).toBe(`[race-run r1]\n\n${PRESETS.short.instruction}`);
    expect(built.text).not.toContain("quick brown fox");
  });

  test("the 32K preset is four times the 8K preset's source", () => {
    const eight = buildPrompt({ preset: "8k", sourceText: LOREM, charsPerToken: 4, runId: "r1" });
    const thirtyTwo = buildPrompt({ preset: "32k", sourceText: LOREM, charsPerToken: 4, runId: "r1" });
    expect(thirtyTwo.targetChars).toBe(eight.targetChars * 4);
    expect(thirtyTwo.chars).toBeGreaterThan(eight.chars * 3.9);
  });
});

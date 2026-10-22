import { describe, expect, test } from "bun:test";
import {
  buildBenchPrompt,
  charsPerTokenFromProbe,
  correctedCharsPerToken,
  makeBenchRunId,
  withinTolerance,
} from "../../src/bench/prompt.ts";

const SOURCE = "the quick brown fox jumps over the lazy dog. ".repeat(4000);

describe("building a benchmark prompt", () => {
  test("the run id is the FIRST line, which is what breaks a prefix cache", () => {
    const p = buildBenchPrompt({ runId: "abc123", targetTokens: 512, charsPerToken: 4, sourceText: SOURCE });
    expect(p.text.split("\n")[0]).toBe("[bench-run abc123]");
  });

  test("two runs never share a prompt", () => {
    const a = buildBenchPrompt({ runId: makeBenchRunId(1), targetTokens: 512, charsPerToken: 4, sourceText: SOURCE });
    const b = buildBenchPrompt({ runId: makeBenchRunId(2), targetTokens: 512, charsPerToken: 4, sourceText: SOURCE });
    expect(a.text).not.toBe(b.text);
  });

  test("run ids are unique across a burst of them", () => {
    const ids = new Set(Array.from({ length: 200 }, (_, i) => makeBenchRunId(i)));
    expect(ids.size).toBe(200);
  });

  test("the prompt lands on the target character count, scaffolding included", () => {
    for (const target of [512, 4096, 16384]) {
      const p = buildBenchPrompt({ runId: "x", targetTokens: target, charsPerToken: 4, sourceText: SOURCE });
      // Within the trim's whitespace-boundary slack, not a character more.
      expect(p.chars).toBeLessThanOrEqual(target * 4);
      expect(p.chars).toBeGreaterThan(target * 4 - 220);
    }
  });

  test("the instruction asks for a long answer, so the model runs to the cap", () => {
    const p = buildBenchPrompt({ runId: "x", targetTokens: 512, charsPerToken: 4, sourceText: SOURCE });
    expect(p.text).toContain("until you are cut off");
    expect(p.text.toLowerCase()).toContain("do not stop early");
  });

  test("a short source is tiled rather than falling short of the target", () => {
    const p = buildBenchPrompt({ runId: "x", targetTokens: 4096, charsPerToken: 4, sourceText: "tiny seed text." });
    expect(p.chars).toBeGreaterThan(4096 * 4 - 220);
  });
});

describe("measuring characters per token", () => {
  test("is the probe's characters over the tokens the server actually counted", () => {
    expect(charsPerTokenFromProbe(2048, 512)).toBe(4);
    expect(charsPerTokenFromProbe(2048, 640)).toBe(3.2);
  });

  test("a probe that produced no count produces no ratio, not a guess", () => {
    expect(charsPerTokenFromProbe(2048, 0)).toBeNull();
    expect(charsPerTokenFromProbe(0, 512)).toBeNull();
  });

  test("scaling from the probe puts a 4K cell within 5% of 4K", () => {
    // A tokenizer that truly makes a token out of every 3.5 characters, with a
    // 20-token chat-template overhead the probe cannot see separately.
    const trueCpt = 3.5;
    const overhead = 20;
    const probeChars = 512 * 4;
    const probeTokens = overhead + probeChars / trueCpt;
    const measured = charsPerTokenFromProbe(probeChars, probeTokens)!;

    for (const target of [512, 4096, 16384, 32768, 100000]) {
      const chars = target * measured;
      const actual = overhead + chars / trueCpt;
      expect(withinTolerance(target, actual)).toBe(true);
    }
  });
});

describe("correcting the size from the discarded warm-up", () => {
  test("rescales when the warm-up landed outside the tolerance", () => {
    // Wanted 4096, got 3600: the measured runs need a longer prompt.
    const corrected = correctedCharsPerToken({ charsPerToken: 4, targetTokens: 4096, actualTokens: 3600 })!;
    expect(corrected).toBeCloseTo(4 * (4096 / 3600), 9);
    expect(corrected).toBeGreaterThan(4);
  });

  test("leaves a prompt alone when it is already close enough", () => {
    expect(correctedCharsPerToken({ charsPerToken: 4, targetTokens: 4096, actualTokens: 4090 })).toBeNull();
    expect(correctedCharsPerToken({ charsPerToken: 4, targetTokens: 4096, actualTokens: 4300 })).toBeNull();
  });

  test("one correction is enough to land inside the tolerance", () => {
    const trueCpt = 3.5;
    const overhead = 20;
    const target = 32768;
    let cpt = 4; // a bad starting guess

    const tokensFor = (c: number) => overhead + (target * c) / trueCpt;
    const first = tokensFor(cpt);
    expect(withinTolerance(target, first)).toBe(false);

    cpt = correctedCharsPerToken({ charsPerToken: cpt, targetTokens: target, actualTokens: first })!;
    expect(withinTolerance(target, tokensFor(cpt))).toBe(true);
  });

  test("nonsense in gives nothing out, rather than a nonsense scale", () => {
    expect(correctedCharsPerToken({ charsPerToken: 4, targetTokens: 4096, actualTokens: 0 })).toBeNull();
    expect(correctedCharsPerToken({ charsPerToken: 0, targetTokens: 4096, actualTokens: 4096 })).toBeNull();
  });
});

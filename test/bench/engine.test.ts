/**
 * The engine-benchmark parser, tested against output captured from the real
 * tool rather than against a guess at its format.
 *
 * test/fixtures/mlx_lm.benchmark-512-128-2.txt is verbatim stdout from
 * `mlx_lm.benchmark --model <a real model> -p 512 -g 128 -n 2` on the machine
 * (mlx_lm 0.31.3). Nothing about it is invented, including the two spaces after
 * "Trial 1:" that a hand-written fixture would have got wrong.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEngineBenchmark, summariseEngineSample } from "../../src/bench/engine.ts";

const REAL = readFileSync(resolve(import.meta.dir, "../fixtures/mlx_lm.benchmark-512-128-2.txt"), "utf8");

describe("parsing real output from the tool", () => {
  test("reads the header, both trials and the tool's own averages", () => {
    const sample = parseEngineBenchmark(REAL)!;
    expect(sample.promptTokens).toBe(512);
    expect(sample.generationTokens).toBe(128);
    expect(sample.batchSize).toBe(1);
    expect(sample.trials).toHaveLength(2);

    expect(sample.trials[0]).toEqual({
      promptTps: 790.213,
      generationTps: 69.324,
      peakMemory: 8.824,
      totalTime: 2.558,
    });
    expect(sample.trials[1]).toEqual({
      promptTps: 791.234,
      generationTps: 69.354,
      peakMemory: 8.825,
      totalTime: 2.56,
    });

    expect(sample.toolAverages).toEqual({ promptTps: 790.723, generationTps: 69.339, peakMemory: 8.825 });
  });

  test("the warm-up line is not mistaken for a trial", () => {
    expect(parseEngineBenchmark(REAL)!.trials).toHaveLength(2);
  });

  test("our median comes from the trials, not from the tool's mean line", () => {
    const summary = summariseEngineSample(parseEngineBenchmark(REAL)!);
    // Two trials: the median is the midpoint, and here it happens to match the
    // tool's mean. What matters is that it was computed from the trials, so a
    // third slow trial would move one and not the other.
    expect(summary.promptTps!.median).toBeCloseTo((790.213 + 791.234) / 2, 6);
    expect(summary.promptTps!.low).toBe(790.213);
    expect(summary.promptTps!.high).toBe(791.234);
    expect(summary.generationTps!.median).toBeCloseTo((69.324 + 69.354) / 2, 6);
    expect(summary.trials).toBe(2);
  });

  test("peak memory is the highest trial, not an average of them", () => {
    // The number that matters is the most the machine ever needed. Averaging
    // it reports a figure the run never actually used.
    const summary = summariseEngineSample(parseEngineBenchmark(REAL)!);
    expect(summary.peakMemoryGb).toBe(8.825);
  });

  test("a third, slower trial moves our median away from the tool's mean", () => {
    const withOutlier = REAL.replace(
      "Averages:",
      "Trial 3:  prompt_tps=300.000, generation_tps=20.000, peak_memory=9.900, total_time=8.000\nAverages:",
    );
    const summary = summariseEngineSample(parseEngineBenchmark(withOutlier)!);
    expect(summary.trials).toBe(3);
    // Median of 790.213 / 791.234 / 300 is 790.213; the mean would be ~627.
    expect(summary.promptTps!.median).toBe(790.213);
    expect(summary.promptTps!.low).toBe(300);
    expect(summary.promptTps!.high).toBe(791.234);
    expect(summary.peakMemoryGb).toBe(9.9);
  });
});

describe("output the parser should refuse", () => {
  test("an empty run gives nothing, rather than zeroes", () => {
    expect(parseEngineBenchmark("")).toBeNull();
    expect(parseEngineBenchmark("bash: mlx_lm.benchmark: command not found")).toBeNull();
  });

  test("a python traceback gives nothing", () => {
    const traceback = [
      "Traceback (most recent call last):",
      '  File "/x/bin/mlx_lm.benchmark", line 8, in <module>',
      "ValueError: model not found",
    ].join("\n");
    expect(parseEngineBenchmark(traceback)).toBeNull();
  });

  test("a header with no trials still parses, and summarises to no numbers", () => {
    // The run started and died. That is worth recording as "it ran and gave
    // nothing", which is different from "we never ran it".
    const sample = parseEngineBenchmark("Timing with prompt_tokens=512, generation_tokens=128, batch_size=1.")!;
    expect(sample.promptTokens).toBe(512);
    expect(sample.trials).toEqual([]);
    const summary = summariseEngineSample(sample);
    expect(summary.promptTps).toBeNull();
    expect(summary.peakMemoryGb).toBeNull();
  });

  test("a trial line missing its speeds is skipped rather than read as zero", () => {
    const sample = parseEngineBenchmark(
      "Timing with prompt_tokens=512, generation_tokens=128, batch_size=1.\nTrial 1:  peak_memory=8.8\n",
    )!;
    expect(sample.trials).toEqual([]);
  });

  test("progress noise around the numbers does not break it", () => {
    const noisy = `Fetching 9 files: 100%|##########| 9/9 [00:00<00:00, 1234.5it/s]\n${REAL}\nDone.`;
    expect(parseEngineBenchmark(noisy)!.trials).toHaveLength(2);
  });
});

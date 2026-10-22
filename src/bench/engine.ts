/**
 * The engine's own benchmark, as a second opinion on the API numbers.
 *
 * `mlx_lm.benchmark` measures the same machine without an HTTP server, a chat
 * template or a network in the way, and it reports peak memory, which nothing
 * on the API side can see. It also prints only a MEAN, so this module keeps
 * the per-trial lines and computes our own median, lowest and highest from
 * them -- the same statistic the API side reports, so the two can sit next to
 * each other honestly.
 *
 * The parser was written against this real output, captured from the machine
 * (mlx_lm 0.31.3), not against a guess at the format:
 *
 *   Running warmup..
 *   Timing with prompt_tokens=512, generation_tokens=128, batch_size=1.
 *   Trial 1:  prompt_tps=790.213, generation_tps=69.324, peak_memory=8.824, total_time=2.558
 *   Trial 2:  prompt_tps=791.234, generation_tps=69.354, peak_memory=8.825, total_time=2.560
 *   Averages: prompt_tps=790.723, generation_tps=69.339, peak_memory=8.825
 */

import { stat3 } from "./stats.ts";
import type { EngineCell, EngineSample, EngineTrial, SshTarget } from "./types.ts";
import { engineBenchmarkCommand, runRemote } from "./ssh.ts";

/** Pulls `key=value` pairs out of one line. */
function pairs(line: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of line.matchAll(/([a-z_]+)\s*=\s*(-?\d+(?:\.\d+)?)/gi)) {
    const value = Number(match[2]);
    if (Number.isFinite(value)) out.set(match[1]!.toLowerCase(), value);
  }
  return out;
}

/**
 * Parses the tool's output. Returns null when nothing recognisable is in it,
 * which is the signal to record "not available" and carry on rather than to
 * invent a number.
 */
export function parseEngineBenchmark(text: string): EngineSample | null {
  const trials: EngineTrial[] = [];
  let header: Map<string, number> | null = null;
  let averages: EngineSample["toolAverages"] = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    if (/^Timing with\b/i.test(line)) {
      header = pairs(line);
      continue;
    }
    if (/^Trial\s+\d+\s*:/i.test(line)) {
      const p = pairs(line.replace(/^Trial\s+\d+\s*:/i, ""));
      const promptTps = p.get("prompt_tps");
      const generationTps = p.get("generation_tps");
      if (promptTps === undefined || generationTps === undefined) continue;
      trials.push({
        promptTps,
        generationTps,
        peakMemory: p.get("peak_memory") ?? Number.NaN,
        totalTime: p.get("total_time") ?? Number.NaN,
      });
      continue;
    }
    if (/^Averages\s*:/i.test(line)) {
      const p = pairs(line);
      averages = {
        promptTps: p.get("prompt_tps") ?? null,
        generationTps: p.get("generation_tps") ?? null,
        peakMemory: p.get("peak_memory") ?? null,
      };
    }
  }

  if (trials.length === 0 && header === null) return null;

  return {
    promptTokens: header?.get("prompt_tokens") ?? null,
    generationTokens: header?.get("generation_tokens") ?? null,
    batchSize: header?.get("batch_size") ?? null,
    trials,
    toolAverages: averages,
  };
}

/**
 * Our median/low/high over the tool's trials, plus the peak memory it saw.
 *
 * Peak memory is the highest of the trials, not their average: the number that
 * matters is the most the machine ever needed, and averaging it away would
 * report a figure the run never actually used.
 */
export function summariseEngineSample(sample: EngineSample): {
  promptTps: EngineCell["promptTps"];
  generationTps: EngineCell["generationTps"];
  peakMemoryGb: number | null;
  trials: number;
} {
  const peaks = sample.trials.map((t) => t.peakMemory).filter((v) => Number.isFinite(v));
  return {
    promptTps: stat3(sample.trials.map((t) => t.promptTps)),
    generationTps: stat3(sample.trials.map((t) => t.generationTps)),
    peakMemoryGb: peaks.length > 0 ? Math.max(...peaks) : null,
    trials: sample.trials.length,
  };
}

export interface EngineRunOptions {
  laneLabel: string;
  target: SshTarget;
  modelId: string;
  nominalLabel: string;
  nominalTokens: number;
  generationTokens: number;
  trials: number;
  timeoutMs?: number;
}

/**
 * Runs the engine's benchmark on the machine and summarises it.
 *
 * A missing command, a non-zero exit or unparseable output all end the same
 * way: "not available", with the reason kept, and the grid carries on. The
 * engine number is a second opinion, never a gate.
 */
export async function runEngineBenchmark(opts: EngineRunOptions): Promise<EngineCell> {
  const base: EngineCell = {
    laneLabel: opts.laneLabel,
    modelId: opts.modelId,
    nominalLabel: opts.nominalLabel,
    nominalTokens: opts.nominalTokens,
    generationTokens: opts.generationTokens,
    promptTps: null,
    generationTps: null,
    peakMemoryGb: null,
    trials: 0,
    unavailable: null,
    raw: null,
  };

  let result;
  try {
    result = await runRemote(
      opts.target,
      engineBenchmarkCommand({
        target: opts.target,
        modelId: opts.modelId,
        promptTokens: opts.nominalTokens,
        generationTokens: opts.generationTokens,
        trials: opts.trials,
      }),
      { timeoutMs: opts.timeoutMs ?? 1_800_000 },
    );
  } catch (err) {
    return { ...base, unavailable: `could not run it: ${err instanceof Error ? err.message : String(err)}` };
  }

  const text = `${result.stdout}\n${result.stderr}`.trim();
  const sample = parseEngineBenchmark(text);
  if (sample === null || sample.trials.length === 0) {
    const detail = result.ok ? "its output did not parse" : `it exited ${result.code}`;
    return { ...base, unavailable: `${detail}`, raw: text.slice(0, 2000) || null };
  }

  return { ...base, ...summariseEngineSample(sample), raw: text.slice(0, 2000) };
}

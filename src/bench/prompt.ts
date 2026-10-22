/**
 * Sizing a benchmark prompt, and making sure no two of them are alike.
 *
 * The nominal size (512, 4K, 32K) is the cell's LABEL. The number a speed is
 * divided by is the true prompt token count the server reports, which is why
 * hitting the target exactly does not matter and hitting it roughly does: a
 * cell called "4K" should hold about four thousand tokens or the label lies.
 *
 * Getting there by binary search would mean sending a 100,000-token prompt
 * several times to find the right length, at minutes per request. Instead:
 * one small probe per model measures how many characters that model's
 * tokenizer makes a token out of, and every length is scaled from it. The
 * discarded warm-up then corrects the scale for free.
 */

import { trimToChars } from "../prompt.ts";

/** How far off a target a prompt may land before it is worth correcting. */
export const TOLERANCE = 0.05;

export interface SizedPrompt {
  text: string;
  chars: number;
  targetTokens: number;
  runId: string;
}

/**
 * The instruction. It has to make the model run to the cap, so it asks for
 * length in plain words; max_tokens then stops it. A model that answers "OK"
 * in four tokens measures nothing.
 */
export const LONG_ANSWER_INSTRUCTION =
  "Write a long, detailed, continuous explanation of how a computer runs a large language model. " +
  "Keep writing until you are cut off. Do not stop early, do not summarise, and do not use lists.";

export const SUMMARISE_INSTRUCTION =
  "Read the text below. Then write a long, detailed, continuous summary of it, and keep writing until you are cut off. " +
  "Do not stop early and do not use lists.";

/** A run id unique to this run, readable on camera. */
export function makeBenchRunId(index: number, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${index}-${rand}`;
}

/**
 * Builds the prompt for one run.
 *
 * The run id is the FIRST line, always. A prompt cache matches on prefixes, so
 * a unique first line means there is nothing for it to match, and the run
 * measures the machine rather than the cache. Every run's cached_tokens is
 * logged as well, because a rule you do not check is a hope.
 */
export function buildBenchPrompt(opts: {
  runId: string;
  targetTokens: number;
  charsPerToken: number;
  sourceText: string;
}): SizedPrompt {
  const runIdLine = `[bench-run ${opts.runId}]`;
  const instruction = opts.targetTokens <= 64 ? LONG_ANSWER_INSTRUCTION : SUMMARISE_INSTRUCTION;
  const scaffold = `${runIdLine}\n\n${instruction}\n\n`;

  const bodyChars = Math.max(0, Math.round(opts.targetTokens * opts.charsPerToken) - scaffold.length);
  const body = bodyChars > 0 ? trimToChars(opts.sourceText, bodyChars) : "";
  const text = body ? scaffold + body : `${runIdLine}\n\n${LONG_ANSWER_INSTRUCTION}`;

  return { text, chars: text.length, targetTokens: opts.targetTokens, runId: opts.runId };
}

/**
 * Characters per token, from one probe.
 *
 * The probe is sized near the SMALLEST target on purpose. The server's count
 * includes the chat template's own tokens, which are a fixed overhead this
 * ratio silently folds in; folding a fixed cost into a ratio is exact at the
 * size it was measured and drifts as you move away from it. Measuring at the
 * small end means the small cells -- where a fixed overhead is proportionally
 * largest, and so most damaging -- are the accurate ones, and the big cells
 * land a few percent under, which the warm-up correction then fixes.
 */
export function charsPerTokenFromProbe(promptChars: number, truePromptTokens: number): number | null {
  if (!(promptChars > 0) || !(truePromptTokens > 0)) return null;
  return promptChars / truePromptTokens;
}

/**
 * Corrects the scale from a run we already paid for.
 *
 * The warm-up is discarded by definition, so its true prompt token count is
 * free evidence: if the warm-up landed at 3,600 tokens when the cell wanted
 * 4,096, the measured runs get a prompt scaled by 4096/3600. Returns null when
 * the size is already within tolerance, so a prompt is not rebuilt for nothing.
 */
export function correctedCharsPerToken(opts: {
  charsPerToken: number;
  targetTokens: number;
  actualTokens: number;
}): number | null {
  const { charsPerToken, targetTokens, actualTokens } = opts;
  if (!(actualTokens > 0) || !(targetTokens > 0) || !(charsPerToken > 0)) return null;
  const error = Math.abs(actualTokens - targetTokens) / targetTokens;
  if (error <= TOLERANCE) return null;
  return charsPerToken * (targetTokens / actualTokens);
}

/** Is a true count close enough to the label for the label to be honest? */
export function withinTolerance(targetTokens: number, actualTokens: number, tolerance = TOLERANCE): boolean {
  if (!(targetTokens > 0)) return false;
  return Math.abs(actualTokens - targetTokens) / targetTokens <= tolerance;
}

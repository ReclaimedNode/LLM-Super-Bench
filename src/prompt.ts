/**
 * Prompt building.
 *
 * Two jobs: size the prompt to a preset, and make every run unique so no
 * server-side prompt cache can hand one lane a head start. The unique run-id
 * is the FIRST line, which breaks prefix caching immediately.
 */

import type { PresetId } from "./types.ts";

export interface PresetSpec {
  id: PresetId;
  /** What the button says. */
  label: string;
  /** Approximate context size the preset aims at. 0 means "no source text". */
  targetTokens: number;
  instruction: string;
}

const SUMMARISE = "Read the text below. Write one paragraph summarising what it says.";

/** A preset that reads `tokens` tokens of source text. The label is how the page names the size. */
function sized(id: PresetId, label: string, tokens: number): PresetSpec {
  return { id, label, targetTokens: tokens, instruction: SUMMARISE };
}

export const PRESETS: Record<PresetId, PresetSpec> = {
  short: {
    id: "short",
    label: "Short",
    targetTokens: 0,
    instruction: "In three sentences, explain what a GPU does, to a curious teenager.",
  },
  "4k": sized("4k", "4K", 4096),
  "8k": sized("8k", "8K", 8192),
  "16k": sized("16k", "16K", 16384),
  "32k": sized("32k", "32K", 32768),
  "64k": sized("64k", "64K", 65536),
  "128k": sized("128k", "128K", 131072),
};

/** In the order the buttons appear, smallest first. */
export const PRESET_IDS: PresetId[] = ["short", "4k", "8k", "16k", "32k", "64k", "128k"];

export function isPresetId(value: string): value is PresetId {
  return (PRESET_IDS as string[]).includes(value);
}

/**
 * How many characters a preset asks for. The token target is approximate by
 * definition, so the UI shows the character count too and calls the token
 * figure approximate.
 */
export function targetCharsFor(preset: PresetId, charsPerToken: number): number {
  return PRESETS[preset].targetTokens * charsPerToken;
}

/**
 * Cut `source` down to `targetChars`, preferring a whitespace boundary so the
 * prompt does not end mid-word. If the source is shorter than the target it is
 * tiled (repeated with a blank line between copies) until it is long enough.
 */
export function trimToChars(source: string, targetChars: number): string {
  if (targetChars <= 0) return "";
  const clean = source.trim();
  if (clean.length === 0) {
    throw new Error("Prompt source file is empty. Drop a text file into prompts/ and point race.config.json at it.");
  }

  let text = clean;
  if (text.length < targetChars) {
    const separator = "\n\n";
    const copies = Math.ceil((targetChars + separator.length) / (clean.length + separator.length));
    text = Array.from({ length: copies }, () => clean).join(separator);
  }

  if (text.length <= targetChars) return text;

  const cut = text.slice(0, targetChars);
  // Back off to the last whitespace, but never lose more than 200 characters
  // doing it -- the size of the prompt is the point of the preset.
  const lastSpace = cut.search(/\s+\S*$/);
  if (lastSpace > targetChars - 200) return cut.slice(0, lastSpace);
  return cut;
}

export interface BuiltPrompt {
  text: string;
  chars: number;
  targetChars: number;
  runIdLine: string;
}

/** A run id that is unique per race and readable on camera. */
export function makeRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 10);
  return `${stamp}-${rand}`;
}

export function buildPrompt(opts: {
  preset: PresetId;
  sourceText: string;
  charsPerToken: number;
  runId: string;
}): BuiltPrompt {
  const spec = PRESETS[opts.preset];
  const targetChars = targetCharsFor(opts.preset, opts.charsPerToken);
  const body = targetChars > 0 ? trimToChars(opts.sourceText, targetChars) : "";

  // First line, always. Cache-busting depends on it being first.
  const runIdLine = `[race-run ${opts.runId}]`;

  const parts = [runIdLine, spec.instruction];
  if (body) parts.push(body);
  const text = parts.join("\n\n");

  return { text, chars: text.length, targetChars, runIdLine };
}

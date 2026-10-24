/**
 * Long-context questions, made here from a fixed seed (nothing to download).
 *
 * The same idea as RULER (NVIDIA, Apache License 2.0, arXiv 2404.06654) and the "needle in a
 * haystack" test (Greg Kamradt, MIT): bury a fact in a long run of plain text, then ask for it. A
 * machine that reads 32K tokens but cannot find a number in them has a context size on paper only.
 * Three kinds of question, each at each prompt size you ask for:
 *
 *   needle    one fact at 10%, 50% and 90% of the way through
 *   multikey  one fact among ten look-alike facts about other cities
 *   varchain  find every variable that holds a value, through a chain of "VAR B = VAR A" lines,
 *             among the lines of a second, unrelated chain
 *
 * The questions are written fresh from the seed, so they are the same on every machine and every
 * run, and are not the published RULER questions: a score here is for comparing your machines.
 */

import { PRESETS } from "../prompt.ts";
import type { PresetId } from "../types.ts";
import { oneRule } from "./suite.ts";
import type { Question } from "./suite.ts";

export const LONGCTX_SIZES: PresetId[] = ["4k", "8k", "16k", "32k", "64k", "128k"];
export const DEFAULT_LONGCTX_SIZES: PresetId[] = ["4k", "8k", "16k", "32k"];

function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = ["quiet", "old", "bright", "narrow", "green", "heavy", "pale", "busy", "cold", "gentle", "tall", "dusty", "warm", "small", "wide"];
const NOUN = ["river", "market", "lantern", "garden", "bridge", "harbor", "orchard", "village", "tower", "meadow", "workshop", "station", "library", "valley", "bakery"];
const VERB = ["rests beside", "looks over", "stands near", "winds around", "waits behind", "borders", "faces", "leads toward", "sits above", "echoes through"];
const PLACE = ["the hills", "the old road", "the square", "the shoreline", "the forest edge", "the east gate", "the canal", "the farmland", "the town hall", "the rail yard"];
const CITIES = ["Avesta", "Brindle", "Carrow", "Dunmore", "Elsford", "Fennick", "Galway Reach", "Harlow", "Ironvale", "Jessup", "Kelburn", "Lorne", "Marlow", "Nethby", "Oakhaven", "Pellam", "Quillon", "Rosthorn", "Sedgley", "Thornby", "Ulverton", "Vexley", "Wrenfield", "Yarrow", "Zelmont"];

function sentence(r: () => number): string {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!;
  return `The ${pick(ADJ)} ${pick(NOUN)} ${pick(VERB)} ${pick(PLACE)}.`;
}

/** Plain sentences, no digits, up to about `chars` characters. */
function filler(r: () => number, chars: number): string[] {
  const out: string[] = [];
  let n = 0;
  while (n < chars) {
    const s = sentence(r);
    out.push(s);
    n += s.length + 1;
  }
  return out;
}

/** Puts each fact at its depth (0 to 1) among the sentences and joins them into paragraphs. */
function assemble(sentences: string[], facts: { text: string; depth: number }[]): string {
  const items = [...sentences];
  // Insert from the deepest back so earlier positions stay put.
  const placed = facts.map((f) => ({ ...f, at: Math.floor(f.depth * sentences.length) })).sort((a, b) => b.at - a.at);
  for (const f of placed) items.splice(f.at, 0, f.text);
  const paragraphs: string[] = [];
  for (let i = 0; i < items.length; i += 6) paragraphs.push(items.slice(i, i + 6).join(" "));
  return paragraphs.join("\n\n");
}

function sevenDigits(r: () => number): string {
  return String(1_000_000 + Math.floor(r() * 9_000_000));
}

function frame(text: string, question: string): string {
  return `Read the following text carefully. It contains a few facts among ordinary descriptive sentences.\n\n${text}\n\n${question}`;
}

function needleFact(city: string, n: string): string {
  return `The special magic number for ${city} is ${n}.`;
}

export function longContextQuestions(opts: { sizes: PresetId[]; charsPerToken: number }): Question[] {
  const out: Question[] = [];
  for (const size of opts.sizes) {
    const tokens = PRESETS[size].targetTokens;
    // Leave room for the facts and the question around the filler.
    const chars = Math.max(500, Math.round(tokens * opts.charsPerToken * 0.97) - 1500);
    const label = PRESETS[size].label;

    // needle
    for (const depth of [0.1, 0.5, 0.9]) {
      const r = rng(`needle-${size}-${depth}`);
      const city = CITIES[Math.floor(r() * CITIES.length)]!;
      const n = sevenDigits(r);
      const text = assemble(filler(r, chars), [{ text: needleFact(city, n), depth }]);
      const key = `needle-${size}-${Math.round(depth * 100)}`;
      out.push({
        key,
        prompt: frame(text, `Question: What is the special magic number for ${city}? Answer with the number only.`),
        check: (resp) => {
          const found = resp.replace(/[,\s]/g, "").includes(n);
          return oneRule(key, `needle @ ${label}`, found, found, resp.trim() === "");
        },
      });
    }

    // multikey
    for (const copy of [1, 2]) {
      const r = rng(`multikey-${size}-${copy}`);
      const order = [...CITIES].sort(() => r() - 0.5);
      const target = order[0]!;
      const others = order.slice(1, 11);
      const numbers = new Map<string, string>();
      for (const c of order.slice(0, 11)) numbers.set(c, sevenDigits(r));
      const facts = [{ text: needleFact(target, numbers.get(target)!), depth: 0.5 }];
      others.forEach((c, i) => facts.push({ text: needleFact(c, numbers.get(c)!), depth: (i + 0.5) / others.length }));
      const text = assemble(filler(r, chars), facts);
      const want = numbers.get(target)!;
      const wrong = others.map((c) => numbers.get(c)!);
      const key = `multikey-${size}-${copy}`;
      out.push({
        key,
        prompt: frame(text, `Question: Several cities have a special magic number. What is the special magic number for ${target}? Answer with the number only.`),
        check: (resp) => {
          const flat = resp.replace(/[,\s]/g, "");
          const found = flat.includes(want);
          const clean = !wrong.some((w) => flat.includes(w));
          return oneRule(key, `multikey @ ${label}`, found && clean, found, resp.trim() === "");
        },
      });
    }

    // varchain
    for (const copy of [1, 2]) {
      const r = rng(`varchain-${size}-${copy}`);
      const letters = "BCDFGHJKLMNPQRSTVWXZ";
      const names = new Set<string>();
      while (names.size < 7) names.add(Array.from({ length: 4 }, () => letters[Math.floor(r() * letters.length)]).join(""));
      const [a1, a2, a3, a4, b1, b2, b3] = [...names];
      const value = String(10_000 + Math.floor(r() * 90_000));
      const other = String(10_000 + Math.floor(r() * 90_000));
      const facts = [
        { text: `VAR ${a1} = ${value}.`, depth: 0.1 }, { text: `VAR ${a2} = VAR ${a1}.`, depth: 0.3 },
        { text: `VAR ${a3} = VAR ${a2}.`, depth: 0.55 }, { text: `VAR ${a4} = VAR ${a3}.`, depth: 0.8 },
        { text: `VAR ${b1} = ${other}.`, depth: 0.2 }, { text: `VAR ${b2} = VAR ${b1}.`, depth: 0.45 },
        { text: `VAR ${b3} = VAR ${b2}.`, depth: 0.7 },
      ];
      const text = assemble(filler(r, chars), facts);
      const want = [a1!, a2!, a3!, a4!];
      const wrong = [b1!, b2!, b3!];
      const has = (resp: string, name: string) => new RegExp(`\\b${name}\\b`).test(resp);
      const key = `varchain-${size}-${copy}`;
      out.push({
        key,
        prompt: frame(
          text,
          `Question: Some lines assign a number to a variable ("VAR X = 123") and some copy one variable into another ("VAR Y = VAR X"). Which variables hold the value ${value}, directly or through other variables? List every variable name and nothing else.`,
        ),
        check: (resp) => {
          const all = want.every((n) => has(resp, n));
          const clean = !wrong.some((n) => has(resp, n));
          return oneRule(key, `varchain @ ${label}`, all && clean, all, resp.trim() === "");
        },
      });
    }
  }
  return out;
}

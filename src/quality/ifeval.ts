/**
 * IFEval answer checks, written in TypeScript.
 *
 * IFEval (Zhou et al., "Instruction-Following Evaluation for Large Language Models", 2023) gives
 * about 540 prompts, each carrying one or more rules a program can check ("no commas", "at least
 * 300 words", "exactly 3 bullet points"). The questions and the rules' settings come from Google
 * Research's data file (Apache License 2.0, see quality/ifeval/NOTICE.md). The checks below follow
 * the behaviour of Google Research's `instruction_following_eval` code, re-written here for Bun
 * with no dependencies. They are a port and not a copy, so a small difference is possible, most of
 * all in the language checks (see `detectLanguage`). This file is marked as changed from the
 * original, as the Apache License asks.
 *
 * "Strict" is the answer as the model wrote it. "Loose" also accepts the answer with its first
 * line, last line or asterisks removed, which forgives a model that adds "Sure! Here it is:".
 */

export type Kwargs = Record<string, unknown>;

export interface IfEvalRow {
  key: number;
  prompt: string;
  instruction_id_list: string[];
  kwargs: Kwargs[];
}

type Check = (value: string, kwargs: Kwargs, prompt: string) => boolean;

/** The data file holds null for every setting a rule does not use. */
export function cleanKwargs(k: Kwargs | undefined): Kwargs {
  const out: Kwargs = {};
  for (const [name, v] of Object.entries(k ?? {})) if (v !== null && v !== undefined) out[name] = v;
  return out;
}

const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);

/** Python's str.isupper / str.islower: at least one cased letter, and every cased letter is that case. */
export function isUpper(s: string): boolean {
  return hasCased(s) && s === s.toUpperCase();
}
export function isLower(s: string): boolean {
  return hasCased(s) && s === s.toLowerCase();
}
function hasCased(s: string): boolean {
  return s.toLowerCase() !== s.toUpperCase();
}

function compare(count: number, relation: string, n: number): boolean {
  if (relation === "less than") return count < n;
  if (relation === "at least") return count >= n;
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Python's `re.findall(keyword, text, IGNORECASE)`: the keyword is a pattern, as in the original. */
function countPattern(text: string, pattern: string): number {
  try {
    return [...text.matchAll(new RegExp(pattern, "gi"))].length;
  } catch {
    return [...text.matchAll(new RegExp(escapeRegex(pattern), "gi"))].length;
  }
}

function words(text: string): string[] {
  return text.match(/\w+/gu) ?? [];
}

/** Sentences: split after . ! or ? followed by space, keeping common abbreviations together. */
export function countSentences(text: string): number {
  const protectedText = text
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\./gi, "$1<prd>")
    .replace(/(\d)\.(\d)/g, "$1<prd>$2")
    .replace(/\b([A-Z])\.(?=\s?[A-Z]\.)/g, "$1<prd>");
  return protectedText
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "").length;
}

// ---- language -------------------------------------------------------------------------------

const SCRIPTS: Record<string, RegExp> = {
  ar: /[؀-ۿ]/u, fa: /[؀-ۿ]/u, ur: /[؀-ۿ]/u,
  hi: /[ऀ-ॿ]/u, ne: /[ऀ-ॿ]/u, mr: /[ऀ-ॿ]/u,
  bn: /[ঀ-৿]/u, pa: /[਀-੿]/u, gu: /[઀-૿]/u, ta: /[஀-௿]/u,
  te: /[ఀ-౿]/u, kn: /[ಀ-೿]/u, ml: /[ഀ-ൿ]/u, th: /[฀-๿]/u,
  ko: /[가-힯]/u, he: /[֐-׿]/u, ru: /[Ѐ-ӿ]/u, bg: /[Ѐ-ӿ]/u, uk: /[Ѐ-ӿ]/u,
  ja: /[぀-ヿ一-鿿]/u,
};

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "is", "in", "that", "it", "for", "with", "you", "are"],
  es: ["el", "la", "de", "que", "y", "en", "los", "una", "para", "con", "es", "por"],
  pt: ["o", "a", "de", "que", "e", "em", "os", "uma", "para", "com", "não", "do", "da"],
  fr: ["le", "la", "de", "et", "les", "des", "est", "une", "pour", "que", "dans", "pas"],
  de: ["der", "die", "und", "das", "ist", "nicht", "mit", "ein", "eine", "zu", "den", "für"],
  it: ["il", "la", "di", "che", "e", "è", "per", "una", "con", "non", "sono", "del"],
  fi: ["ja", "on", "ei", "että", "se", "oli", "mutta", "kun", "ovat", "sen", "tämä"],
  pl: ["i", "w", "nie", "na", "się", "z", "że", "do", "jest", "to", "jak"],
  vi: ["và", "của", "là", "có", "không", "một", "những", "được", "trong", "cho"],
  sw: ["na", "ya", "wa", "kwa", "ni", "katika", "za", "kuwa", "cha", "hii"],
};

/**
 * A rough guess at the language of a text, with no libraries: the writing system decides for
 * scripts used by one language, and common words decide between Latin-script languages.
 * Scripts shared by several languages (Arabic, Devanagari, Cyrillic) accept any of them.
 * Google's code uses the `langdetect` library, so a borderline text can be judged differently here.
 */
export function detectLanguage(text: string): Set<string> {
  const letters = [...text].filter((c) => hasCased(c) || /\p{L}/u.test(c));
  if (letters.length === 0) return new Set();
  const found = new Set<string>();
  for (const [lang, re] of Object.entries(SCRIPTS)) {
    const hits = letters.filter((c) => re.test(c)).length;
    if (hits / letters.length > 0.4) found.add(lang);
  }
  if (found.size > 0) return found;
  const tokens = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let best = "";
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = tokens.filter((t) => set.has(t)).length;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return bestScore > 0 ? new Set([best]) : new Set();
}

const isEnglish = (value: string) => detectLanguage(value).has("en");

// ---- the rules --------------------------------------------------------------------------------

const CHECKS: Record<string, Check> = {
  "keywords:existence": (v, k) => {
    const list = Array.isArray(k.keywords) ? (k.keywords as unknown[]).map((x) => str(x)) : [];
    return list.length > 0 && list.every((w) => countPattern(v, w) > 0);
  },
  "keywords:frequency": (v, k) => compare(countPattern(v, str(k.keyword)), str(k.relation), num(k.frequency)),
  "keywords:forbidden_words": (v, k) => {
    const list = Array.isArray(k.forbidden_words) ? (k.forbidden_words as unknown[]).map((x) => str(x)) : [];
    return list.every((w) => {
      try {
        return !new RegExp(`\\b${w}\\b`, "i").test(v);
      } catch {
        return !new RegExp(`\\b${escapeRegex(w)}\\b`, "i").test(v);
      }
    });
  },
  "keywords:letter_frequency": (v, k) => {
    const letter = str(k.letter).toLowerCase();
    const count = [...v.toLowerCase()].filter((c) => c === letter).length;
    return compare(count, str(k.let_relation), num(k.let_frequency));
  },
  "language:response_language": (v, k) => detectLanguage(v).has(str(k.language)),
  "length_constraints:number_sentences": (v, k) => compare(countSentences(v), str(k.relation), num(k.num_sentences)),
  "length_constraints:number_paragraphs": (v, k) => {
    const parts = v.split(/\s?\*\*\*\s?/);
    let n = parts.length;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.trim() === "") {
        if (i === 0 || i === parts.length - 1) n--;
        else return false;
      }
    }
    return n === num(k.num_paragraphs);
  },
  "length_constraints:number_words": (v, k) => compare(words(v).length, str(k.relation), num(k.num_words)),
  "length_constraints:nth_paragraph_first_word": (v, k) => {
    const parts = v.split(/\n\n/);
    let n = parts.length;
    for (const p of parts) if (p.trim() === "") n--;
    const nth = num(k.nth_paragraph);
    if (nth > n || nth < 1) return false;
    const paragraph = (parts[nth - 1] ?? "").trim();
    if (paragraph === "") return false;
    let word = (paragraph.split(/\s+/)[0] ?? "").trim().replace(/^'+/, "").replace(/^"+/, "");
    let first = "";
    for (const ch of word) {
      if (".,?!'\"".includes(ch)) break;
      first += ch.toLowerCase();
    }
    word = first;
    return n === num(k.num_paragraphs) && word === str(k.first_word).toLowerCase();
  },
  "detectable_content:number_placeholders": (v, k) => (v.match(/\[.*?\]/g) ?? []).length >= num(k.num_placeholders),
  "detectable_content:postscript": (v, k) => {
    const marker = str(k.postscript_marker);
    const lower = v.toLowerCase();
    let pattern: string;
    if (marker === "P.P.S") pattern = "\\s*p\\.\\s?p\\.\\s?s.*$";
    else if (marker === "P.S.") pattern = "\\s*p\\.\\s?s\\..*$";
    else pattern = `\\s*${escapeRegex(marker.toLowerCase())}.*$`;
    return new RegExp(pattern, "m").test(lower);
  },
  "detectable_format:number_bullet_lists": (v, k) => {
    const star = v.match(/^\s*\*[^*].*$/gm) ?? [];
    const dash = v.match(/^\s*-.*$/gm) ?? [];
    return star.length + dash.length === num(k.num_bullets);
  },
  "detectable_format:constrained_response": (v) =>
    ["My answer is yes.", "My answer is no.", "My answer is maybe."].some((o) => v.includes(o)),
  "detectable_format:number_highlighted_sections": (v, k) => {
    let n = 0;
    for (const h of v.match(/\*[^\n*]*\*/g) ?? []) if (h.replace(/^\*+|\*+$/g, "").trim() !== "") n++;
    for (const h of v.match(/\*\*[^\n*]*\*\*/g) ?? []) if (h.replace(/^\*+|\*+$/g, "").trim() !== "") n++;
    return n >= num(k.num_highlights);
  },
  "detectable_format:multiple_sections": (v, k) => {
    const pattern = new RegExp(`\\s?${escapeRegex(str(k.section_spliter))}\\s?\\d+\\s?`);
    return v.split(pattern).length - 1 >= num(k.num_sections);
  },
  "detectable_format:json_format": (v) => {
    const t = v
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```Json\s*/, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  },
  "detectable_format:title": (v) => (v.match(/<<[^\n]+>>/g) ?? []).some((t) => t.replace(/^<+/, "").replace(/>+$/, "").trim() !== ""),
  "combination:two_responses": (v) => {
    const parts = v.split("******");
    const valid: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]!.trim() === "") {
        if (i !== 0 && i !== parts.length - 1) return false;
      } else valid.push(parts[i]!);
    }
    return valid.length === 2 && valid[0]!.trim() !== valid[1]!.trim();
  },
  "combination:repeat_prompt": (v, k) => v.trim().toLowerCase().startsWith(str(k.prompt_to_repeat).trim().toLowerCase()),
  "startend:end_checker": (v, k) => v.trim().replace(/^"+|"+$/g, "").toLowerCase().endsWith(str(k.end_phrase).trim().toLowerCase()),
  "startend:quotation": (v) => {
    const t = v.trim();
    return t.length > 1 && t.startsWith('"') && t.endsWith('"');
  },
  "change_case:capital_word_frequency": (v, k) => {
    const caps = (v.match(/[\p{L}\p{N}']+/gu) ?? []).filter((w) => isUpper(w));
    return compare(caps.length, str(k.capital_relation), num(k.capital_frequency));
  },
  "change_case:english_capital": (v) => isUpper(v) && isEnglish(v),
  "change_case:english_lowercase": (v) => isLower(v) && isEnglish(v),
  "punctuation:no_comma": (v) => !v.includes(","),
};

export const KNOWN_INSTRUCTIONS = Object.keys(CHECKS);

/** The rules whose answer rests on the rough language guess. Reported separately so it is visible. */
export const APPROXIMATE_INSTRUCTIONS = new Set(["language:response_language", "change_case:english_capital", "change_case:english_lowercase"]);

export interface RuleResult {
  id: string;
  strict: boolean;
  loose: boolean;
}

export interface PromptResult {
  key: number | string;
  strict: boolean;
  loose: boolean;
  rules: RuleResult[];
  /** True when the answer was empty, so the checks ran on nothing. */
  empty: boolean;
}

/** The answer with the usual chatter taken off, tried by the loose score. */
export function looseVariants(response: string): string[] {
  const lines = response.split("\n");
  const noFirst = lines.slice(1).join("\n").trim();
  const noLast = lines.slice(0, -1).join("\n").trim();
  const noBoth = lines.slice(1, -1).join("\n").trim();
  const base = [response, noFirst, noLast, noBoth];
  const out: string[] = [];
  for (const r of base) {
    out.push(r);
    out.push(r.replace(/\*/g, ""));
  }
  return out;
}

export function checkResponse(row: IfEvalRow, response: string): PromptResult {
  const variants = looseVariants(response);
  const rules: RuleResult[] = row.instruction_id_list.map((id, i) => {
    const check = CHECKS[id];
    const kw = cleanKwargs(row.kwargs[i]);
    if (!check) return { id, strict: false, loose: false };
    const run = (text: string) => {
      if (text.trim() === "") return false;
      try {
        return check(text, kw, row.prompt);
      } catch {
        return false;
      }
    };
    return { id, strict: run(response), loose: variants.some(run) };
  });
  return {
    key: row.key,
    strict: rules.every((r) => r.strict),
    loose: rules.every((r) => r.loose),
    rules,
    empty: response.trim() === "",
  };
}

export interface Score {
  prompts: number;
  /** Share of prompts where every rule passed. The headline number. */
  promptStrict: number;
  promptLoose: number;
  /** Share of all rules that passed. */
  ruleStrict: number;
  ruleLoose: number;
}

export function scoreResults(results: PromptResult[]): Score {
  const n = results.length;
  const rules = results.flatMap((r) => r.rules);
  const share = (k: number, d: number) => (d === 0 ? 0 : k / d);
  return {
    prompts: n,
    promptStrict: share(results.filter((r) => r.strict).length, n),
    promptLoose: share(results.filter((r) => r.loose).length, n),
    ruleStrict: share(rules.filter((r) => r.strict).length, rules.length),
    ruleLoose: share(rules.filter((r) => r.loose).length, rules.length),
  };
}

/** How each kind of rule went, so a machine that fails one kind shows it. */
export function byRule(results: PromptResult[]): Record<string, { total: number; strict: number }> {
  const out: Record<string, { total: number; strict: number }> = {};
  for (const r of results.flatMap((p) => p.rules)) {
    const e = (out[r.id] ??= { total: 0, strict: 0 });
    e.total++;
    if (r.strict) e.strict++;
  }
  return out;
}

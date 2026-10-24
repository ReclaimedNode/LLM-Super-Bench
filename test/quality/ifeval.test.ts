import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { IFEVAL_COUNT, parseIfEval, pickQuestions } from "../../src/quality/data.ts";
import { KNOWN_INSTRUCTIONS, checkResponse, countSentences, detectLanguage, scoreResults } from "../../src/quality/ifeval.ts";
import type { IfEvalRow } from "../../src/quality/ifeval.ts";

const sample = readFileSync(resolve(import.meta.dir, "ifeval-sample.jsonl"), "utf8");

/** One rule, one answer: does it pass strictly? */
function strict(id: string, kwargs: Record<string, unknown>, answer: string, prompt = "p"): boolean {
  const row: IfEvalRow = { key: 1, prompt, instruction_id_list: [id], kwargs: [kwargs] };
  return checkResponse(row, answer).rules[0]!.strict;
}

describe("the data file", () => {
  test("Google's own first rows (kept as published) load", () => {
    const parsed = parseIfEval(sample, 3);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.rows.map((r) => r.key)).toEqual([1000, 1001, 1005]);
  });
  test("a file with the wrong number of questions is refused", () => {
    const parsed = parseIfEval(sample);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(`Expected ${IFEVAL_COUNT}`);
  });
  test("a cut-off line, an unknown rule and a repeated key are refused", () => {
    expect(parseIfEval(sample.slice(0, 200), null).ok).toBe(false);
    expect(parseIfEval(sample.replace("punctuation:no_comma", "made:up"), null).ok).toBe(false);
    const line = sample.split("\n")[0]!;
    expect(parseIfEval(`${line}\n${line}\n`, null).ok).toBe(false);
  });
  test("every rule Google's data uses is known", () => {
    expect(KNOWN_INSTRUCTIONS.length).toBe(25);
  });
  test("a short run takes an even spread, and asking for all returns all", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ key: i, prompt: "p", instruction_id_list: ["punctuation:no_comma"], kwargs: [{}] }));
    const picked = pickQuestions(rows, 10);
    expect(picked.map((r) => r.key)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(pickQuestions(rows, null).length).toBe(100);
    expect(pickQuestions(rows, 500).length).toBe(100);
  });
});

describe("the rules", () => {
  test("no commas", () => {
    expect(strict("punctuation:no_comma", {}, "Hello there friend")).toBe(true);
    expect(strict("punctuation:no_comma", {}, "Hello, friend")).toBe(false);
  });
  test("number of words, both directions", () => {
    expect(strict("length_constraints:number_words", { relation: "at least", num_words: 5 }, "one two three four five")).toBe(true);
    expect(strict("length_constraints:number_words", { relation: "at least", num_words: 5 }, "one two")).toBe(false);
    expect(strict("length_constraints:number_words", { relation: "less than", num_words: 5 }, "one two")).toBe(true);
  });
  test("sentences", () => {
    expect(countSentences("One. Two! Three?")).toBe(3);
    expect(countSentences("Dr. Smith went home. He slept.")).toBe(2);
    expect(strict("length_constraints:number_sentences", { relation: "less than", num_sentences: 3 }, "One. Two.")).toBe(true);
  });
  test("paragraphs split on ***", () => {
    expect(strict("length_constraints:number_paragraphs", { num_paragraphs: 3 }, "a\n***\nb\n***\nc")).toBe(true);
    expect(strict("length_constraints:number_paragraphs", { num_paragraphs: 3 }, "a\n***\n***\nc")).toBe(false);
  });
  test("nth paragraph first word", () => {
    const k = { num_paragraphs: 2, nth_paragraph: 2, first_word: "second" };
    expect(strict("length_constraints:nth_paragraph_first_word", k, "First one.\n\nSecond, here.")).toBe(true);
    expect(strict("length_constraints:nth_paragraph_first_word", k, "First one.\n\nThird here.")).toBe(false);
    expect(strict("length_constraints:nth_paragraph_first_word", k, "Only one paragraph")).toBe(false);
  });
  test("placeholders", () => {
    expect(strict("detectable_content:number_placeholders", { num_placeholders: 2 }, "Hi [name] at [address]")).toBe(true);
    expect(strict("detectable_content:number_placeholders", { num_placeholders: 2 }, "Hi [name]")).toBe(false);
  });
  test("postscript", () => {
    expect(strict("detectable_content:postscript", { postscript_marker: "P.S." }, "Dear you\nP.S. see you")).toBe(true);
    expect(strict("detectable_content:postscript", { postscript_marker: "P.S." }, "Dear you")).toBe(false);
    expect(strict("detectable_content:postscript", { postscript_marker: "P.P.S" }, "Hi\nP.P.S later")).toBe(true);
  });
  test("bullets count exactly", () => {
    expect(strict("detectable_format:number_bullet_lists", { num_bullets: 2 }, "* one\n* two")).toBe(true);
    expect(strict("detectable_format:number_bullet_lists", { num_bullets: 2 }, "* one\n* two\n- three")).toBe(false);
  });
  test("constrained response", () => {
    expect(strict("detectable_format:constrained_response", {}, "My answer is yes.")).toBe(true);
    expect(strict("detectable_format:constrained_response", {}, "Yes")).toBe(false);
  });
  test("highlighted sections", () => {
    expect(strict("detectable_format:number_highlighted_sections", { num_highlights: 2 }, "*a* and *b*")).toBe(true);
    expect(strict("detectable_format:number_highlighted_sections", { num_highlights: 3 }, "*a* and *b*")).toBe(false);
  });
  test("multiple sections", () => {
    const k = { section_spliter: "SECTION", num_sections: 2 };
    expect(strict("detectable_format:multiple_sections", k, "SECTION 1\nx\nSECTION 2\ny")).toBe(true);
    expect(strict("detectable_format:multiple_sections", k, "SECTION 1\nx")).toBe(false);
  });
  test("json, with or without a code fence", () => {
    expect(strict("detectable_format:json_format", {}, '{"a":1}')).toBe(true);
    expect(strict("detectable_format:json_format", {}, '```json\n{"a":1}\n```')).toBe(true);
    expect(strict("detectable_format:json_format", {}, "not json")).toBe(false);
  });
  test("title", () => {
    expect(strict("detectable_format:title", {}, "<<A title>>\ntext")).toBe(true);
    expect(strict("detectable_format:title", {}, "A title\ntext")).toBe(false);
  });
  test("two responses", () => {
    expect(strict("combination:two_responses", {}, "one******two")).toBe(true);
    expect(strict("combination:two_responses", {}, "same******same")).toBe(false);
    expect(strict("combination:two_responses", {}, "only one")).toBe(false);
  });
  test("repeat the prompt first", () => {
    expect(strict("combination:repeat_prompt", { prompt_to_repeat: "Say hi." }, "say hi.\nHi!")).toBe(true);
    expect(strict("combination:repeat_prompt", { prompt_to_repeat: "Say hi." }, "Hi!")).toBe(false);
  });
  test("end phrase and quotation", () => {
    expect(strict("startend:end_checker", { end_phrase: "Is there anything else I can help with?" }, "Done. is there anything else I can help with?")).toBe(true);
    expect(strict("startend:end_checker", { end_phrase: "bye" }, "Done.")).toBe(false);
    expect(strict("startend:quotation", {}, '"wrapped"')).toBe(true);
    expect(strict("startend:quotation", {}, "bare")).toBe(false);
  });
  test("keywords: existence, frequency, forbidden, letters", () => {
    expect(strict("keywords:existence", { keywords: ["cat", "dog"] }, "A Cat and a dog")).toBe(true);
    expect(strict("keywords:existence", { keywords: ["cat", "bird"] }, "A cat")).toBe(false);
    expect(strict("keywords:frequency", { keyword: "go", relation: "at least", frequency: 2 }, "go go")).toBe(true);
    expect(strict("keywords:forbidden_words", { forbidden_words: ["bad"] }, "all good")).toBe(true);
    expect(strict("keywords:forbidden_words", { forbidden_words: ["bad"] }, "a bad day")).toBe(false);
    expect(strict("keywords:forbidden_words", { forbidden_words: ["bad"] }, "badge")).toBe(true);
    expect(strict("keywords:letter_frequency", { letter: "a", let_relation: "at least", let_frequency: 3 }, "banana")).toBe(true);
    expect(strict("keywords:letter_frequency", { letter: "a", let_relation: "less than", let_frequency: 3 }, "banana")).toBe(false);
  });
  test("capital words", () => {
    expect(strict("change_case:capital_word_frequency", { capital_relation: "at least", capital_frequency: 2 }, "THIS is VERY good")).toBe(true);
    expect(strict("change_case:capital_word_frequency", { capital_relation: "less than", capital_frequency: 2 }, "THIS is VERY good")).toBe(false);
  });
  test("all capital and all lowercase English", () => {
    expect(strict("change_case:english_capital", {}, "THE CAT IS IN THE HOUSE AND THAT IS FINE")).toBe(true);
    expect(strict("change_case:english_capital", {}, "The cat")).toBe(false);
    expect(strict("change_case:english_lowercase", {}, "the cat is in the house and that is fine")).toBe(true);
    expect(strict("change_case:english_lowercase", {}, "The cat")).toBe(false);
  });
  test("response language, from the writing system and common words", () => {
    expect(detectLanguage("Привет, как дела у тебя сегодня").has("ru")).toBe(true);
    expect(detectLanguage("El perro y la casa de los niños es para ti").has("es")).toBe(true);
    expect(strict("language:response_language", { language: "ko" }, "안녕하세요 오늘 날씨가 좋습니다")).toBe(true);
    expect(strict("language:response_language", { language: "ko" }, "hello there and the world")).toBe(false);
  });
  test("a rule with a name the tool does not know fails rather than passing", () => {
    const row: IfEvalRow = { key: 1, prompt: "p", instruction_id_list: ["made:up"], kwargs: [{}] };
    expect(checkResponse(row, "anything").strict).toBe(false);
  });
});

describe("strict and loose", () => {
  const row: IfEvalRow = parseIfEval(sample, 3).ok ? (parseIfEval(sample, 3) as { rows: IfEvalRow[] }).rows[1]! : (undefined as never);
  test("chatter around the answer fails strict but passes loose", () => {
    const r = checkResponse(row, "Sure, here it is:\nA trip, in verse");
    expect(r.strict).toBe(false);
    const r2 = checkResponse(row, "Sure here it is:\nA trip in verse");
    expect(r2.strict).toBe(true);
    const r3 = checkResponse(row, "Sure, here it is:\nA trip in verse");
    expect(r3.strict).toBe(false);
    expect(r3.loose).toBe(true);
  });
  test("an empty answer fails every rule", () => {
    const r = checkResponse(row, "   ");
    expect(r.empty).toBe(true);
    expect(r.strict).toBe(false);
    expect(r.loose).toBe(false);
  });
  test("a prompt passes only when every rule in it does", () => {
    const first = (parseIfEval(sample, 3) as { rows: IfEvalRow[] }).rows[0]!;
    const long = Array.from({ length: 320 }, (_, i) => `word${i}`).join(" ");
    const fails = checkResponse(first, `*a* *b* *c* ${long},`);
    expect(fails.strict).toBe(false);
    const passes = checkResponse(first, `*a* *b* *c* ${long}`);
    expect(passes.strict).toBe(true);
    const score = scoreResults([passes, fails]);
    expect(score.promptStrict).toBe(0.5);
    expect(score.ruleStrict).toBeCloseTo(5 / 6, 5);
  });
});

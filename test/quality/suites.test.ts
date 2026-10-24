import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadHf } from "../../src/quality/fetch.ts";
import { longContextQuestions } from "../../src/quality/longctx.ts";
import { gsm8kQuestions, gsm8kRow, lastBoxed, mathQuestions, mathRow, normalizeAnswer, readGsm8k, sameAnswer } from "../../src/quality/math.ts";
import { mcPrompt, mcQuestions, mmluProRow, mmluRow, pickLetter } from "../../src/quality/mc.ts";
import { formatGroups, buildQualityFile } from "../../src/quality/cli.ts";
import { runQuality } from "../../src/quality/runner.ts";
import { SUITES, loadSuite, questionsFromText } from "../../src/quality/suites.ts";
import type { RaceConfig } from "../../src/types.ts";

// Rows in the shapes the Hugging Face dataset viewer returns for each dataset.
const proRow = { question_id: 70, question: "Which is a fruit?", options: ["Rock", "Apple", "Chair", "Cloud"], answer: "B", answer_index: 1, cot_content: "", category: "business ethics", src: "x" };
const mmlu = { question: "2+2?", subject: "elementary_mathematics", choices: ["3", "4", "5", "6"], answer: 1 };
const gsm = { question: "Tom has 3 apples and buys 4 more. How many?", answer: "3 + 4 = <<3+4=7>>7\n#### 7" };
const gsmBig = { question: "q", answer: "so\n#### 1,250" };
const math = { problem: "What is 1/2 + 1/3?", solution: "s", answer: "\\frac{5}{6}", subject: "Algebra", level: 2, unique_id: "test/algebra/1.json" };

describe("multiple choice", () => {
  test("rows are read in the dataset's own shape", () => {
    expect(mmluProRow(proRow)).toMatchObject({ id: 70, category: "business ethics", answer: 1 });
    expect(mmluRow(mmlu, 0)).toMatchObject({ category: "elementary_mathematics", answer: 1 });
    expect(mmluProRow({ ...proRow, answer_index: 9 })).toBeNull();
    expect(mmluRow({ ...mmlu, choices: ["a", "b"] }, 0)).toBeNull();
    expect(mmluRow({ ...mmlu, answer: "B" }, 0)!.answer).toBe(1);
  });
  test("the prompt lists lettered options and says how to answer", () => {
    const p = mcPrompt(mmluProRow(proRow)!);
    expect(p).toContain("about business ethics");
    expect(p).toContain("B. Apple");
    expect(p).toContain('"The answer is (X)"');
  });
  test("the letter is read strictly from 'answer is (X)' and loosely from other forms", () => {
    expect(pickLetter("Reasoning...\nThe answer is (B).", 4)).toEqual({ strict: "B", loose: "B" });
    expect(pickLetter("The answer is B", 4).strict).toBe("B");
    expect(pickLetter("I think it is A, but actually the answer is C", 4).strict).toBe("C");
    expect(pickLetter("Answer: D", 4)).toEqual({ strict: null, loose: "D" });
    expect(pickLetter("It must be\nB", 4)).toEqual({ strict: null, loose: "B" });
    expect(pickLetter("The answer is (F)", 4).strict).toBeNull();
    expect(pickLetter("no idea", 4)).toEqual({ strict: null, loose: null });
  });
  test("a question scores strict, loose and by subject", () => {
    const [q] = mcQuestions([mmluProRow(proRow)!], null);
    expect(q!.check("The answer is (B)")).toMatchObject({ strict: true, loose: true });
    expect(q!.check("Answer: B")).toMatchObject({ strict: false, loose: true });
    expect(q!.check("The answer is (A)")).toMatchObject({ strict: false, loose: false });
    expect(q!.check("The answer is (B)").rules[0]!.id).toBe("business ethics");
    expect(q!.check("").empty).toBe(true);
  });
});

describe("maths", () => {
  test("GSM8K takes the number after ####", () => {
    expect(gsm8kRow(gsm)!.answer).toBe(7);
    expect(gsm8kRow(gsmBig)!.answer).toBe(1250);
    expect(gsm8kRow({ question: "q", answer: "no marker" })).toBeNull();
  });
  test("GSM8K answers: strict from 'The answer is N', loose from the last number", () => {
    expect(readGsm8k("3 + 4 = 7. The answer is 7")).toEqual({ strict: 7, loose: 7 });
    expect(readGsm8k("The answer is $1,250.")).toEqual({ strict: 1250, loose: 1250 });
    expect(readGsm8k("It comes to 7 apples")).toEqual({ strict: null, loose: 7 });
    const [q] = gsm8kQuestions([gsm8kRow(gsm)!], null);
    expect(q!.check("The answer is 7")).toMatchObject({ strict: true });
    expect(q!.check("It comes to 7 apples")).toMatchObject({ strict: false, loose: true });
    expect(q!.check("The answer is 8")).toMatchObject({ strict: false, loose: false });
  });
  test("the last \\boxed answer is found with its braces matched", () => {
    expect(lastBoxed("so \\boxed{1} no wait \\boxed{\\frac{5}{6}} done")).toBe("\\frac{5}{6}");
    expect(lastBoxed("nothing")).toBeNull();
    expect(lastBoxed("\\boxed{unclosed")).toBeNull();
  });
  test("answers are compared after writing them one way", () => {
    expect(normalizeAnswer("\\dfrac{5}{6}")).toBe("\\frac{5}{6}");
    expect(normalizeAnswer(" x = 4 ")).toBe("4");
    expect(normalizeAnswer("90^\\circ")).toBe("90");
    expect(normalizeAnswer("\\text{(3, } ")).toBe("(3,");
    expect(sameAnswer("\\dfrac{5}{6}", "\\frac{5}{6}").strict).toBe(true);
    expect(sameAnswer("5/6", "\\frac{5}{6}")).toEqual({ strict: false, loose: true });
    expect(sameAnswer("0.5", "\\frac{1}{2}").loose).toBe(true);
    expect(sameAnswer("7", "8")).toEqual({ strict: false, loose: false });
  });
  test("MATH-500 questions score by subject", () => {
    const [q] = mathQuestions([mathRow(math)!], null);
    expect(q!.check("so \\boxed{\\frac{5}{6}}").rules[0]).toEqual({ id: "Algebra", strict: true, loose: true });
    expect(q!.check("so the answer is 5/6")).toMatchObject({ strict: false, loose: false });
    expect(mathRow({ ...math, answer: "" })).toBeNull();
  });
});

describe("long context", () => {
  const qs = longContextQuestions({ sizes: ["4k", "8k"], charsPerToken: 4 });
  test("seven questions a size, the same every time", () => {
    expect(qs.length).toBe(14);
    const again = longContextQuestions({ sizes: ["4k", "8k"], charsPerToken: 4 });
    expect(again.map((q) => q.prompt)).toEqual(qs.map((q) => q.prompt));
    expect(new Set(qs.map((q) => q.key)).size).toBe(14);
  });
  test("prompts are about the size asked for, with the question last", () => {
    const four = qs.find((q) => q.key === "needle-4k-50")!;
    const eight = qs.find((q) => q.key === "needle-8k-50")!;
    expect(four.prompt.length).toBeGreaterThan(4096 * 4 * 0.7);
    expect(four.prompt.length).toBeLessThan(4096 * 4 * 1.05);
    expect(eight.prompt.length).toBeGreaterThan(four.prompt.length * 1.7);
    expect(four.prompt.trimEnd().endsWith("Answer with the number only.")).toBe(true);
  });
  test("the needle sits where it should and the filler has no digits", () => {
    const q = qs.find((x) => x.key === "needle-4k-10")!;
    const at = q.prompt.indexOf("The special magic number for ");
    const body = q.prompt.slice(q.prompt.indexOf("\n\n") + 2, q.prompt.lastIndexOf("\n\nQuestion"));
    expect(at / q.prompt.length).toBeLessThan(0.2);
    const withoutFact = body.replace(/The special magic number for [^.]+ is \d{7}\./, "");
    expect(/\d/.test(withoutFact)).toBe(false);
  });
  test("needle: right number passes, wrong one fails", () => {
    const q = qs.find((x) => x.key === "needle-4k-50")!;
    const n = /magic number for [A-Za-z ]+ is (\d{7})/.exec(q.prompt)![1]!;
    expect(q.check(`The number is ${n}.`)).toMatchObject({ strict: true });
    expect(q.check(`It is ${n.slice(0, 6)}0`)).toMatchObject({ strict: false });
    expect(q.check("").empty).toBe(true);
    expect(q.check(`${n.slice(0, 3)},${n.slice(3)}`).strict).toBe(true);
  });
  test("multikey: naming a look-alike's number as well fails strict but not loose", () => {
    const q = qs.find((x) => x.key === "multikey-4k-1")!;
    const city = /What is the special magic number for ([A-Za-z ]+)\?/.exec(q.prompt)![1]!;
    const want = new RegExp(`magic number for ${city} is (\\d{7})`).exec(q.prompt)![1]!;
    const other = [...q.prompt.matchAll(/magic number for [A-Za-z ]+ is (\d{7})/g)].map((m) => m[1]!).find((x) => x !== want)!;
    expect(q.check(want)).toMatchObject({ strict: true, loose: true });
    expect(q.check(`${want} and ${other}`)).toMatchObject({ strict: false, loose: true });
    expect(q.check(other)).toMatchObject({ strict: false, loose: false });
  });
  test("varchain: every variable of the chain, and none of the other chain", () => {
    const q = qs.find((x) => x.key === "varchain-4k-1")!;
    const lines = [...q.prompt.matchAll(/VAR ([A-Z]{4}) = (VAR [A-Z]{4}|\d+)\./g)].map((m) => [m[1]!, m[2]!] as const);
    const value = /hold the value (\d+)/.exec(q.prompt)![1]!;
    const chain = new Set<string>();
    for (const [n, v] of lines) if (v === value) chain.add(n);
    for (let i = 0; i < 4; i++) for (const [n, v] of lines) if (v.startsWith("VAR ") && chain.has(v.slice(4))) chain.add(n);
    expect(chain.size).toBe(4);
    const names = [...chain];
    const other = lines.map(([n]) => n).find((n) => !chain.has(n))!;
    expect(q.check(names.join(", "))).toMatchObject({ strict: true });
    expect(q.check(names.slice(1).join(", ")).strict).toBe(false);
    expect(q.check(`${names.join(", ")}, ${other}`)).toMatchObject({ strict: false, loose: true });
  });
  test("its results are grouped by kind and size", async () => {
    const lane = { label: "L", baseUrl: "http://x", model: "m" };
    const fetchImpl = (async () => Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    const results = await runQuality({ lanes: [{ laneId: "lane-0", lane }], questions: qs, maxTokens: 10, streams: 4, timeoutMs: 1000, fetchImpl });
    expect(Object.keys(results[0]!.byRule).sort()).toEqual(["multikey @ 4K", "multikey @ 8K", "needle @ 4K", "needle @ 8K", "varchain @ 4K", "varchain @ 8K"]);
    const file = buildQualityFile({ suite: SUITES.longctx, sizes: ["4k", "8k"], config: { lanes: [lane] } as unknown as RaceConfig, setups: {}, results, questions: qs.length, maxTokens: 10, thinking: "auto" });
    expect(file.benchmark).toMatchObject({ id: "longctx", of: null, sizes: ["4k", "8k"] });
    expect(formatGroups(file)).toContain("needle @ 4K");
  });
});

describe("the suite loader", () => {
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  test("a full-size count is demanded unless a test says otherwise", () => {
    const text = jsonl([gsm, gsmBig]);
    expect(questionsFromText("gsm8k", text, { limit: null }).ok).toBe(false);
    const ok = questionsFromText("gsm8k", text, { limit: null, anyCount: true });
    expect(ok.ok && ok.questions.length).toBe(2);
  });
  test("a row the test cannot read refuses the whole file", () => {
    expect(questionsFromText("gsm8k", jsonl([gsm, { nope: 1 }]), { limit: null, anyCount: true }).ok).toBe(false);
    expect(questionsFromText("math500", jsonl([{ problem: "p" }]), { limit: null, anyCount: true }).ok).toBe(false);
  });
  test("a missing file says how to get it", async () => {
    const r = await loadSuite("mmlu", { limit: null, sizes: [], charsPerToken: 4, file: "/nonexistent/data.jsonl" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("bun run quality:fetch mmlu");
  });
  test("a file on disk loads and --limit takes an even spread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quality-"));
    try {
      const file = join(dir, "data.jsonl");
      await writeFile(file, jsonl(Array.from({ length: 10 }, (_, i) => ({ ...mmlu, question: `q${i}` }))));
      const r = await loadSuite("mmlu", { limit: 5, sizes: [], charsPerToken: 4, file, anyCount: true });
      expect(r.ok && r.questions.map((q) => q.prompt.includes("q0") || q.prompt.includes("q2") || q.prompt.includes("q4") || q.prompt.includes("q6") || q.prompt.includes("q8"))).toEqual([true, true, true, true, true]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  test("the long-context test needs no file", async () => {
    const r = await loadSuite("longctx", { limit: null, sizes: ["4k"], charsPerToken: 4 });
    expect(r.ok && r.questions.length).toBe(7);
  });
  test("every published test names its source and licence", () => {
    for (const s of Object.values(SUITES)) {
      expect(s.source).not.toBe("");
      expect(s.license).not.toBe("");
    }
    expect(SUITES["mmlu-pro"].of).toBe(12032);
    expect(SUITES.mmlu.of).toBe(14042);
    expect(SUITES.gsm8k.of).toBe(1319);
    expect(SUITES.math500.of).toBe(500);
  });
});

describe("the downloader", () => {
  const page = (rows: unknown[], total: number) => Response.json({ rows: rows.map((row) => ({ row_idx: 0, row })), num_rows_total: total });
  test("pages through the rows 100 at a time and keeps each row as returned", async () => {
    const asked: string[] = [];
    const all = Array.from({ length: 250 }, (_, i) => ({ question: `q${i}`, answer: `#### ${i}` }));
    const f = (async (url: string) => {
      asked.push(url);
      const offset = Number(new URL(url).searchParams.get("offset"));
      return page(all.slice(offset, offset + 100), 250);
    }) as unknown as typeof fetch;
    const text = await downloadHf({ dataset: "openai/gsm8k", config: "main", split: "test" }, f, async () => {});
    expect(asked.length).toBe(3);
    expect(asked[0]).toContain("dataset=openai%2Fgsm8k");
    expect(text.trimEnd().split("\n").length).toBe(250);
    expect(JSON.parse(text.split("\n")[249]!)).toEqual(all[249]);
  });
  test("a busy service is waited for and tried again", async () => {
    let calls = 0;
    const pauses: number[] = [];
    const f = (async () => (++calls < 3 ? new Response("slow down", { status: 429 }) : page([{ a: 1 }], 1))) as unknown as typeof fetch;
    const text = await downloadHf({ dataset: "d", config: "c", split: "s" }, f, async (ms) => void pauses.push(ms));
    expect(text).toBe('{"a":1}\n');
    expect(pauses).toEqual([1000, 2000]);
  });
  test("a service that keeps failing is an error, not a short file", async () => {
    const f = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    await expect(downloadHf({ dataset: "d", config: "c", split: "s" }, f, async () => {})).rejects.toThrow("failed");
  });
});

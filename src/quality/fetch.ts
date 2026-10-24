/**
 * `bun run quality:fetch [suite|all]` -- downloads a published test's questions, unchanged, into
 * quality/<suite>/, checks them, and prints a fingerprint. Run once per suite.
 *
 *   bun run quality:fetch              IFEval (default)
 *   bun run quality:fetch mmlu-pro
 *   bun run quality:fetch all
 *
 * IFEval comes from Google Research's repository, with its Apache 2.0 licence file. The others
 * come from the Hugging Face dataset viewer's row service, 100 rows a request, and are written one
 * row per line exactly as the service returns them. Nothing is saved unless the download is the
 * full published set and every row is the shape this tool reads.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { IFEVAL_DIR } from "./data.ts";
import { SUITES, SUITE_IDS, isSuiteId, questionsFromText, suiteDir, suiteFile } from "./suites.ts";
import type { HfSource, Suite, SuiteId } from "./suites.ts";

const GOOGLE = "https://raw.githubusercontent.com/google-research/google-research/master";
export const IFEVAL_DATA_URL = `${GOOGLE}/instruction_following_eval/data/input_data.jsonl`;
export const IFEVAL_LICENSE_URL = `${GOOGLE}/LICENSE`;
const PAGE = 100;

/**
 * An optional Hugging Face access token, read from the HF_TOKEN environment variable (the name
 * Hugging Face's own tools use). A free token raises the download limits. It is only ever sent to
 * the Hugging Face row service, never written to disk or printed, and the tool works without it.
 */
export function hfHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const token = env.HF_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

type Fetch = typeof fetch;

async function getText(url: string, f: Fetch): Promise<string> {
  const response = await f(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.text();
}

/** One page of rows, retried with a growing pause when the service says to slow down. */
async function hfPage(src: HfSource, offset: number, f: Fetch, pause: (ms: number) => Promise<void>): Promise<{ rows: unknown[]; total: number }> {
  const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(src.dataset)}&config=${encodeURIComponent(src.config)}&split=${encodeURIComponent(src.split)}&offset=${offset}&length=${PAGE}`;
  let last = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await f(url, { signal: AbortSignal.timeout(60_000), headers: hfHeaders() });
      if (response.ok) {
        const body = (await response.json()) as { rows?: { row: unknown }[]; num_rows_total?: number };
        if (!Array.isArray(body.rows) || typeof body.num_rows_total !== "number") throw new Error("the reply was not a page of rows");
        return { rows: body.rows.map((r) => r.row), total: body.num_rows_total };
      }
      last = response.status === 401 ? "HTTP 401 (HF_TOKEN was not accepted; check it, or unset it to download without one)" : `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await pause(Math.min(30_000, 1000 * 2 ** attempt));
  }
  throw new Error(`rows ${offset}+ failed: ${last}`);
}

export async function downloadHf(src: HfSource, f: Fetch = fetch, pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), pacing: () => Promise<void> = () => new Promise((r) => setTimeout(r, 400))): Promise<string> {
  const lines: string[] = [];
  let total = Infinity;
  for (let offset = 0; offset < total; offset += PAGE) {
    const page = await hfPage(src, offset, f, pause);
    total = page.total;
    for (const row of page.rows) lines.push(JSON.stringify(row));
    if (page.rows.length === 0) break;
    // Go gently: the service rate-limits fast downloaders, and a long set is over a hundred requests.
    if (offset + PAGE < total) await pacing();
  }
  return lines.join("\n") + "\n";
}

export async function fetchSuite(id: SuiteId, f: Fetch = fetch, pause?: (ms: number) => Promise<void>): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const suite: Suite = SUITES[id];
  if (suite.generated) return { ok: false, error: `${suite.name} is made by this tool and has nothing to download.` };
  try {
    if (id === "ifeval") {
      const [data, license] = await Promise.all([getText(IFEVAL_DATA_URL, f), getText(IFEVAL_LICENSE_URL, f)]);
      const checked = questionsFromText(id, data, { limit: null });
      if (!checked.ok) return { ok: false, error: `The download was not the IFEval file, so nothing was saved. ${checked.error}` };
      if (!/Apache License/i.test(license) || !/Version 2\.0/i.test(license)) {
        return { ok: false, error: "The licence file did not read as the Apache License 2.0, so nothing was saved." };
      }
      await mkdir(IFEVAL_DIR, { recursive: true });
      await writeFile(suiteFile(id), data);
      await writeFile(resolve(IFEVAL_DIR, "LICENSE-APACHE-2.0.txt"), license);
      return { ok: true, message: `IFEval: saved ${checked.questions.length} questions and the Apache 2.0 licence to quality/ifeval/. SHA-256: ${createHash("sha256").update(data).digest("hex")}` };
    }
    const text = await downloadHf(suite.hf!, f, pause);
    const checked = questionsFromText(id, text, { limit: null });
    if (!checked.ok) return { ok: false, error: `The download was not the ${suite.name} set, so nothing was saved. ${checked.error}` };
    await mkdir(suiteDir(id), { recursive: true });
    await writeFile(suiteFile(id), text);
    const sha = createHash("sha256").update(text).digest("hex");
    await writeFile(
      resolve(suiteDir(id), "SOURCE.txt"),
      `${suite.name}\nDownloaded ${new Date().toISOString()}\nFrom ${suite.hf!.dataset} (config ${suite.hf!.config}, split ${suite.hf!.split}) through the Hugging Face dataset viewer.\n${checked.questions.length} questions, one row per line, as returned.\nSHA-256 of data.jsonl: ${sha}\nLicence: ${suite.license}\n`,
    );
    return { ok: true, message: `${suite.name}: saved ${checked.questions.length} questions to quality/${id}/. SHA-256: ${sha}` };
  } catch (err) {
    return { ok: false, error: `Could not download ${suite.name}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function main(): Promise<number> {
  const arg = process.argv[2] ?? "ifeval";
  const ids: SuiteId[] = arg === "all" ? SUITE_IDS.filter((i) => !SUITES[i].generated) : isSuiteId(arg) ? [arg] : [];
  if (ids.length === 0) {
    console.error(`Unknown test "${arg}". Choose from: ${SUITE_IDS.filter((i) => !SUITES[i].generated).join(", ")}, all.`);
    return 2;
  }
  let status = 0;
  for (const id of ids) {
    const result = await fetchSuite(id);
    if (result.ok) console.log(result.message);
    else {
      console.error(result.error);
      status = 1;
    }
  }
  if (status === 0) console.log("Commit the downloaded files with the NOTICE in the same folder, or leave them out of git: they are large.");
  return status;
}

if (import.meta.main) process.exit(await main());

/**
 * `bun run init` -- writes race.config.json by asking the machines.
 *
 *   bun run init "Mac Studio=http://192.168.1.50:8000" "CMP 170HX=http://192.168.1.51:8000"
 *   bun run init "Studio=http://host:8000" "Box=http://other:8000" --notes "Studio=-c 262144, spec on"
 *   bun run init ... --force        replace an existing race.config.json
 *
 * Each machine is asked for its model id at /v1/models, which is the exact id
 * the race must send. Slots and context are not written: the page asks the
 * machines for those every time, so a restart with different flags is picked up.
 */

import { CONFIG_PATH, validateConfig } from "./config.ts";
import type { Fetcher } from "./lane.ts";

export interface InitLane {
  label: string;
  baseUrl: string;
  notes?: string;
}

/** "host:8000", "http://host:8000/", "http://host:8000/v1" -> "http://host:8000". Null when it cannot be an address. */
export function normalizeAddress(raw: string): string | null {
  const m = /^(https?:\/\/)?(.*)$/i.exec(raw.trim())!;
  const rest = m[2]!.replace(/\/+$/, "").replace(/\/v1$/, "");
  if (rest === "") return null;
  const baseUrl = `${m[1] ?? "http://"}${rest}`;
  try {
    if (!new URL(baseUrl).hostname) return null;
  } catch {
    return null;
  }
  return baseUrl;
}

export function parseLaneArg(arg: string): InitLane | string {
  const eq = arg.indexOf("=");
  if (eq < 1) return `"${arg}" is not Label=http://host:port`;
  const label = arg.slice(0, eq).trim();
  const baseUrl = normalizeAddress(arg.slice(eq + 1));
  if (baseUrl === null) return `"${arg}" does not have a usable address`;
  return { label, baseUrl };
}

/** The id a machine lists first, or why it could not be read. */
export async function readModelId(baseUrl: string, fetchImpl: Fetcher = fetch, timeoutMs = 8000): Promise<{ id: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/models`, { signal: controller.signal });
    if (!response.ok) return { error: `answered HTTP ${response.status} at /v1/models` };
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const id = body.data?.[0]?.id;
    if (typeof id !== "string" || id === "") return { error: "lists no model at /v1/models" };
    return { id };
  } catch (err) {
    return { error: err instanceof Error && err.name === "AbortError" ? "did not answer in time" : "could not be reached" };
  } finally {
    clearTimeout(timer);
  }
}

export async function buildConfig(
  lanes: InitLane[],
  fetchImpl: Fetcher = fetch,
): Promise<{ ok: true; config: unknown } | { ok: false; problems: string[] }> {
  const found = await Promise.all(lanes.map((l) => readModelId(l.baseUrl, fetchImpl)));
  const problems = found.flatMap((f, i) => ("error" in f ? [`${lanes[i]!.label} (${lanes[i]!.baseUrl}) ${f.error}.`] : []));
  if (problems.length > 0) return { ok: false, problems };

  const config = {
    port: 9500,
    maxTokens: 512,
    temperature: 0,
    charsPerToken: 4,
    promptFile: "prompts/sample.txt",
    requestTimeoutMs: 600000,
    preflightTimeoutMs: 30000,
    maxConcurrency: 16,
    lanes: lanes.map((l, i) => ({
      label: l.label,
      baseUrl: l.baseUrl,
      model: (found[i] as { id: string }).id,
      ...(l.notes ? { notes: l.notes } : {}),
    })),
  };
  try {
    validateConfig(config);
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }
  return { ok: true, config };
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const force = argv.includes("--force");
  const notes = new Map<string, string>();
  const laneArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") continue;
    if (a === "--notes") {
      const n = argv[++i] ?? "";
      const eq = n.indexOf("=");
      if (eq > 0) notes.set(n.slice(0, eq).trim(), n.slice(eq + 1).trim());
      continue;
    }
    laneArgs.push(a);
  }

  const lanes: InitLane[] = [];
  for (const a of laneArgs) {
    const parsed = parseLaneArg(a);
    if (typeof parsed === "string") {
      console.error(`\n  ${parsed}\n  Example: bun run init "Mac Studio=http://192.168.1.50:8000" "CMP 170HX=http://192.168.1.51:8000"\n`);
      process.exit(1);
    }
    lanes.push({ ...parsed, notes: notes.get(parsed.label) });
  }
  if (lanes.length < 1 || lanes.length > 4) {
    console.error('\n  Give 1 to 4 machines, each as "Label=http://host:port".\n');
    process.exit(1);
  }

  if ((await Bun.file(CONFIG_PATH).exists()) && !force) {
    console.error(`\n  ${CONFIG_PATH} already exists. Add --force to replace it.\n`);
    process.exit(1);
  }

  const built = await buildConfig(lanes);
  if (!built.ok) {
    console.error("\n  Not written:");
    for (const p of built.problems) console.error(`    ${p}`);
    console.error("");
    process.exit(1);
  }
  await Bun.write(CONFIG_PATH, JSON.stringify(built.config, null, 2) + "\n");
  console.log(`\n  Wrote ${CONFIG_PATH}\n`);
  for (const l of (built.config as { lanes: { label: string; model: string }[] }).lanes) {
    console.log(`    ${l.label.padEnd(14)} ${l.model}`);
  }
  console.log("\n  Start it:  bun run race\n");
}

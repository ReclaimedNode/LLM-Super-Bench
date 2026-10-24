/**
 * `bun run quality` -- asks every machine the questions of one test and scores the answers.
 *
 *   bun run quality --limit 60                              IFEval, 60 questions
 *   bun run quality --suite mmlu-pro --limit 200
 *   bun run quality --suite longctx --sizes 8k,32k,128k
 *   bun run quality --machines "Mac Studio,CMP 170HX" --max-tokens 2048 --thinking off
 *
 * Tests: ifeval, mmlu-pro, mmlu, gsm8k, math500, longctx. A published test needs its questions once:
 * bun run quality:fetch <test>. Writes results/quality-<time>.json.
 * Exit status: 0 when it finished, 1 when it could not, 2 for bad arguments.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setupFor } from "../asked.ts";
import { PROJECT_ROOT, loadConfig } from "../config.ts";
import { baseName } from "../details.ts";
import { readLanesState, withServedModels } from "../lanes.ts";
import { extraBodyFor, parseSettings } from "../settings.ts";
import { laneIdsFor } from "../sweepcli.ts";
import { toolInfo } from "../toolinfo.ts";
import type { RaceConfig } from "../types.ts";
import { DEFAULT_LONGCTX_SIZES, LONGCTX_SIZES, SUITES, SUITE_IDS, isSuiteId, loadSuite } from "./suites.ts";
import type { Suite, SuiteId } from "./suites.ts";
import { runQuality } from "./runner.ts";
import type { MachineQuality } from "./runner.ts";
import type { MachineSetup } from "../details.ts";
import type { PresetId } from "../types.ts";

export interface QualityArgs {
  suite: SuiteId;
  /** Prompt sizes for the long-context test. */
  sizes: PresetId[];
  limit: number | null;
  machines: string[] | null;
  maxTokens: number;
  thinking?: "auto" | "low" | "off";
  streams: number;
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter((s) => s !== "");

export function parseQualityArgs(argv: string[]): { ok: true; args: QualityArgs } | { ok: false; error: string } {
  const args: QualityArgs = { suite: "ifeval", sizes: DEFAULT_LONGCTX_SIZES, limit: null, machines: null, maxTokens: 1024, streams: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "--suite": {
        const v = next() ?? "";
        if (!isSuiteId(v)) return { ok: false, error: `Unknown test "${v}". Choose from: ${SUITE_IDS.join(", ")}.` };
        args.suite = v;
        break;
      }
      case "--sizes": {
        const v = list(next() ?? "");
        const bad = v.find((x) => !(LONGCTX_SIZES as string[]).includes(x));
        if (bad || v.length === 0) return { ok: false, error: `--sizes takes ${LONGCTX_SIZES.join(", ")} (long-context test only).` };
        args.sizes = v as PresetId[];
        break;
      }
      case "--limit": args.limit = Number(next()); break;
      case "--machines": args.machines = list(next() ?? ""); break;
      case "--max-tokens": args.maxTokens = Number(next()); break;
      case "--thinking": args.thinking = next() as QualityArgs["thinking"]; break;
      case "--streams": args.streams = Number(next()); break;
      default: return { ok: false, error: `Unknown option ${a}. Options: --suite, --sizes, --limit, --machines, --max-tokens, --thinking, --streams.` };
    }
  }
  const cap = SUITES[args.suite].of;
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1 || (cap !== null && args.limit > cap))) {
    return { ok: false, error: `--limit must be a whole number from 1${cap !== null ? ` to ${cap}` : ""}.` };
  }
  if (SUITES[args.suite].generated && args.limit !== null) return { ok: false, error: "--limit does not apply to the long-context test; choose sizes with --sizes." };
  if (!Number.isInteger(args.streams) || args.streams < 1 || args.streams > 16) return { ok: false, error: "--streams must be a whole number from 1 to 16." };
  const s = parseSettings({ maxTokens: args.maxTokens, ...(args.thinking !== undefined ? { thinking: args.thinking } : {}) });
  if (!s.ok) return { ok: false, error: s.error };
  return { ok: true, args };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export interface QualityFile {
  format: "llm-super-bench-quality";
  version: 1;
  createdAt: string;
  benchmark: {
    id: SuiteId;
    name: string;
    source: string;
    paper?: string;
    license: string;
    questions: number;
    /** Questions in the full published set, or null when they are generated. */
    of: number | null;
    /** Prompt sizes, for the long-context test. */
    sizes?: string[];
  };
  settings: { maxTokens: number; thinking: "auto" | "low" | "off"; temperature: 0 };
  tool?: { version: string; commit: string | null };
  machines: {
    id: string;
    label: string;
    model: string;
    setup: MachineSetup | null;
    watts?: number;
    result: MachineQuality;
  }[];
}

export function buildQualityFile(o: {
  suite: Suite;
  sizes?: PresetId[];
  config: RaceConfig;
  setups: Record<string, MachineSetup>;
  results: MachineQuality[];
  questions: number;
  maxTokens: number;
  thinking: "auto" | "low" | "off";
  tool?: QualityFile["tool"];
  now?: Date;
}): QualityFile {
  return {
    format: "llm-super-bench-quality",
    version: 1,
    createdAt: (o.now ?? new Date()).toISOString(),
    benchmark: {
      id: o.suite.id,
      name: o.suite.name,
      source: o.suite.source,
      ...(o.suite.paper ? { paper: o.suite.paper } : {}),
      license: o.suite.license,
      questions: o.questions,
      of: o.suite.of,
      ...(o.suite.generated && o.sizes ? { sizes: o.sizes } : {}),
    },
    settings: { maxTokens: o.maxTokens, thinking: o.thinking, temperature: 0 },
    ...(o.tool ? { tool: o.tool } : {}),
    machines: o.results.map((r) => {
      const i = Number(r.laneId.replace("lane-", ""));
      const lane = o.config.lanes[i]!;
      return {
        id: r.laneId,
        label: lane.label,
        model: baseName(lane.displayModel ?? lane.model),
        setup: o.setups[r.laneId] ?? null,
        ...(lane.watts !== undefined ? { watts: lane.watts } : {}),
        result: r,
      };
    }),
  };
}

export function formatTable(file: QualityFile): string {
  const ifeval = file.benchmark.id === "ifeval";
  const rows = [["MACHINE", ifeval ? "PROMPTS RIGHT (STRICT)" : "RIGHT (STRICT)", "LOOSE", ...(ifeval ? ["RULES RIGHT"] : []), "NO REPLY", "CUT OFF", "ONLY THINKING"]];
  for (const m of file.machines) {
    const r = m.result;
    rows.push([m.label, pct(r.score.promptStrict), pct(r.score.promptLoose), ...(ifeval ? [pct(r.score.ruleStrict)] : []), String(r.errors), String(r.truncated), String(r.thinkingOnly)]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ")).join("\n");
}

/** How each kind of question went, one row per kind, one column per machine. Empty for IFEval, which has 25 kinds. */
export function formatGroups(file: QualityFile): string {
  if (file.benchmark.id === "ifeval") return "";
  const kinds = [...new Set(file.machines.flatMap((m) => Object.keys(m.result.byRule)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (kinds.length <= 1) return "";
  const head = ["KIND", ...file.machines.map((m) => m.label)];
  const rows = [head, ...kinds.map((k) => [k, ...file.machines.map((m) => {
    const e = m.result.byRule[k];
    return e ? `${pct(e.strict / e.total)} (${e.strict}/${e.total})` : "-";
  })])];
  const widths = head.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c]!)).join("  ")).join("\n");
}

async function main(): Promise<number> {
  const parsed = parseQualityArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { args } = parsed;
  const suite = SUITES[args.suite];
  const loaded = await loadConfig();
  const built = await loadSuite(args.suite, { limit: args.limit, sizes: args.sizes, charsPerToken: loaded.config.charsPerToken });
  if (!built.ok) {
    console.error(built.error);
    return 1;
  }
  const questions = built.questions;
  if (loaded.usedExample) console.error("No race.config.json yet, so this would ask the example mock machines. Add your machines first.");
  const config: RaceConfig = { ...loaded.config, ...(args.thinking !== undefined ? { thinking: args.thinking } : {}), maxTokens: args.maxTokens };
  const picked = laneIdsFor(config, args.machines);
  if (!picked.ok) {
    console.error(picked.error);
    return 2;
  }
  const served = withServedModels(config, await readLanesState());
  const asked = await setupFor(served, picked.ids);
  const thinking = config.thinking ?? "auto";
  console.log(`Asking ${picked.ids.length} machine(s) ${questions.length} ${suite.name} question(s), ${args.streams} at a time each. Reply limit ${args.maxTokens} tokens, thinking ${thinking}.`);
  const results = await runQuality({
    lanes: picked.ids.map((laneId) => {
      const lane = served.lanes[Number(laneId.replace("lane-", ""))]!;
      return { laneId, lane, extraBody: extraBodyFor(lane, thinking, asked.setups[laneId]?.engine ?? lane.engine) };
    }),
    questions,
    maxTokens: args.maxTokens,
    streams: args.streams,
    timeoutMs: 300_000,
    onProgress: (laneId, done, total) => {
      if (done === total || done % 10 === 0) console.log(`  ${served.lanes[Number(laneId.replace("lane-", ""))]!.label}: ${done}/${total}`);
    },
  });
  const file = buildQualityFile({ suite, sizes: args.sizes, config: served, setups: asked.setups, results, questions: questions.length, maxTokens: args.maxTokens, thinking, tool: await toolInfo() });
  const stamp = file.createdAt.replace(/[:.]/g, "-");
  await mkdir(resolve(PROJECT_ROOT, "results"), { recursive: true });
  await writeFile(resolve(PROJECT_ROOT, `results/quality-${stamp}.json`), JSON.stringify(file, null, 2) + "\n");
  console.log("\n" + formatTable(file));
  console.log(`\nSaved results/quality-${stamp}.json.`);
  const groups = formatGroups(file);
  if (groups) console.log("\n" + groups);
  console.log(`\n${suite.name}. Source: ${suite.source}. Licence: ${suite.license}.`);
  console.log("A model with a short reply limit can lose points just for running out of room: see CUT OFF. Say which test and how many questions whenever you publish a score.");
  return results.every((r) => r.answered > 0) ? 0 : 1;
}

if (import.meta.main) process.exit(await main());

/**
 * `bun run sweep` -- the same sweep the page runs, from the command line, so it can run overnight on
 * a headless machine from a schedule with no browser open. It writes the same run file the page
 * does (results/run-sweep-<time>.json) plus the CSV, then prints a short table.
 *
 *   bun run sweep
 *   bun run sweep --sizes short,4k,16k --streams 1,2,4 --repeats 3
 *   bun run sweep --machines "Mac Studio,CMP 170HX" --thinking low --max-tokens 1024
 *
 * Exit status: 0 when the sweep finished, 1 when it stopped early or failed, 2 for bad arguments.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setupFor } from "./asked.ts";
import { PROJECT_ROOT, loadConfig, loadPromptSource } from "./config.ts";
import { readLanesState, withServedModels } from "./lanes.ts";
import { PRESET_IDS } from "./prompt.ts";
import { buildRunFile } from "./runfile.ts";
import { saveRun } from "./runstore.ts";
import { parseSettings } from "./settings.ts";
import { parseSweepRequest, runSweep } from "./sweep.ts";
import { toolInfo } from "./toolinfo.ts";
import type { RaceConfig } from "./types.ts";

export interface SweepArgs {
  presets: string[];
  concurrencies: number[];
  repeats: number;
  warmup: boolean;
  machines: string[] | null;
  maxTokens?: number;
  thinking?: "auto" | "low" | "off";
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter((s) => s !== "");

/** Turns the command line into a sweep. Pure, so it can be tested. */
export function parseSweepArgs(argv: string[]): { ok: true; args: SweepArgs } | { ok: false; error: string } {
  const args: SweepArgs = { presets: ["short", "4k"], concurrencies: [1], repeats: 1, warmup: true, machines: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    switch (a) {
      case "--sizes": args.presets = list(next() ?? ""); break;
      case "--streams": args.concurrencies = list(next() ?? "").map(Number); break;
      case "--repeats": args.repeats = Number(next()); break;
      case "--machines": args.machines = list(next() ?? ""); break;
      case "--no-warmup": args.warmup = false; break;
      case "--max-tokens": args.maxTokens = Number(next()); break;
      case "--thinking": args.thinking = next() as SweepArgs["thinking"]; break;
      default: return { ok: false, error: `Unknown option ${a}. Options: --sizes, --streams, --repeats, --machines, --no-warmup, --max-tokens, --thinking.` };
    }
  }
  const badSize = args.presets.find((p) => !(PRESET_IDS as string[]).includes(p));
  if (badSize) return { ok: false, error: `Unknown prompt size "${badSize}". Choose from ${PRESET_IDS.join(", ")}.` };
  if (args.maxTokens !== undefined || args.thinking !== undefined) {
    const s = parseSettings({ ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}), ...(args.thinking !== undefined ? { thinking: args.thinking } : {}) });
    if (!s.ok) return { ok: false, error: s.error };
  }
  return { ok: true, args };
}

/** The machines by name, to the ids the sweep uses. */
export function laneIdsFor(config: Pick<RaceConfig, "lanes">, names: string[] | null): { ok: true; ids: string[] } | { ok: false; error: string } {
  const all = config.lanes.map((l, i) => ({ id: `lane-${i}`, label: l.label }));
  if (names === null) return { ok: true, ids: all.map((l) => l.id) };
  const missing = names.filter((n) => !all.some((l) => l.label.toLowerCase() === n.toLowerCase()));
  if (missing.length > 0) return { ok: false, error: `No machine called ${missing.map((m) => `"${m}"`).join(", ")}. Saved machines: ${all.map((l) => l.label).join(", ")}.` };
  return { ok: true, ids: all.filter((l) => names.some((n) => n.toLowerCase() === l.label.toLowerCase())).map((l) => l.id) };
}

async function main(): Promise<number> {
  const parsed = parseSweepArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { args } = parsed;
  const loaded = await loadConfig();
  if (loaded.usedExample) console.error("No race.config.json yet, so this would sweep the example mock machines. Add your machines first (bun run init, or the page).");
  const config: RaceConfig = {
    ...loaded.config,
    ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    ...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
  };
  const picked = laneIdsFor(config, args.machines);
  if (!picked.ok) {
    console.error(picked.error);
    return 2;
  }
  const request = parseSweepRequest(
    { lanes: picked.ids, presets: args.presets, concurrencies: args.concurrencies, repeats: args.repeats, warmup: args.warmup },
    { laneIds: config.lanes.map((_, i) => `lane-${i}`), maxConcurrency: config.maxConcurrency ?? 16 },
  );
  if (!request.ok) {
    console.error(request.error);
    return 2;
  }
  let sourceText = "";
  try {
    sourceText = await loadPromptSource(config);
  } catch (err) {
    if (request.request.presets.some((p) => p !== "short")) {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    }
  }

  const raceConfig = withServedModels(config, await readLanesState());
  const asked = await setupFor(raceConfig, request.request.laneIds);
  const tool = await toolInfo();
  let finishedOk = false;
  let saving: Promise<void> = Promise.resolve();

  await runSweep({
    config: raceConfig,
    sourceText,
    request: request.request,
    laneSlots: Math.max(...request.request.concurrencies) > 1 ? asked.slots : {},
    laneSetups: asked.setups,
    emit: (event) => {
      if (event.type === "sweep-warmup") console.log("Warm-up race (not counted)...");
      if (event.type === "sweep-progress") console.log(`[${event.index}/${event.total}] ${event.preset}, ${event.concurrency} stream(s), run ${event.repeat}/${event.repeats}`);
      if (event.type !== "sweep-done") return;
      finishedOk = event.complete;
      saving = (async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await mkdir(resolve(PROJECT_ROOT, "results"), { recursive: true });
        await writeFile(resolve(PROJECT_ROOT, `results/sweep-${stamp}.csv`), event.csv);
        const name = await saveRun(
          buildRunFile({
            kind: "sweep",
            rows: event.rows,
            lanes: raceConfig.lanes.map((l, i) => ({ laneId: `lane-${i}`, label: l.label, displayModel: l.displayModel, model: l.model, ...(l.watts !== undefined ? { watts: l.watts } : {}) })),
            setups: asked.setups,
            maxTokens: raceConfig.maxTokens,
            thinking: raceConfig.thinking,
            tool,
            complete: event.complete,
          }),
        );
        console.log(`\n${event.complete ? "Sweep finished." : "Sweep ended early; the table covers the races that finished."}`);
        console.log(`Saved results/sweep-${stamp}.csv${name ? ` and results/${name}` : ""}.`);
        console.log("Open the page and press VIEW CHARTS, or load the .json on the results page.");
      })();
    },
  });
  await saving;
  return finishedOk ? 0 : 1;
}

if (import.meta.main) process.exit(await main());

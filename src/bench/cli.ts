/**
 * `bun run bench` -- run the grid.
 * `bun run bench --plan` -- print what would run, and run nothing.
 *
 *   bun run bench --plan
 *   bun run bench
 *   bun run bench --run 20260919-1400 --force
 */

import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { ConfigError, loadBenchConfig } from "./config.ts";
import { checkSleep } from "./awake.ts";
import { buildGrid, cellName, estimateGridSeconds, estimateLaneSeconds, formatDuration, keyOfCell, resumePlan } from "./plan.ts";
import { modelKeyIndex } from "./config.ts";
import type { ResumeDecision } from "./plan.ts";
import { refreshReport } from "./report.ts";
import { startProgressServer } from "./progress.ts";
import { runGrid } from "./runner.ts";
import { defaultRunName, ensureRunDir, latestRun, readRuns, runDir } from "./store.ts";
import type { BenchConfig } from "./types.ts";

interface Args {
  plan: boolean;
  force: boolean;
  runName: string | null;
  configPath: string | null;
  holdSeconds: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
  };
  const hold = value("--hold");
  return {
    plan: argv.includes("--plan"),
    force: argv.includes("--force"),
    runName: value("--run"),
    configPath: value("--config"),
    holdSeconds: hold === null ? 15 : Math.max(0, Number(hold) || 0),
    help: argv.includes("--help") || argv.includes("-h"),
  };
}

const HELP = `
  bun run bench [options]

    --plan          print every cell that would run, and run nothing
    --run <name>    use (or resume) this run folder instead of a new one
    --config <path> use this config instead of bench.config.json
    --force         re-run cells that already have their runs on disk
    --hold <sec>    keep the progress page up this long after the grid ends (default 15)
    --help          this

  Config: bench.config.json, or bench.config.example.json when there is none.
`;

async function loadSource(config: BenchConfig): Promise<string> {
  const path = resolve(PROJECT_ROOT, config.promptFile);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`Prompt file not found: ${path}. Drop a text file in prompts/ and set promptFile.`);
  }
  return await file.text();
}

// ------------------------------------------------------------------ --plan

function printPlan(config: BenchConfig, decisionsByLane: Map<string, ResumeDecision[]>, runName: string): void {
  const grid = buildGrid(config);
  const lines: string[] = ["", `  PLAN — run "${runName}"`, ""];

  for (const lane of grid.lanes) {
    const decisions = decisionsByLane.get(lane.laneLabel) ?? [];
    const byKey = new Map(decisions.map((d) => [keyOfCell(d.cell), d]));
    const owed = decisions.filter((d) => !d.skip).reduce((n, d) => n + d.remaining, 0);
    const laneSec = estimateLaneSeconds(lane, decisions, config);

    lines.push(
      `  ${lane.laneLabel}  [${lane.managed ? "managed — the runner starts and stops the server" : "manual — load each model yourself"}]`,
      `    ${lane.cells.length} cells, ${owed} runs to do, roughly ${formatDuration(laneSec)}`,
      "",
    );

    let model = "";
    for (const cell of lane.cells) {
      if (cell.modelName !== model) {
        model = cell.modelName;
        lines.push(`    ${model}`);
      }
      const d = byKey.get(keyOfCell(cell));
      const state = d?.skip
        ? `skip — ${d.done} runs already on disk`
        : `${d?.remaining ?? cell.measuredRuns} run(s)${d && d.done > 0 ? ` (${d.done} already done)` : ""}`;
      lines.push(
        `      ${cell.nominalLabel.padEnd(6)} ${String(cell.nominalTokens).padStart(7)} tokens  ` +
          `${cell.torture ? "torture  " : "         "}${state}`,
      );
    }
    lines.push("");
  }

  const total = estimateGridSeconds(grid, decisionsByLane, config);
  lines.push(
    `  ${grid.totalCells} cells across ${grid.lanes.length} lanes. Lanes run at the same time, so the grid`,
    `  takes as long as its slowest lane: roughly ${formatDuration(total)}.`,
    "",
    `  Rough means rough: it assumes a generation speed the run has not measured yet.`,
    `  Warm-up ${config.warmupRuns} run(s) per cell, ${config.measuredRuns} measured, ${config.restSeconds}s rest between cells,`,
    `  ${config.outputCap}-token output cap.`,
    "",
  );
  console.log(lines.join("\n"));
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const loaded = await loadBenchConfig(args.configPath ?? undefined);
  const config = loaded.config;

  // A named run resumes; an unnamed one resumes the config's runName, or makes
  // a new folder. Resuming by accident would be worse than starting twice, so
  // the run name is always printed.
  const runName = args.runName ?? config.runName ?? (await latestUnfinished(config)) ?? defaultRunName();

  const grid = buildGrid(config);
  const existing = await readRuns(runName);
  const index = modelKeyIndex(config);
  const decisionsByLane = new Map(
    grid.lanes.map((lane) => [lane.laneLabel, resumePlan(lane.cells, existing, args.force, index)] as const),
  );

  if (args.plan) {
    console.log(
      `\n  Config: ${loaded.path}${loaded.usedExample ? "\n          (no bench.config.json yet — using the example, which points at the mock lanes)" : ""}`,
    );
    printPlan(config, decisionsByLane, runName);
    // Read-only, and only for lanes the runner manages: a machine set to sleep
    // in a minute is worth knowing about before a grid that runs for hours.
    const warnings = (
      await Promise.all(
        config.lanes
          .filter((lane) => lane.ssh)
          .map((lane) => checkSleep(lane.ssh!, undefined, 15_000).then((r) => (r.warning ? `${lane.label}: ${r.warning}` : null))),
      )
    ).filter((w): w is string => w !== null);
    if (warnings.length > 0) console.log(`  ${warnings.join("\n\n  ")}\n`);
    return;
  }

  const sourceText = await loadSource(config);
  await ensureRunDir(runName);

  const progress = startProgressServer(config.progressPort);
  console.log(`
  BENCHMARK

    progress   http://localhost:${progress.server.port}
    results    ${runDir(runName)}
    config     ${loaded.path}${loaded.usedExample ? "  (the example — mock lanes)" : ""}
`);

  const signal = { aborted: false };
  const onSignal = () => {
    if (signal.aborted) process.exit(1);
    signal.aborted = true;
    console.log("\n  Stopping after the run in flight. Everything finished is already on disk.\n");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  // The page is not the only place this run reports to. A grid can fail on a
  // machine nobody is watching a browser for, and the first time this one did,
  // the terminal said nothing at all and working out why cost an ssh session.
  const emit = (event: Parameters<typeof progress.emit>[0]): void => {
    progress.emit(event);
    if (event.type === "note") {
      const mark = event.kind === "error" ? "!!" : event.kind === "warn" ? " !" : "  ";
      console.log(`  ${mark} ${event.laneLabel ? `${event.laneLabel}: ` : ""}${event.message}`);
    }
    if (event.type === "cell" && event.stat.status !== "ok") {
      console.log(
        `   ! ${event.stat.laneLabel} ${event.stat.nominalLabel}: ${event.stat.status} ` +
          `(${event.stat.runsUsed} of ${event.stat.runsRecorded} runs used)`,
      );
    }
  };

  try {
    await runGrid({ config, runName, sourceText, emit, force: args.force, signal });
    const markdown = await refreshReport(runName);
    console.log(`  Wrote ${runDir(runName)}/report.md`);
    if (markdown) console.log(`  Board: bun run board ${runName}\n`);
  } finally {
    if (args.holdSeconds > 0) {
      console.log(`  Holding the progress page for ${args.holdSeconds}s (--hold 0 to skip).`);
      await new Promise((r) => setTimeout(r, args.holdSeconds * 1000));
    }
    progress.stop();
  }
}

/** The most recent run folder that still has cells owed, if any. */
async function latestUnfinished(config: BenchConfig): Promise<string | null> {
  const latest = await latestRun();
  if (latest === null) return null;
  const grid = buildGrid(config);
  const records = await readRuns(latest);
  if (records.length === 0) return null;
  const owed = grid.lanes.some((lane) =>
    resumePlan(lane.cells, records, false, modelKeyIndex(config)).some((d) => !d.skip),
  );
  return owed ? latest : null;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

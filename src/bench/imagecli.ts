/**
 * `bun run imagebench` -- the image generation grid.
 *
 *   bun run imagebench --plan
 *   bun run imagebench
 *   bun run imagebench --run my-run --force
 */

import { ConfigError, loadBenchConfig } from "./config.ts";
import { imageSettingsFrom, planImageGrid } from "./image.ts";
import { runImageGrid } from "./imagerunner.ts";
import { defaultRunName, ensureRunDir, latestRun, runDir } from "./store.ts";

const HELP = `
  bun run imagebench [options]

    --plan             print the grid and the settings, and run nothing
    --run <name>       use (or resume) this run folder
    --config <path>    use this config instead of bench.config.json
    --force            re-do cells that already have their images
    --help             this

  One warm-up image then N measured ones per lane per model, from the same
  prompt, seed, size and step count everywhere. The number reported is the
  seconds to make one image with the model already loaded; the weight load is
  timed separately and never folded in.
`;

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };

  const loaded = await loadBenchConfig(value("--config"));
  const settings = imageSettingsFrom(loaded.config, loaded.config.image);
  const plan = planImageGrid(loaded.config, settings);

  console.log(`\n  Config: ${loaded.path}${loaded.usedExample ? "  (the example)" : ""}`);

  if (plan.totalCells === 0) {
    console.log(`
  Nothing to do: no managed lane has a model with "kind": "image".

  Add one to the config, e.g.
    { "name": "Z-Image Turbo", "dir": "Z-Image-Turbo", "kind": "image",
      "hfRepo": "Tongyi-MAI/Z-Image-Turbo", "approxGb": 16 }

  and run \`bun run setup-lane <lane>\` so the machine has mflux and the weights.
`);
    for (const u of plan.unsupported) console.log(`    ${u.modelName}: ${u.why}`);
    return;
  }

  const runName = value("--run") ?? loaded.config.runName ?? (await latestRun()) ?? defaultRunName();

  console.log(`
  IMAGE BENCHMARK

    run        ${runName}
    prompt     ${settings.prompt}
    seed       ${settings.seed}   size ${settings.width}x${settings.height}   steps ${settings.steps ?? "mflux's default for each model"}
    images     ${settings.warmupImages} warm-up + ${settings.measuredImages} measured per cell, ${settings.restSeconds}s rest between cells
    cells      ${plan.totalCells} across ${plan.lanes.length} managed lane(s)
`);
  for (const lane of plan.lanes) {
    console.log(`    ${lane.lane.label}: ${lane.cells.map((c) => `${c.modelName} (${c.kind})`).join(", ")}`);
  }
  for (const u of plan.unsupported) console.log(`    skipping ${u.modelName}: ${u.why}`);
  console.log("");

  if (argv.includes("--plan")) return;

  await ensureRunDir(runName);

  const cells = await runImageGrid({
    plan,
    runName,
    force: argv.includes("--force"),
    emit: (event) => {
      if (event.type === "note") {
        const mark = event.kind === "error" ? "!!" : event.kind === "warn" ? " !" : "  ";
        console.log(`  ${mark} ${event.laneLabel ? `${event.laneLabel}: ` : ""}${event.message}`);
      } else if (event.type === "cell-start") {
        console.log(`  -- ${event.cell.laneLabel} · ${event.cell.modelName}`);
      } else if (event.type === "image" && !event.record.warmup) {
        console.log(`     image ${event.record.runIndex}: ${event.record.seconds?.toFixed(2)}s`);
      }
    },
  });

  console.log("");
  for (const cell of cells) {
    const speed = cell.secondsPerImage;
    console.log(
      `  ${cell.laneLabel} · ${cell.modelName}: ` +
        (speed
          ? `${speed.median.toFixed(2)}s per image (${speed.low.toFixed(2)}–${speed.high.toFixed(2)}), ` +
            `load ${cell.loadSeconds?.toFixed(1) ?? "?"}s` +
            (cell.peakMemoryGb ? `, peak ${cell.peakMemoryGb.toFixed(1)} GB` : "")
          : `no usable images (${cell.status})`),
    );
    for (const note of cell.notes) console.log(`      ${note}`);
  }
  console.log(`\n  Results in ${runDir(runName)}\n  Board: bun run board ${runName}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

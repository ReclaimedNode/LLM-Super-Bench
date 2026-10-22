/**
 * `bun run draw "<prompt>"` -- the thing that happens on camera.
 *
 * One prompt goes to every Mac at the same moment, each one draws a single
 * picture, the pictures come back here and open on the screen, and the
 * seconds are printed side by side. This file does the talking and the
 * printing only: the parsing, the command, the names and the verdict all live
 * in draw.ts, where they can be tested without a Mac in the room.
 */

import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { ConfigError, loadBenchConfig } from "./config.ts";
import {
  DrawError,
  drawExitCode,
  drawLanes,
  drawRunDir,
  laneReport,
  openArgs,
  parseDrawArgs,
  runDraw,
  verdictLine,
} from "./draw.ts";
import { defaultRunName } from "./store.ts";

const HELP = `
  bun run draw "<prompt>" [options]

    --model flux|zimage   which image model draws it (default flux)
    --lane "<label>"      draw on this lane only; repeat it for more than one
    --seed <number>       the seed every lane draws with (default 42)
    --no-open             leave the pictures on disk instead of opening them
    --help                this

  One prompt goes to every Mac in bench.config.json at the same moment. Each
  one draws a single 1024x1024 picture with a model it already has, the
  pictures come back to results/draw and open here, and the seconds each
  machine took are printed with a line comparing them.

  Both Macs draw at once, so these seconds are a show, not a measurement: each
  machine is working while the other one is. The honest number comes from
  \`bun run imagebench\`, which uses one machine at a time, throws the first
  picture away and measures five more.
`;

async function main(): Promise<void> {
  const args = parseDrawArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const loaded = await loadBenchConfig();
  const lanes = drawLanes(loaded.config, args.lanes);
  const stamp = defaultRunName();
  const shimSource = await Bun.file(resolve(PROJECT_ROOT, "remote/mflux_bench.py")).text();

  console.log(`
  DRAW

    prompt     ${args.prompt}
    model      ${args.model.name}
    seed       ${args.seed}   size 1024x1024, one picture each
    machines   ${lanes.map((l) => l.lane.label).join(", ")}

  All of them start now, so the seconds below are for the camera. The honest
  one-at-a-time measurement is \`bun run imagebench\`.
`);

  const results = await runDraw({
    lanes,
    model: args.model,
    prompt: args.prompt,
    seed: args.seed,
    stamp,
    shimSource,
    log: (label, message) => console.log(`  .. ${label}: ${message}`),
  });

  console.log("");
  for (const result of results) {
    for (const line of laneReport(result)) console.log(line);
    console.log("");
  }

  const verdict = verdictLine(results);
  if (verdict) console.log(`  ${verdict}\n`);

  const pictures = results.map((r) => r.localPath).filter((p): p is string => p !== null);
  if (args.open && pictures.length > 0) {
    // Waited on, because the failure path below exits at once and `open` has
    // to have handed the pictures to the window server before that happens.
    await Bun.spawn(openArgs(pictures), { stdout: "ignore", stderr: "ignore" }).exited;
  }
  if (pictures.length > 0) console.log(`  Pictures in ${drawRunDir(stamp)}\n`);

  const code = drawExitCode(results);
  if (code !== 0) {
    const failed = results.filter((r) => !r.ok).map((r) => r.label);
    console.log(`  ${failed.join(" and ")} did not draw anything. The rest did.\n`);
    process.exit(code);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof DrawError || err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

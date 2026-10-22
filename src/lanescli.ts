/**
 * `bun run lanes up | down | status`
 *
 * Starts and stops the model servers the race page talks to, reading the
 * machines out of race.config.json so there is one place the addresses live.
 */

import { CONFIG_PATH, EXAMPLE_CONFIG_PATH } from "./config.ts";
import {
  LANE_MODEL_ORDER,
  LanesError,
  STATE_PATH,
  bringLanesUp,
  laneModelFor,
  laneModelPath,
  lanesStatus,
  readLanesState,
  takeLanesDown,
  targetsFromRaceConfig,
} from "./lanes.ts";
import type { LaneModel } from "./lanes.ts";

const HELP = `
  bun run lanes up        start a model server on every lane in race.config.json
  bun run lanes down      stop exactly what \`up\` started, by pid
  bun run lanes status    what is running now, and what each endpoint is serving

  bun run lanes up --model <key>   start every lane on that model instead,
                                   for this session -- race.config.json is not
                                   touched. The keys:

    ${LANE_MODEL_ORDER.join("  ")}

  Each key is a folder every lane machine carries under bench-models, so one
  key starts the same weights on both. What \`up\` started is written down, and
  the race page reads it on every load: \`lanes down\`, \`lanes up --model 14b\`,
  reload, and the lane headers say the new model with \`bun run race\` left
  running the whole time.

  The host and port come from each lane's baseUrl, the model from its \`model\`,
  and the binaries from ~/bench-envs/llm/bin unless the lane says otherwise.
  Every server binds 0.0.0.0, runs with the prompt cache off and thinking off,
  writes to a log on its own machine, and is held awake while it serves.

  A lane is not up until its endpoint LISTS the model the race will ask for.
  One that never does is stopped again rather than left half-started.
`;

async function readRaceConfig(): Promise<{ raw: unknown; path: string; usedExample: boolean }> {
  const real = Bun.file(CONFIG_PATH);
  if (await real.exists()) return { raw: await real.json(), path: CONFIG_PATH, usedExample: false };
  const example = Bun.file(EXAMPLE_CONFIG_PATH);
  if (!(await example.exists())) throw new LanesError("No race.config.json and no example to fall back on.");
  return { raw: await example.json(), path: EXAMPLE_CONFIG_PATH, usedExample: true };
}

interface LanesArgs {
  command: string;
  help: boolean;
  /** Null when nobody said --model, so every lane keeps the config's model. */
  model: LaneModel | null;
}

function parseLanesArgs(argv: string[]): LanesArgs {
  let command = "";
  let help = false;
  let model: LaneModel | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--model") {
      // A flag with nothing after it, or another flag after it, is somebody who
      // meant to change the model -- so it is refused by name rather than read
      // as no flag at all. The key is looked up here, before anything starts.
      const next = argv[i + 1];
      const value = next === undefined || next.startsWith("--") ? undefined : next;
      model = laneModelFor(value);
      if (value !== undefined) i++;
      continue;
    }

    if (arg.startsWith("-")) throw new LanesError(`I do not know the option ${arg}. Run bun run lanes --help.`);
    if (command === "") command = arg;
  }

  return { command, help, model };
}

async function main(): Promise<void> {
  try {
    const { command, help, model } = parseLanesArgs(Bun.argv.slice(2));

    if (command === "" || help) {
      console.log(HELP);
      return;
    }

    if (model !== null && command !== "up") {
      throw new LanesError(`--model only means anything to \`lanes up\`, and this is \`lanes ${command}\`.`);
    }

    if (command === "up") {
      const { raw, path, usedExample } = await readRaceConfig();
      const targets = targetsFromRaceConfig(raw, model);
      console.log(`\n  Config: ${path}${usedExample ? "  (the example — mock lanes)" : ""}`);
      console.log(
        model === null
          ? `  Model:  each lane's own, from that config\n`
          : `  Model:  ${model.displayModel} on every lane, for this session only\n          ${laneModelPath(model)}\n`,
      );
      for (const label of targets.local) {
        console.log(`  ${label} is on this Mac, so there is nothing to start over ssh (that is \`bun run mock\`).`);
      }
      if (targets.lanes.length === 0) {
        console.log(`\n  No remote lanes in that config.\n`);
        return;
      }

      console.log(`  Starting ${targets.lanes.length} lane(s). A big model takes a minute to load.\n`);
      const report = await bringLanesUp({ targets, log: (m) => console.log(m) });

      console.log("");
      for (const result of report.results) {
        console.log(`  ${result.ok ? "UP  " : "FAIL"} ${result.label}: ${result.detail}`);
      }
      if (report.state) {
        console.log(`\n  Recorded in ${STATE_PATH}. Stop them with \`bun run lanes down\`.`);
      }
      const failed = report.results.filter((r) => !r.ok);
      console.log(
        failed.length > 0
          ? `\n  ${failed.length} lane(s) did not come up. Nothing was left running for those.\n`
          : model === null
            ? `\n  Both endpoints are serving what race.config.json asks for. Start the page with \`bun run race\`.\n`
            : `\n  Both endpoints are serving ${model.displayModel}. Reload the race page and the lane\n` +
              `  headers will say so; \`bun run race\` does not need restarting.\n`,
      );
      if (failed.length > 0) process.exit(1);
      return;
    }

    if (command === "down") {
      const results = await takeLanesDown({ log: (m) => console.log(m) });
      console.log("");
      for (const result of results) console.log(`  ${result.label}: ${result.detail}`);
      const clean = results.every((r) => r.serverStopped && r.awakeStopped !== false);
      console.log(
        clean
          ? `\n  Both machines are clear of what this started. Nothing else was touched.\n`
          : `\n  Something did not confirm stopped; the record is kept so it is not forgotten.\n`,
      );
      if (!clean) process.exit(1);
      return;
    }

    if (command === "status") {
      const state = await readLanesState();
      if (state === null) {
        console.log(`\n  No lanes recorded as up.\n`);
        return;
      }
      const rows = await lanesStatus();
      console.log("");
      for (const row of rows) {
        console.log(
          `  ${row.label}  pid ${row.serverPid}  ${row.running ? "running" : "NOT running"}  ` +
            `${row.displayModel}  ` +
            `${row.ready ? "serving the model the race asks for" : `serving: ${row.serving?.join(", ") ?? "no answer"}`}`,
        );
      }
      console.log("");
      return;
    }

    console.log(HELP);
  } catch (err) {
    if (err instanceof LanesError) {
      console.error(`\n  ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.main) await main();

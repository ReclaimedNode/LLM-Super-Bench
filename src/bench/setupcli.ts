/**
 * `bun run setup-lane <lane label>` -- prepare a machine to be a lane.
 *
 *   bun run setup-lane "Studio"
 *   bun run setup-lane "Studio" --plan     # say what it would do, do nothing
 *
 * Safe to run twice: every step checks before it acts, and the last thing it
 * does is read the machine back and say what is really there.
 */

import { loadBenchConfig, ConfigError } from "./config.ts";
import { SetupError, planLaneSetup, runLaneSetup, envBinDir } from "./setup.ts";
import { renderPlan, renderReport, verificationMatchesPlan } from "./setupreport.ts";

const HELP = `
  bun run setup-lane <lane label> [options]

    --plan             print what it would do on that machine, and do nothing
    --config <path>    use this config instead of bench.config.json
    --help             this

  Prepares a managed lane so every machine matches: uv, pinned environments
  under ~/bench-envs, and every model at ~/bench-models/<dir>. Run it as often
  as you like -- it only changes what is not already right.
`;

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }

  const flagValues = new Set(["--config"].flatMap((f) => (argv.indexOf(f) !== -1 ? [argv[argv.indexOf(f) + 1]] : [])));
  const laneLabel = argv.find((a) => !a.startsWith("--") && !flagValues.has(a));
  if (!laneLabel) {
    console.error(`\n  Which lane? Give its label, e.g. bun run setup-lane "Studio".\n${HELP}`);
    process.exit(1);
  }

  const configFlag = argv.indexOf("--config");
  const configPath = configFlag !== -1 ? argv[configFlag + 1] : undefined;
  const loaded = await loadBenchConfig(configPath);
  const plan = planLaneSetup(loaded.config, laneLabel);

  console.log(`\n  Config: ${loaded.path}${loaded.usedExample ? "  (the example)" : ""}`);

  if (argv.includes("--plan")) {
    console.log(renderPlan(plan));
    return;
  }

  console.log(renderPlan(plan));
  console.log("  Working. Downloads can take a while; nothing is repeated that is already in place.\n");

  const report = await runLaneSetup({
    plan,
    onStep: (step) => {
      const mark = step.status === "failed" ? "!!" : step.status === "did" ? " +" : "  ";
      console.log(`  ${mark} ${step.what}: ${step.detail}`);
    },
  });

  console.log(renderReport(report, plan));

  if (report.verification) {
    const problems = verificationMatchesPlan(report.verification, plan);
    if (problems.length > 0) {
      console.log("  The machine does not match the config yet:");
      for (const problem of problems) console.log(`    - ${problem}`);
      console.log("");
      process.exit(1);
    }
    for (const env of plan.environments) {
      console.log(`  ${env.kind} binDir for bench.config.json:  ${envBinDir(env.kind)}`);
    }
    console.log("");
  }

  if (!report.ok) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof SetupError || err instanceof ConfigError ? err.message : String(err);
    console.error(`\n  ${message}\n`);
    process.exit(1);
  });
}

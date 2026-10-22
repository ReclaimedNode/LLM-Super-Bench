/**
 * `bun run merge-runs <runA> <runB> --into <new-name>`
 *
 * Two machines cannot safely share one run folder, so a two-machine
 * comparison runs as two invocations. This puts them on one board.
 *
 *   bun run merge-runs final final-new --into both
 *   bun run board both
 */

import { MergeError, mergeRuns, readMergeSource } from "./merge.ts";
import { listRuns, runDir } from "./store.ts";

const HELP = `
  bun run merge-runs <runA> <runB> --into <new-name>

    --into <name>   the new run folder to build (must not exist)
    --help          this

  Builds a third run folder from two finished runs and leaves both sources
  untouched. The merged folder reads like a run that had both lanes in it from
  the start: \`bun run board <new-name>\` shows the two machines side by side
  under each model heading, and report.md has the same tables in Markdown.

  It refuses when the two runs were not measuring the same thing -- a different
  output cap, a different number of measured or warm-up runs, different prompt
  lengths, a different prompt file, a different temperature, thinking on in one
  and off in the other, or two lanes with the same name -- and says which run
  had which value. Differences that are simply facts about two machines (lane
  names, software versions, when they ran) are printed and merged.
`;

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    const runs = await listRuns();
    if (runs.length > 0) console.log(`  Runs on disk, newest first: ${runs.join(", ")}\n`);
    return;
  }

  const intoIndex = argv.indexOf("--into");
  const into = intoIndex !== -1 ? argv[intoIndex + 1] : undefined;
  const names = argv.filter((arg, i) => !arg.startsWith("--") && i !== intoIndex + 1);

  if (names.length !== 2 || into === undefined || into.startsWith("--")) {
    console.error(`\n  Needs two run names and a new one: bun run merge-runs <runA> <runB> --into <new-name>\n`);
    process.exit(1);
  }

  try {
    const a = await readMergeSource(names[0]!);
    const b = await readMergeSource(names[1]!);
    const result = await mergeRuns(a, b, into);

    const lanes = result.manifest.lanes.map((l) => l.label);
    console.log(`
  MERGED

    ${a.runName} + ${b.runName}  ->  ${into}
    ${runDir(into)}

    ${lanes.length} lanes: ${lanes.join(", ")}
    ${result.manifest.models.length} models, ${result.cells.length} cells, ${result.runs.length} run lines${
      result.engine.length > 0 ? `, ${result.engine.length} engine cells` : ""
    }${result.power.length > 0 ? `, ${result.power.length} power readings` : ""}
`);
    for (const line of result.carried) console.log(`    carried: ${line}`);
    if (result.carried.length > 0) console.log("");

    if (result.differences.length > 0) {
      console.log(`  Differences between the two runs, all of them allowed:\n`);
      for (const line of result.differences) console.log(`    - ${line}`);
      console.log("");
    }

    console.log(`  Neither source folder was written to.\n  Look at it:  bun run board ${into}\n`);
  } catch (err) {
    if (err instanceof MergeError) {
      console.error(`\n  ${err.message.split("\n").join("\n  ")}\n  Nothing was written.\n`);
      process.exit(1);
    }
    throw err;
  }
}

if (import.meta.main) await main();

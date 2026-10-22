/**
 * `bun run videobench` -- the video grid, and the most experimental thing here.
 *
 *   bun run videobench --plan
 *   bun run videobench
 *
 * Fail-soft from end to end. If the port will not clone, will not sync, or
 * will not generate, this mode says why and the rest of the tool is untouched.
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ConfigError, loadBenchConfig } from "./config.ts";
import { fetchRemoteFile, remoteArg, runRemote } from "./ssh.ts";
import { checkSleep, whileAwake } from "./awake.ts";
import { reachLane } from "./reach.ts";
import type { RemoteRunner } from "./ssh.ts";
import {
  LTX_COMMIT,
  VIDEO_DISCLOSURE,
  generateClipCommand,
  installPortCommand,
  isValidFrameCount,
  lastOutput,
  nearestFrameCount,
  parseClipSeconds,
  parseSavedPath,
  planVideoGrid,
  portVersionCommand,
  remoteVideoDir,
  summariseVideoCells,
  videoSettingsFrom,
} from "./video.ts";
import type { VideoCell, VideoGridPlan, VideoRunRecord, VideoSettings } from "./video.ts";
import { defaultRunName, ensureRunDir, latestRun, runDir } from "./store.ts";

export const VIDEO_RUNS_FILE = "video.jsonl";
export const VIDEO_CELLS_FILE = "videocells.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function readVideoRuns(runName: string): Promise<VideoRunRecord[]> {
  try {
    const text = await readFile(resolve(runDir(runName), VIDEO_RUNS_FILE), "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as VideoRunRecord];
        } catch {
          return [];
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export interface RunVideoOptions {
  plan: VideoGridPlan;
  runName: string;
  log: (message: string) => void;
  run?: RemoteRunner;
  fetchFile?: typeof fetchRemoteFile;
  force?: boolean;
  restScale?: number;
}

export async function runVideoGrid(opts: RunVideoOptions) {
  const run = opts.run ?? runRemote;
  const fetchFile = opts.fetchFile ?? fetchRemoteFile;
  const { plan, runName, log } = opts;
  const settings = plan.settings;

  const dir = await ensureRunDir(runName);
  const clipsDir = resolve(dir, "clips");
  await mkdir(clipsDir, { recursive: true });

  const existing = await readVideoRuns(runName);
  const doneCount = new Map<string, number>();
  if (!opts.force) {
    for (const record of existing) {
      if (record.warmup) continue;
      const key = `${record.laneLabel}\u0000${record.modelId}`;
      doneCount.set(key, (doneCount.get(key) ?? 0) + 1);
    }
  }

  const append = async (record: VideoRunRecord) => {
    await appendFile(resolve(dir, VIDEO_RUNS_FILE), JSON.stringify(record) + "\n", "utf8");
  };

  for (const lanePlan of plan.lanes) {
    const owed = lanePlan.cells.filter(
      (c) => (doneCount.get(`${c.laneLabel}\u0000${c.modelId}`) ?? 0) < c.measuredClips,
    );
    if (owed.length === 0) {
      log(`  ${lanePlan.lane.label}: already has its clips; skipping.`);
      continue;
    }

    const reachable = await reachLane(lanePlan.target, {
      run,
      log: (message) => log(`  ! ${lanePlan.lane.label}: ${message}`),
    });
    if (!reachable.ok) {
      log(`  !! ${lanePlan.lane.label}: ${reachable.detail} Skipping video on it.`);
      continue;
    }

    const sleepCheck = await checkSleep(lanePlan.target, run);
    if (sleepCheck.warning) log(`   ! ${lanePlan.lane.label}: ${sleepCheck.warning}`);

    // The port, at its pinned commit. Cloning and syncing is the step most
    // likely to fail, so it fails here, loudly, before any clip is attempted.
    log(`  ${lanePlan.lane.label}: checking the port at ${LTX_COMMIT.slice(0, 8)}…`);
    const installed = await run(lanePlan.target, installPortCommand(), { timeoutMs: 45 * 60_000 });
    if (!installed.stdout.includes("PORT_PRESENT") && !installed.stdout.includes("PORT_INSTALLED")) {
      log(
        `  !! ${lanePlan.lane.label}: the LTX port would not install, so there is no video for this lane. ` +
          `Everything else in this tool is unaffected. It said:\n${lastOutput(`${installed.stdout}\n${installed.stderr}`)}`,
      );
      continue;
    }
    const version = await run(lanePlan.target, portVersionCommand(), { timeoutMs: 60_000 });
    const portCommit = version.stdout.trim().split("\n").pop() ?? LTX_COMMIT.slice(0, 8);
    log(`  ${lanePlan.lane.label}: port ready at ${portCommit}.`);

    await whileAwake(
      {
        target: lanePlan.target,
        seconds: Math.ceil((settings.timeoutMs / 1000) * owed.length),
        run,
        log: (m) => log(`  ${lanePlan.lane.label}: ${m}`),
      },
      async () => {
    for (const [cellIndex, cell] of owed.entries()) {
      const total = settings.warmupClips + cell.measuredClips;
      for (let i = 0; i < total; i++) {
        const warmup = i < settings.warmupClips;
        log(`  -- ${cell.laneLabel} · ${cell.modelName} · clip ${i + 1}/${total}${warmup ? " (warm-up)" : ""}`);

        const result = await run(
          lanePlan.target,
          generateClipCommand({ cell, settings, runName, index: i }),
          { timeoutMs: settings.timeoutMs },
        );
        const output = `${result.stdout}\n${result.stderr}`;
        const seconds = parseClipSeconds(output);
        const savedAt = parseSavedPath(output);

        if (seconds === null) {
          log(`  !! ${cell.laneLabel}: that clip produced no timing. ${(result.stderr || result.stdout).trim().slice(0, 240)}`);
          await append(blank(cell, settings, runName, warmup ? 0 : i - settings.warmupClips + 1, warmup, portCommit, "the port printed no Time: line"));
          continue;
        }

        let localFile: string | null = null;
        if (!warmup && savedAt) {
          const name = `${cell.laneLabel}__${cell.dir}__${i}.mp4`.replace(/[^A-Za-z0-9_.-]/g, "_");
          const bytes = await fetchFile(lanePlan.target, savedAt, { timeoutMs: 15 * 60_000 });
          if (bytes) {
            await Bun.write(resolve(clipsDir, name), bytes);
            localFile = `clips/${name}`;
          }
        }

        await append({
          ts: new Date().toISOString(),
          runName,
          laneLabel: cell.laneLabel,
          modelId: cell.modelId,
          modelName: cell.modelName,
          dir: cell.dir,
          runIndex: warmup ? 0 : i - settings.warmupClips + 1,
          warmup,
          secondsIncludingLoad: seconds,
          seed: settings.seed,
          width: settings.width,
          height: settings.height,
          frames: settings.frames,
          steps: settings.steps,
          prompt: settings.prompt,
          portCommit,
          remotePath: savedAt ?? "",
          localFile,
          error: null,
        });
        log(`     ${seconds.toFixed(1)}s (model load included)`);
      }

      // Through remoteArg: a tilde or a $HOME inside single quotes is a
      // literal, so hand-quoting made this delete nothing at all.
      await run(lanePlan.target, `rm -rf ${remoteArg(remoteVideoDir(runName, cell.dir), "video output directory")}`, {
        timeoutMs: 60_000,
      }).catch(() => undefined);

      if (cellIndex < owed.length - 1 && settings.restSeconds > 0) {
        await sleep(settings.restSeconds * 1000 * (opts.restScale ?? 1));
      }
    }
      },
    );
  }

  const all = await readVideoRuns(runName);
  const cells = summariseVideoCells(plan.lanes.flatMap((l) => l.cells), all);
  await Bun.write(resolve(dir, VIDEO_CELLS_FILE), JSON.stringify(cells, null, 2) + "\n");
  return cells;
}

function blank(
  cell: VideoCell,
  settings: VideoSettings,
  runName: string,
  runIndex: number,
  warmup: boolean,
  portCommit: string,
  why: string,
): VideoRunRecord {
  return {
    ts: new Date().toISOString(), runName, laneLabel: cell.laneLabel, modelId: cell.modelId,
    modelName: cell.modelName, dir: cell.dir, runIndex, warmup, secondsIncludingLoad: null,
    seed: settings.seed, width: settings.width, height: settings.height, frames: settings.frames,
    steps: settings.steps, prompt: settings.prompt, portCommit, remotePath: "", localFile: null, error: why,
  };
}

// ------------------------------------------------------------------ cli

const HELP = `
  bun run videobench [options]

    --plan             print the grid and settings, run nothing
    --run <name>       use (or resume) this run folder
    --config <path>    use this config instead of bench.config.json
    --force            re-do cells that already have their clips
    --help             this

  EXPERIMENTAL. The runner is a community MLX port of LTX-2.5, pinned to one
  commit, and the weights are a community quantisation. Seconds per clip here
  include the model load: the port prints one time for the whole invocation.
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
  const settings = videoSettingsFrom(loaded.config, loaded.config.video);
  const plan = planVideoGrid(loaded.config, settings);

  console.log(`\n  Config: ${loaded.path}${loaded.usedExample ? "  (the example)" : ""}`);

  if (!isValidFrameCount(settings.frames)) {
    console.error(
      `\n  frames must be 8k+1 (9, 17, 25, 33, 41, 49, …) because the model compresses in eights.` +
        `\n  ${settings.frames} is not; the nearest below it is ${nearestFrameCount(settings.frames)}.\n`,
    );
    process.exit(1);
  }

  if (plan.totalCells === 0) {
    console.log(`
  Nothing to do: no managed lane has a model with "kind": "video".

  Add one, e.g.
    { "name": "LTX-2.5 q8", "dir": "ltx-2.5-mlx-q8", "kind": "video",
      "hfRepo": "mlx-community/ltx-2.5-mlx-q8", "approxGb": 24 }
`);
    return;
  }

  const runName = value("--run") ?? loaded.config.runName ?? (await latestRun()) ?? defaultRunName();
  console.log(`
  VIDEO BENCHMARK  (experimental)

    run        ${runName}
    port       xocialize/ltx-2-mlx @ ${LTX_COMMIT.slice(0, 12)} (branch ltx-2.5)
    clip       ${settings.width}x${settings.height}, ${settings.frames} frames, seed ${settings.seed}${settings.lowRam ? ", --low-ram" : ""}
    clips      ${settings.warmupClips} warm-up + ${settings.measuredClips} measured per cell
    cells      ${plan.totalCells} across ${plan.lanes.length} managed lane(s)

  ${VIDEO_DISCLOSURE}
  Seconds per clip INCLUDE the model load: the port prints one time for the whole run.
`);

  if (argv.includes("--plan")) return;

  const cells = await runVideoGrid({
    plan,
    runName,
    force: argv.includes("--force"),
    log: (m) => console.log(m),
  });

  console.log("");
  for (const cell of cells) {
    const speed = cell.secondsPerClip;
    console.log(
      `  ${cell.laneLabel} · ${cell.modelName}: ` +
        (speed
          ? `${speed.median.toFixed(1)}s per clip (${speed.low.toFixed(1)}–${speed.high.toFixed(1)}), load included`
          : `no clips (${cell.status})`),
    );
  }
  console.log(`\n  Results in ${runDir(runName)}\n`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

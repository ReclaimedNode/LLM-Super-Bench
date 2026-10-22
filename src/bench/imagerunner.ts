/**
 * Running the image grid.
 *
 * Lanes run one at a time rather than together. On the language-model side
 * lanes are separate machines and running them at once is free; here the
 * pictures come back over the same network and the point of the exercise is a
 * fair seconds-per-image, so nothing else is asked of either machine while one
 * is drawing.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fetchRemoteFile, remoteArg, runRemote, runRemoteWithInput } from "./ssh.ts";
import { checkSleep, whileAwake } from "./awake.ts";
import { reachLane } from "./reach.ts";
import type { Pinger } from "./reach.ts";
import type { RemoteRunner } from "./ssh.ts";
import { PROJECT_ROOT } from "../config.ts";
import {
  REMOTE_SHIM_PATH,
  installShimCommand,
  parseShimOutput,
  remoteImageDir,
  shimCommand,
} from "./image.ts";
import type { ImageCell, ImageGridPlan, ImageRunRecord, ImageSettings } from "./image.ts";
import { summariseImageCells } from "./imagestats.ts";
import type { ImageCellStat } from "./image.ts";
import { ensureRunDir, readManifest, runDir, writeManifest } from "./store.ts";
import type { BenchModel, RunManifest } from "./types.ts";
import { appendFile, readFile } from "node:fs/promises";

export const IMAGE_RUNS_FILE = "images.jsonl";
export const IMAGE_CELLS_FILE = "imagecells.json";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ImageEvent =
  | { type: "start"; totalCells: number; totalImages: number }
  | { type: "cell-start"; cell: ImageCell }
  | { type: "note"; laneLabel: string | null; message: string; kind: "info" | "warn" | "error" }
  | { type: "image"; record: ImageRunRecord }
  | { type: "cell-done"; stat: ImageCellStat }
  | { type: "done"; cells: ImageCellStat[] };

export async function readImageRuns(runName: string): Promise<ImageRunRecord[]> {
  try {
    const text = await readFile(resolve(runDir(runName), IMAGE_RUNS_FILE), "utf8");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ImageRunRecord];
        } catch {
          return [];
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function appendImageRun(runName: string, record: ImageRunRecord): Promise<void> {
  const dir = await ensureRunDir(runName);
  await appendFile(resolve(dir, IMAGE_RUNS_FILE), JSON.stringify(record) + "\n", "utf8");
}

export interface RunImageGridOptions {
  plan: ImageGridPlan;
  runName: string;
  emit: (event: ImageEvent) => void;
  run?: RemoteRunner;
  force?: boolean;
  /** Test seams. */
  ping?: Pinger;
  sleepFor?: (ms: number) => Promise<void>;
  sendShim?: typeof runRemoteWithInput;
  fetchFile?: typeof fetchRemoteFile;
  restScale?: number;
}

/** Cells that already have all their images on disk are not run again. */
export function imageCellsOwed(plan: ImageGridPlan, done: ImageRunRecord[], force: boolean): ImageCell[] {
  if (force) return plan.lanes.flatMap((l) => l.cells);
  const counts = new Map<string, number>();
  for (const record of done) {
    if (record.warmup) continue;
    const key = JSON.stringify([record.laneLabel, record.modelId]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return plan.lanes
    .flatMap((l) => l.cells)
    .filter((cell) => (counts.get(JSON.stringify([cell.laneLabel, cell.modelId])) ?? 0) < cell.measuredImages);
}

export async function runImageGrid(opts: RunImageGridOptions): Promise<ImageCellStat[]> {
  const run = opts.run ?? runRemote;
  const sendShim = opts.sendShim ?? runRemoteWithInput;
  const fetchFile = opts.fetchFile ?? fetchRemoteFile;
  const { plan, runName } = opts;
  const settings = plan.settings;

  const note = (laneLabel: string | null, message: string, kind: "info" | "warn" | "error" = "info") =>
    opts.emit({ type: "note", laneLabel, message, kind });

  const existing = await readImageRuns(runName);
  const owed = new Set(imageCellsOwed(plan, existing, opts.force ?? false).map((c) => `${c.laneLabel}\u0000${c.modelId}`));

  opts.emit({ type: "start", totalCells: plan.totalCells, totalImages: plan.totalImages });
  for (const u of plan.unsupported) note(null, `${u.modelName} skipped: ${u.why}.`, "warn");

  const shimSource = await Bun.file(resolve(PROJECT_ROOT, "remote/mflux_bench.py")).text();
  const localImages = resolve(runDir(runName), "images");
  await mkdir(localImages, { recursive: true });

  // One lane at a time: a machine being asked for a fair seconds-per-image is
  // not also serving somebody else's benchmark.
  for (const lanePlan of plan.lanes) {
    const laneCells = lanePlan.cells.filter((c) => owed.has(`${c.laneLabel}\u0000${c.modelId}`));
    if (laneCells.length === 0) {
      note(lanePlan.lane.label, "every cell already has its images; skipping.", "info");
      continue;
    }

    const reachable = await reachLane(lanePlan.target, {
      run,
      ping: opts.ping,
      sleep: opts.sleepFor,
      log: (message) => note(lanePlan.lane.label, message, "warn"),
    });
    if (!reachable.ok) {
      note(lanePlan.lane.label, reachable.detail, "error");
      continue;
    }

    const sleepCheck = await checkSleep(lanePlan.target, run);
    if (sleepCheck.warning) note(lanePlan.lane.label, sleepCheck.warning, "warn");

    const sent = await sendShim(lanePlan.target, installShimCommand(), shimSource, { timeoutMs: 60_000 });
    if (!sent.stdout.includes("SHIM_WRITTEN")) {
      note(lanePlan.lane.label, `could not put the timing shim on this machine: ${(sent.stderr || "").trim().slice(0, 160)}`, "error");
      continue;
    }
    note(lanePlan.lane.label, `timing shim in place at ${REMOTE_SHIM_PATH}.`);

    await whileAwake(
      {
        target: lanePlan.target,
        seconds: Math.ceil((settings.timeoutMs / 1000) * laneCells.length),
        run,
        log: (m) => note(lanePlan.lane.label, m),
      },
      async () => {
    for (const [index, cell] of laneCells.entries()) {
      opts.emit({ type: "cell-start", cell });

      const result = await run(lanePlan.target, shimCommand({ cell, settings, runName }), {
        timeoutMs: settings.timeoutMs,
      });
      const parsed = parseShimOutput(`${result.stdout}\n${result.stderr}`);

      if (parsed.error !== null || parsed.images.length === 0) {
        const why = parsed.error ?? `mflux produced no images: ${(result.stderr || result.stdout).trim().slice(0, 300)}`;
        note(cell.laneLabel, `${cell.modelName}: ${why}`, "error");
        await appendImageRun(runName, blankRecord(cell, settings, runName, why));
        continue;
      }

      if (parsed.loadSeconds !== null) {
        note(cell.laneLabel, `${cell.modelName}: weights loaded in ${parsed.loadSeconds.toFixed(1)}s (not counted in any image).`);
      }

      for (const image of parsed.images) {
        // The pictures come back so the board can show them side by side: with
        // one seed every lane should have drawn the same thing, and that is
        // checkable rather than assumed.
        let localFile: string | null = null;
        if (!image.warmup) {
          const name = `${cell.laneLabel}__${cell.dir}__${image.index}.png`.replace(/[^A-Za-z0-9_.-]/g, "_");
          const bytes = await fetchFile(lanePlan.target, image.path, { timeoutMs: 5 * 60_000 });
          if (bytes) {
            await Bun.write(resolve(localImages, name), bytes);
            localFile = `images/${name}`;
          } else {
            note(cell.laneLabel, `could not copy back ${image.path}; the timing still stands.`, "warn");
          }
        }

        const record: ImageRunRecord = {
          ts: new Date().toISOString(),
          runName,
          laneLabel: cell.laneLabel,
          modelId: cell.modelId,
          modelName: cell.modelName,
          dir: cell.dir,
          kind: cell.kind,
          runIndex: image.warmup ? 0 : image.index - settings.warmupImages + 1,
          warmup: image.warmup,
          seconds: image.seconds,
          loadSeconds: parsed.loadSeconds,
          seed: settings.seed,
          width: settings.width,
          height: settings.height,
          steps: settings.steps,
          prompt: settings.prompt,
          remotePath: image.path,
          localFile,
          sha256: image.sha256,
          checksumOf: image.checksumOf,
          peakMemoryGb: parsed.peakMemoryGb,
          mfluxVersion: parsed.mfluxVersion,
          mlxVersion: parsed.mlxVersion,
          error: null,
        };
        await appendImageRun(runName, record);
        opts.emit({ type: "image", record });
      }

      const all = await readImageRuns(runName);
      const stats = summariseImageCells(
        plan.lanes.flatMap((l) => l.cells),
        all,
      );
      await Bun.write(resolve(await ensureRunDir(runName), IMAGE_CELLS_FILE), JSON.stringify(stats, null, 2) + "\n");
      const mine = stats.find((s) => s.laneLabel === cell.laneLabel && s.modelId === cell.modelId);
      if (mine) opts.emit({ type: "cell-done", stat: mine });

      // Clean up only what this run wrote, and only on the machine it wrote it
      // on. Through remoteArg, because a tilde inside single quotes is a
      // literal tilde: quoting it by hand made this delete nothing at all.
      await run(lanePlan.target, `rm -rf ${remoteArg(remoteImageDir(runName, cell.dir), "image output directory")}`, {
        timeoutMs: 60_000,
      }).catch(() => undefined);

      if (index < laneCells.length - 1 && settings.restSeconds > 0) {
        await sleep(settings.restSeconds * 1000 * (opts.restScale ?? 1));
      }
    }
      },
    );
  }

  const all = await readImageRuns(runName);
  const cells = summariseImageCells(
    plan.lanes.flatMap((l) => l.cells),
    all,
  );
  await Bun.write(resolve(await ensureRunDir(runName), IMAGE_CELLS_FILE), JSON.stringify(cells, null, 2) + "\n");
  // The folder describes itself, so the board can draw it and merge-runs can
  // read it. An image run used to leave no manifest at all, which made both
  // impossible.
  await ensureImageManifest(runName);
  opts.emit({ type: "done", cells });
  return cells;
}

function blankRecord(cell: ImageCell, settings: ImageSettings, runName: string, why: string): ImageRunRecord {
  return {
    ts: new Date().toISOString(),
    runName,
    laneLabel: cell.laneLabel,
    modelId: cell.modelId,
    modelName: cell.modelName,
    dir: cell.dir,
    kind: cell.kind,
    runIndex: 1,
    warmup: false,
    seconds: null,
    loadSeconds: null,
    seed: settings.seed,
    width: settings.width,
    height: settings.height,
    steps: settings.steps,
    prompt: settings.prompt,
    remotePath: "",
    localFile: null,
    sha256: "",
    checksumOf: "file",
    peakMemoryGb: null,
    mfluxVersion: null,
    mlxVersion: null,
    error: why,
  };
}

/**
 * The manifest an image run writes for itself.
 *
 * A run folder without a manifest has no way to say which machines were in it,
 * so the board cannot draw it and `merge-runs` cannot read it. Everything here
 * is derived from what was actually recorded -- the lanes that produced
 * images, the models they ran, the first and last timestamp, the settings the
 * shim was given -- rather than from the config, which may have changed since.
 *
 * The language-grid fields have no meaning for images. The ones that DO carry
 * over are filled truthfully: an image cell really is N measured after one
 * discarded warm-up. The rest are left at zero and are not printed, because
 * `measured` says this run has no language grid in it.
 */
export function manifestFromImageRuns(runName: string, records: ImageRunRecord[]): RunManifest | null {
  const real = records.filter((r) => r.error === null);
  if (real.length === 0) return null;

  const lanes = [...new Set(real.map((r) => r.laneLabel))].map((label) => ({ label, managed: true }));
  const models: BenchModel[] = [];
  for (const record of real) {
    if (models.some((m) => (m.dir ?? m.id) === record.dir)) continue;
    models.push({ name: record.modelName, id: record.modelId, dir: record.dir, kind: "image" });
  }

  const times = real.map((r) => r.ts).sort();
  const measuredPerCell = new Map<string, number>();
  for (const r of real) {
    if (r.warmup) continue;
    const key = `${r.laneLabel}\u0000${r.dir}`;
    measuredPerCell.set(key, (measuredPerCell.get(key) ?? 0) + 1);
  }
  const warmups = new Set(real.filter((r) => r.warmup).map((r) => `${r.laneLabel}\u0000${r.dir}`));

  return {
    runName,
    startedAt: times[0]!,
    finishedAt: times.at(-1)!,
    measured: ["image"],
    outputCap: 0,
    measuredRuns: Math.max(...measuredPerCell.values(), 0),
    warmupRuns: warmups.size > 0 ? 1 : 0,
    restSeconds: 0,
    temperature: 0,
    promptFile: "",
    disableThinking: false,
    models,
    lanes,
    promptLengths: [],
    fingerprints: [
      ...new Set(
        real
          .map((r) => (r.mfluxVersion && r.mlxVersion ? `mflux ${r.mfluxVersion}, mlx ${r.mlxVersion}` : null))
          .filter((f): f is string => f !== null),
      ),
    ],
    charsPerToken: {},
  };
}

/**
 * Gives the run folder a manifest, without ever losing one that is already
 * there: a folder that already holds a language grid keeps its own settings
 * and only gains this run's lanes, models and "image" in `measured`.
 */
export async function ensureImageManifest(runName: string): Promise<RunManifest | null> {
  const derived = manifestFromImageRuns(runName, await readImageRuns(runName));
  if (derived === null) return null;

  const existing = await readManifest(runName);
  if (existing === null) {
    await writeManifest(runName, derived);
    return derived;
  }

  const lanes = [...existing.lanes];
  for (const lane of derived.lanes) if (!lanes.some((l) => l.label === lane.label)) lanes.push(lane);
  const models = [...existing.models];
  for (const model of derived.models) {
    if (!models.some((m) => (m.dir ?? m.id) === (model.dir ?? model.id))) models.push(model);
  }

  const merged: RunManifest = {
    ...existing,
    lanes,
    models,
    measured: [...new Set([...(existing.measured ?? ["llm"]), "image" as const])],
    fingerprints: [...new Set([...existing.fingerprints, ...derived.fingerprints])],
  };
  await writeManifest(runName, merged);
  return merged;
}

/**
 * Putting two runs on one board.
 *
 * Two machines cannot safely write one run folder at the same time, so a
 * two-machine comparison is run as two invocations with two run names. This
 * builds a third folder from them, and reads exactly like a run that had both
 * lanes in it from the start: the board and report.md already group by the
 * model's key and lay lanes out side by side.
 *
 * The whole point of the merge is a fair comparison, so the checks are the
 * interesting part. A difference that would make the two columns mean
 * different things -- a different output cap, a different number of measured
 * runs, different prompt lengths, a different prompt file, a different
 * temperature, thinking on in one and off in the other -- REFUSES the merge
 * and says which value each run had. A difference that is merely a fact about
 * the two machines -- their lane names, their software versions, when they
 * ran -- is printed and merged.
 *
 * Neither source folder is opened for writing at any point.
 */

import { cp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { IMAGE_CELLS_FILE, IMAGE_RUNS_FILE, manifestFromImageRuns, readImageRuns } from "./imagerunner.ts";
import { buildReport } from "./report.ts";
import {
  FILES,
  ensureRunDir,
  readCells,
  readEngine,
  readManifest,
  readPower,
  readRuns,
  runDir,
  writeCells,
  writeEngine,
  writeManifest,
  writePower,
  writeReport,
} from "./store.ts";
import { VIDEO_CELLS_FILE, VIDEO_RUNS_FILE } from "./videocli.ts";
import type { ImageRunRecord } from "./image.ts";
import type { BenchRunRecord, CellStat, EngineCell, PowerReading, RunManifest } from "./types.ts";

export class MergeError extends Error {}

/** One run, already read off disk. */
export interface MergeSource {
  runName: string;
  manifest: RunManifest;
  cells: CellStat[];
  runs: BenchRunRecord[];
  engine: EngineCell[];
  power: PowerReading[];
  /** The image runs, when the folder holds an image grid. */
  images: ImageRunRecord[];
}

export interface MergeCheck {
  /** Reasons the merge must not happen. Empty means it may. */
  refusals: string[];
  /** True differences that do not make the comparison dishonest. */
  differences: string[];
}

function fmtLengths(manifest: RunManifest): string {
  return manifest.promptLengths.map((l) => `${l.label} (${l.tokens})`).join(", ");
}

function modelKeysOf(manifest: RunManifest): string[] {
  return manifest.models.map((m) => m.dir ?? m.id);
}

/**
 * Whether two runs may be shown as columns of one table.
 *
 * Every refusal names the setting and both values, because the useful next
 * step is always "re-run one of them with the other's setting", and that needs
 * to know which is which.
 */
export function checkMerge(a: MergeSource, b: MergeSource): MergeCheck {
  const refusals: string[] = [];
  const differences: string[] = [];

  const refuseIfDifferent = <T>(what: string, pick: (m: RunManifest) => T, show: (v: T) => string = String): void => {
    const av = pick(a.manifest);
    const bv = pick(b.manifest);
    if (show(av) !== show(bv)) {
      refusals.push(
        `${what} differs: ${a.runName} used ${show(av)}, ${b.runName} used ${show(bv)}. ` +
          `Those two columns would not be measuring the same thing.`,
      );
    }
  };

  refuseIfDifferent("The output cap", (m) => m.outputCap, (v) => `${v} tokens`);
  refuseIfDifferent("The number of measured runs per cell", (m) => m.measuredRuns);
  refuseIfDifferent("The number of discarded warm-up runs", (m) => m.warmupRuns);
  refuseIfDifferent("The temperature", (m) => m.temperature);
  refuseIfDifferent("The thinking setting", (m) => (m.disableThinking ? "thinking off" : "thinking on"));
  refuseIfDifferent("The prompt source", (m) => m.promptFile);
  refuseIfDifferent("The prompt lengths", fmtLengths);

  // Two lanes with the same name would collapse into one column and the board
  // would show whichever it found first, silently.
  const shared = a.manifest.lanes.map((l) => l.label).filter((label) => b.manifest.lanes.some((l) => l.label === label));
  if (shared.length > 0) {
    refusals.push(
      `Both runs have a lane called ${shared.map((s) => `"${s}"`).join(", ")}. ` +
        `A merged board could not tell the two apart, so rename one lane in its config and re-run, ` +
        `or merge different runs.`,
    );
  }

  if (a.runName === b.runName) {
    refusals.push(`Both names are "${a.runName}". A run cannot be merged with itself.`);
  }

  for (const source of [a, b]) {
    if (source.cells.length === 0 && source.images.length === 0) {
      refusals.push(`${source.runName} has no cells yet — there is nothing of it to put on a board.`);
    }
  }

  // Pictures are only comparable when they were asked for in the same words,
  // at the same size, from the same seed, in the same number of steps: a
  // different seed draws a different picture and the times are not the same
  // measurement.
  const pictureSettings = (source: MergeSource): Record<string, string> => {
    const first = source.images.find((r) => r.error === null);
    if (!first) return {};
    return {
      "The image prompt": first.prompt,
      "The image seed": String(first.seed),
      "The image size": `${first.width}x${first.height}`,
      "The image step count": first.steps === null ? "each model's own default" : String(first.steps),
    };
  };
  const aPic = pictureSettings(a);
  const bPic = pictureSettings(b);
  for (const key of Object.keys(aPic)) {
    if (bPic[key] !== undefined && aPic[key] !== bPic[key]) {
      refusals.push(
        `${key} differs: ${a.runName} used ${aPic[key]}, ${b.runName} used ${bPic[key]}. ` +
          `Those two columns would not be measuring the same thing.`,
      );
    }
  }

  // ---- differences that are allowed, and are worth saying out loud

  differences.push(
    `Lanes: ${a.runName} has ${a.manifest.lanes.map((l) => l.label).join(", ")}; ` +
      `${b.runName} has ${b.manifest.lanes.map((l) => l.label).join(", ")}.`,
  );

  const af = a.manifest.fingerprints;
  const bf = b.manifest.fingerprints;
  if (JSON.stringify(af) !== JSON.stringify(bf)) {
    differences.push(
      `Software versions differ, as they will between two machines: ` +
        `${a.runName} reported ${af.join(", ") || "none"}; ${b.runName} reported ${bf.join(", ") || "none"}. ` +
        `Both are printed in the merged report.`,
    );
  }

  if (a.manifest.restSeconds !== b.manifest.restSeconds) {
    differences.push(
      `Rest between cells differs: ${a.manifest.restSeconds}s and ${b.manifest.restSeconds}s. ` +
        `That changes how cool each machine was, not what was measured.`,
    );
  }

  const aKeys = modelKeysOf(a.manifest);
  const bKeys = modelKeysOf(b.manifest);
  const onlyA = aKeys.filter((k) => !bKeys.includes(k));
  const onlyB = bKeys.filter((k) => !aKeys.includes(k));
  if (onlyA.length > 0 || onlyB.length > 0) {
    differences.push(
      `Not every model was run on both: ` +
        [
          onlyA.length > 0 ? `only ${a.runName} has ${onlyA.join(", ")}` : null,
          onlyB.length > 0 ? `only ${b.runName} has ${onlyB.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ") +
        `. Those models get a heading with one lane in it.`,
    );
  }

  for (const [id, value] of Object.entries(a.manifest.charsPerToken)) {
    const other = b.manifest.charsPerToken[id];
    if (other !== undefined && Math.abs(other - value) > 0.005) {
      differences.push(
        `Measured characters per token for ${id} differ slightly: ${value.toFixed(2)} and ${other.toFixed(2)}. ` +
          `The merged settings table shows ${a.runName}'s figure.`,
      );
    }
  }

  const aTimes = `${a.manifest.startedAt}`;
  const bTimes = `${b.manifest.startedAt}`;
  if (aTimes !== bTimes) differences.push(`Started at different times: ${aTimes} and ${bTimes}.`);

  for (const source of [a, b]) {
    if (source.manifest.finishedAt === null) {
      differences.push(`${source.runName} has no finish time recorded, so it may not have run every cell.`);
    }
  }

  return { refusals, differences };
}

/** The merged manifest: A's settings, both runs' lanes, models and versions. */
export function mergeManifests(a: MergeSource, b: MergeSource, intoName: string): RunManifest {
  const models = [...a.manifest.models];
  for (const model of b.manifest.models) {
    const key = model.dir ?? model.id;
    if (!models.some((m) => (m.dir ?? m.id) === key)) models.push(model);
  }

  const earliest = [a.manifest.startedAt, b.manifest.startedAt].sort()[0]!;
  const bothFinished = a.manifest.finishedAt !== null && b.manifest.finishedAt !== null;
  const latestFinish = bothFinished ? [a.manifest.finishedAt!, b.manifest.finishedAt!].sort().at(-1)! : null;

  return {
    ...a.manifest,
    runName: intoName,
    startedAt: earliest,
    finishedAt: latestFinish,
    models,
    lanes: [...a.manifest.lanes, ...b.manifest.lanes],
    fingerprints: [...new Set([...a.manifest.fingerprints, ...b.manifest.fingerprints])],
    measured: [...new Set([...(a.manifest.measured ?? ["llm"]), ...(b.manifest.measured ?? ["llm"])])],
    charsPerToken: { ...b.manifest.charsPerToken, ...a.manifest.charsPerToken },
    mergedFrom: [
      { runName: a.runName, lanes: a.manifest.lanes.map((l) => l.label) },
      { runName: b.runName, lanes: b.manifest.lanes.map((l) => l.label) },
    ],
  };
}

export interface MergeResult {
  intoName: string;
  manifest: RunManifest;
  cells: CellStat[];
  runs: BenchRunRecord[];
  engine: EngineCell[];
  power: PowerReading[];
  differences: string[];
  /** Extra files carried across, named for the report the command prints. */
  carried: string[];
}

/** Reads one run folder. Throws when there is no run of that name. */
export async function readMergeSource(runName: string): Promise<MergeSource> {
  const images = await readImageRuns(runName);
  // An image grid used to leave no manifest at all. One is derived from its
  // own records so an older folder can still be merged and drawn -- in memory
  // only, because reading a source must never write to it.
  const manifest = (await readManifest(runName)) ?? manifestFromImageRuns(runName, images);
  if (manifest === null) {
    throw new MergeError(
      `No run called "${runName}" in results/bench (or it has no manifest.json). ` +
        `\`bun run board\` with no name lists what is there.`,
    );
  }
  return {
    runName,
    manifest,
    cells: (await readCells(runName)) ?? [],
    runs: await readRuns(runName),
    engine: (await readEngine(runName)) ?? [],
    power: (await readPower(runName)) ?? [],
    images,
  };
}

/** Copies a run folder's media directory across, keeping every file. */
async function carryMedia(from: string, into: string, dir: "images" | "clips"): Promise<number> {
  const source = resolve(runDir(from), dir);
  let names: string[];
  try {
    names = await readdir(source);
  } catch {
    return 0;
  }
  if (names.length === 0) return 0;
  // Lane labels are part of every filename and two lanes cannot share a label
  // here, so nothing collides; `force: false` makes that a loud failure rather
  // than a silent overwrite if it ever stops being true.
  await cp(source, resolve(runDir(into), dir), { recursive: true, force: false, errorOnExist: true });
  return names.length;
}

/** Concatenates one JSONL file from both runs, in A-then-B order. */
async function carryJsonl(a: string, b: string, into: string, file: string): Promise<number> {
  const lines: string[] = [];
  for (const name of [a, b]) {
    const f = Bun.file(resolve(runDir(name), file));
    if (!(await f.exists())) continue;
    for (const line of (await f.text()).split("\n")) {
      if (line.trim() !== "") lines.push(line);
    }
  }
  if (lines.length === 0) return 0;
  await Bun.write(resolve(runDir(into), file), lines.join("\n") + "\n");
  return lines.length;
}

/** Concatenates one JSON array file from both runs. */
async function carryJsonArray(a: string, b: string, into: string, file: string): Promise<number> {
  const all: unknown[] = [];
  for (const name of [a, b]) {
    const f = Bun.file(resolve(runDir(name), file));
    if (!(await f.exists())) continue;
    try {
      const parsed = await f.json();
      if (Array.isArray(parsed)) all.push(...parsed);
    } catch {
      // A half-written summary from a killed run is not worth failing over.
    }
  }
  if (all.length === 0) return 0;
  await Bun.write(resolve(runDir(into), file), JSON.stringify(all, null, 2) + "\n");
  return all.length;
}

/**
 * Builds the merged run folder. Reads both sources; writes only the new one.
 *
 * Refuses rather than overwriting an existing folder: the merged run is cheap
 * to rebuild under another name, and a board being filmed is not.
 */
export async function mergeRuns(a: MergeSource, b: MergeSource, intoName: string): Promise<MergeResult> {
  const check = checkMerge(a, b);
  if (check.refusals.length > 0) {
    throw new MergeError(
      `These two runs cannot honestly go on one board:\n\n` +
        check.refusals.map((r) => `  - ${r}`).join("\n") +
        `\n`,
    );
  }

  if (intoName === a.runName || intoName === b.runName) {
    throw new MergeError(`--into must be a new name: "${intoName}" is one of the runs being merged.`);
  }
  if (await Bun.file(resolve(runDir(intoName), FILES.manifest)).exists()) {
    throw new MergeError(`results/bench/${intoName} already exists. Pick another --into name; nothing was changed.`);
  }

  const manifest = mergeManifests(a, b, intoName);
  const cells = [...a.cells, ...b.cells];
  const runs = [...a.runs, ...b.runs];
  const engine = [...a.engine, ...b.engine];
  const power = [...a.power, ...b.power];

  await ensureRunDir(intoName);
  await writeManifest(intoName, manifest);
  await writeCells(intoName, cells);
  await writeEngine(intoName, engine);
  if (power.length > 0) await writePower(intoName, power);
  // Every run line is kept with the run name it was measured under, so the
  // merged folder still says which machine's invocation produced each line.
  await Bun.write(resolve(runDir(intoName), FILES.runs), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const carried: string[] = [];
  const imageCells = await carryJsonArray(a.runName, b.runName, intoName, IMAGE_CELLS_FILE);
  const imageRuns = await carryJsonl(a.runName, b.runName, intoName, IMAGE_RUNS_FILE);
  const videoCells = await carryJsonArray(a.runName, b.runName, intoName, VIDEO_CELLS_FILE);
  const videoRuns = await carryJsonl(a.runName, b.runName, intoName, VIDEO_RUNS_FILE);
  const pictures = await carryMedia(a.runName, intoName, "images");
  const picturesB = await carryMedia(b.runName, intoName, "images");
  const clips = (await carryMedia(a.runName, intoName, "clips")) + (await carryMedia(b.runName, intoName, "clips"));

  if (imageCells > 0) carried.push(`${imageCells} image cell(s), ${imageRuns} image run(s), ${pictures + picturesB} picture(s)`);
  if (videoCells > 0) carried.push(`${videoCells} video cell(s), ${videoRuns} video run(s), ${clips} clip(s)`);

  // report.md is the language grid's tables. A merge of image runs alone has
  // none of those numbers, and a page of settings that were never used would
  // be worse than no page: the board is where pictures are read.
  if (cells.length > 0) await writeReport(intoName, buildReport({ manifest, cells, engine, power }));

  return { intoName, manifest, cells, runs, engine, power, differences: check.differences, carried };
}

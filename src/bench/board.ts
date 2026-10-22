/**
 * Shaping a finished run into what the board draws.
 *
 * All the arithmetic lives here rather than in the page, for the same reason
 * the race puts its timing in the server: a number on screen should be one
 * that was worked out somewhere testable. The page turns this into SVG and
 * does no maths beyond multiplying by a pixel scale.
 */

import { compareSentence } from "./stats.ts";
import type { CellStat, EngineCell, PowerReading, RunManifest, Stat3 } from "./types.ts";
import type { ImageCellStat } from "./image.ts";
import { VIDEO_DISCLOSURE } from "./video.ts";
import type { VideoCellStat } from "./video.ts";

/** Lane colours, in lane order. The CSS holds the same list. */
export const LANE_COLOR_VARS = ["--lane-1", "--lane-2", "--lane-3", "--lane-4"];

export interface BoardBar {
  laneLabel: string;
  colorVar: string;
  /** Null when the cell produced no usable number. The bar is then a gap with a mark. */
  median: number | null;
  low: number | null;
  high: number | null;
  status: CellStat["status"];
  /** Short words for what went wrong or what to be careful of. */
  marks: string[];
}

export interface BoardChart {
  measure: "reading" | "writing";
  unit: string;
  bars: BoardBar[];
  /** Top of the axis. A round number at or above `dataMax`. */
  max: number;
  /** The tallest thing that has to fit, range marks included. */
  dataMax: number;
  /** Where the gridlines go, 0 first, `max` last. All round numbers. */
  ticks: number[];
}

export interface BoardRow {
  nominalLabel: string;
  nominalTokens: number;
  torture: boolean;
  reading: BoardChart;
  writing: BoardChart;
  /** The true prompt tokens each lane actually read, per lane, in lane order. */
  truePromptTokens: (number | null)[];
  notes: string[];
}

export interface LinePoint {
  x: number;
  label: string;
  /** Seconds. Null where that lane has no usable number at this size. */
  y: number | null;
}

export interface LineSeries {
  laneLabel: string;
  colorVar: string;
  points: LinePoint[];
}

export interface BoardLineChart {
  series: LineSeries[];
  xLabels: string[];
  /** Top of the axis. A round number at or above `dataMaxY`. */
  maxY: number;
  dataMaxY: number;
  ticks: number[];
  unit: "seconds";
}

export interface BoardEngineRow {
  laneLabel: string;
  nominalLabel: string;
  readMedian: number | null;
  readLow: number | null;
  readHigh: number | null;
  writeMedian: number | null;
  writeLow: number | null;
  writeHigh: number | null;
  peakMemoryGb: number | null;
  trials: number;
  unavailable: string | null;
}

export interface BoardPowerRow {
  laneLabel: string;
  modelName: string | null;
  loadWatts: number | null;
  idleWatts: number | null;
  /** Writing speed divided by watts under load. Null without both. */
  tokensPerWatt: number | null;
  holdSeconds: number | null;
}

export interface BoardImageBar {
  laneLabel: string;
  colorVar: string;
  median: number | null;
  low: number | null;
  high: number | null;
  loadSeconds: number | null;
  peakMemoryGb: number | null;
  /** Relative to the run folder, so the board can show the picture itself. */
  image: string | null;
  sha256: string | null;
  status: string;
  marks: string[];
}

export interface BoardImageModel {
  modelId: string;
  modelName: string;
  kind: string;
  /** The axis, on round numbers, like every other chart here. */
  max: number;
  dataMax: number;
  ticks: number[];
  bars: BoardImageBar[];
  /** Said out loud when two lanes drew different pictures from one seed. */
  warnings: string[];
  notes: string[];
}

export interface BoardImages {
  models: BoardImageModel[];
  prompt: string | null;
  seed: number | null;
  size: string | null;
  steps: number | null;
  mfluxVersion: string | null;
}

export interface BoardVideo {
  modelName: string;
  max: number;
  dataMax: number;
  ticks: number[];
  bars: { laneLabel: string; colorVar: string; median: number | null; low: number | null; high: number | null; clip: string | null; marks: string[] }[];
  portCommit: string | null;
  clip: string | null;
  /** Geometry and seed, so the number can be reproduced. */
  settings: string | null;
  /** The licence's disclosure, which is not optional. */
  disclosure: string;
  notes: string[];
}

export interface BoardModel {
  modelId: string;
  modelName: string;
  quantization: string | null;
  fileSize: string | null;
  activeParams: string | null;
  headline: string | null;
  rows: BoardRow[];
  firstWord: BoardLineChart;
  engine: BoardEngineRow[];
  power: BoardPowerRow[];
}

export interface BoardFooter {
  /** What the run measured, so the page prints only the settings that apply. */
  measured: ("llm" | "image" | "video")[];
  outputCap: number;
  measuredRuns: number;
  warmupRuns: number;
  restSeconds: number;
  temperature: number;
  disableThinking: boolean;
  promptFile: string;
  fingerprints: string[];
  startedAt: string;
  finishedAt: string | null;
  charsPerToken: Record<string, number>;
}

export interface BoardData {
  runName: string;
  lanes: { label: string; colorVar: string; managed: boolean }[];
  models: BoardModel[];
  /** Null when this run made no pictures, so the board simply has no section. */
  images: BoardImages | null;
  /** Null when this run made no clips. Experimental when it did. */
  video: BoardVideo[] | null;
  footer: BoardFooter;
  /** Things that would change how a number should be read. */
  warnings: string[];
}

// ------------------------------------------------------------------ helpers

function colorFor(index: number): string {
  return LANE_COLOR_VARS[index % LANE_COLOR_VARS.length]!;
}

/** Short words for the board. A cell is never silently absent. */
export function marksFor(cell: CellStat | undefined): string[] {
  if (!cell) return ["not run"];
  const marks: string[] = [];
  if (cell.status === "not-run") marks.push("not run");
  if (cell.status === "failed") marks.push("failed");
  if (cell.status === "no-valid-runs") marks.push("no valid runs");
  if (cell.failed > 0 && cell.status !== "failed") marks.push(`${cell.failed} failed`);
  if (cell.cachedInvalid > 0) marks.push(`${cell.cachedInvalid} cached`);
  if (cell.shortOutput > 0) marks.push(`${cell.shortOutput} short`);
  if (cell.firstWordField !== null && cell.firstWordField !== "content") marks.push(cell.firstWordField);
  if (cell.status === "partial" && marks.length === 0) marks.push(`${cell.runsUsed}/${cell.runsRecorded} used`);
  return marks;
}

function bar(cell: CellStat | undefined, lane: string, index: number, stat: Stat3 | null | undefined): BoardBar {
  return {
    laneLabel: lane,
    colorVar: colorFor(index),
    median: stat?.median ?? null,
    low: stat?.low ?? null,
    high: stat?.high ?? null,
    status: cell?.status ?? "not-run",
    marks: marksFor(cell),
  };
}

/** The axis has to clear the tallest RANGE mark, not just the tallest median. */
function dataMaxOf(bars: BoardBar[]): number {
  const tops = bars.map((b) => b.high ?? b.median).filter((v): v is number => v !== null && Number.isFinite(v));
  return tops.length === 0 ? 0 : Math.max(...tops);
}

/**
 * Gridlines on round numbers.
 *
 * Dividing the tallest value into four gives ticks like 563, 188 and 56.3 --
 * arithmetically correct and unreadable at a glance, which is the whole job of
 * an axis on a chart that gets filmed. So the STEP is chosen first, from the
 * familiar 1 / 2 / 2.5 / 5 / 10 series, and the axis then runs up to the first
 * multiple of it that clears the data.
 *
 * Five intervals is the target rather than four: it lands on 0-200-400-600-800
 * where four would have given 0-165-330-495-660.
 */
export function niceTicks(dataMax: number, targetIntervals = 5): { max: number; ticks: number[] } {
  if (!(dataMax > 0) || !Number.isFinite(dataMax)) return { max: 1, ticks: [0, 1] };

  const rough = dataMax / targetIntervals;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) * magnitude;

  const max = Math.ceil(dataMax / step) * step;
  const ticks: number[] = [];
  // The fudge keeps floating point from dropping the last tick.
  for (let value = 0; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return { max: ticks[ticks.length - 1] ?? max, ticks };
}

function chart(measure: BoardChart["measure"], unit: string, bars: BoardBar[]): BoardChart {
  const dataMax = dataMaxOf(bars);
  const { max, ticks } = niceTicks(dataMax);
  return { measure, unit, bars, max, dataMax, ticks };
}

function lengthsOf(cells: CellStat[]): { label: string; tokens: number; torture: boolean }[] {
  const seen = new Map<string, { label: string; tokens: number; torture: boolean }>();
  for (const c of cells) {
    if (!seen.has(c.nominalLabel)) {
      seen.set(c.nominalLabel, { label: c.nominalLabel, tokens: c.nominalTokens, torture: c.torture });
    }
  }
  return [...seen.values()].sort((a, b) => a.tokens - b.tokens);
}

// ------------------------------------------------------------------ build

/**
 * The headline sentence for a model: the two lanes compared on the biggest
 * prompt size both of them actually produced numbers for. The small sizes are
 * where two machines look most alike, so leading with one would flatter the
 * slower box.
 */
export function headlineFor(cells: CellStat[], lanes: string[]): string | null {
  if (lanes.length < 2) return null;
  for (const { label } of lengthsOf(cells).reverse()) {
    const a = cells.find((c) => c.laneLabel === lanes[0] && c.nominalLabel === label);
    const b = cells.find((c) => c.laneLabel === lanes[1] && c.nominalLabel === label);
    if (!a || !b) continue;
    const sentence = compareSentence(
      { label: a.laneLabel, read: a.readSpeed?.median ?? null, write: a.writeSpeed?.median ?? null },
      { label: b.laneLabel, read: b.readSpeed?.median ?? null, write: b.writeSpeed?.median ?? null },
    );
    if (sentence) return `At a ${label} prompt: ${sentence}`;
  }
  return null;
}

function firstWordChart(cells: CellStat[], lanes: string[]): BoardLineChart {
  const lengths = lengthsOf(cells).filter((l) => !l.torture);
  const series = lanes.map((lane, index) => ({
    laneLabel: lane,
    colorVar: colorFor(index),
    points: lengths.map((length, x) => ({
      x,
      label: length.label,
      y: cells.find((c) => c.laneLabel === lane && c.nominalLabel === length.label)?.firstWordSec?.median ?? null,
    })),
  }));
  const all = series.flatMap((s) => s.points.map((p) => p.y)).filter((v): v is number => v !== null);
  const dataMaxY = all.length === 0 ? 0 : Math.max(...all);
  const { max, ticks } = niceTicks(dataMaxY);
  return {
    series,
    xLabels: lengths.map((l) => l.label),
    maxY: max,
    dataMaxY,
    ticks,
    unit: "seconds",
  };
}

function powerRows(power: PowerReading[], modelId: string, lanes: string[], cells: CellStat[]): BoardPowerRow[] {
  const rows: BoardPowerRow[] = [];
  for (const lane of lanes) {
    const load = power.find((p) => p.laneLabel === lane && p.kind === "load" && p.modelId === modelId);
    const idle = power.find((p) => p.laneLabel === lane && p.kind === "idle");
    if (!load && !idle) continue;

    // Tokens per watt uses the writing speed the same machine reached on its
    // biggest prompt, so the two halves of the ratio describe the same work.
    const mine = cells.filter((c) => c.laneLabel === lane && c.writeSpeed !== null);
    const biggest = mine.sort((a, b) => a.nominalTokens - b.nominalTokens).at(-1);
    const write = biggest?.writeSpeed?.median ?? null;

    rows.push({
      laneLabel: lane,
      modelName: load?.modelName ?? null,
      loadWatts: load?.watts ?? null,
      idleWatts: idle?.watts ?? null,
      tokensPerWatt: write !== null && load && load.watts > 0 ? write / load.watts : null,
      holdSeconds: load?.holdSeconds ?? null,
    });
  }
  return rows;
}

export interface BoardInput {
  manifest: RunManifest;
  cells: CellStat[];
  engine: EngineCell[];
  power: PowerReading[];
  images?: ImageCellStat[];
  imageSettings?: { prompt: string; seed: number; width: number; height: number; steps: number | null } | null;
  video?: VideoCellStat[];
  videoSettings?: { width: number; height: number; frames: number; seed: number } | null;
}

/**
 * The video section. One bar per lane, seconds per clip.
 *
 * Every label carries two things the number cannot be read without: this is an
 * experimental community port, and the seconds include the model load because
 * the port prints one time for the whole invocation.
 */
function buildVideo(
  stats: VideoCellStat[],
  laneLabels: string[],
  settings: BoardInput["videoSettings"],
): BoardVideo[] | null {
  if (stats.length === 0) return null;

  const byModel = new Map<string, VideoCellStat[]>();
  for (const stat of stats) {
    const list = byModel.get(stat.modelId);
    if (list) list.push(stat);
    else byModel.set(stat.modelId, [stat]);
  }

  return [...byModel.values()].map((cells) => {
    const bars = laneLabels.map((lane, index) => {
      const cell = cells.find((c) => c.laneLabel === lane);
      const marks: string[] = [];
      if (!cell) marks.push("not run");
      else if (cell.status === "failed") marks.push("failed");
      else if (cell.status === "partial") marks.push(`${cell.clipsUsed}/${cell.clipsRecorded} used`);
      return {
        laneLabel: lane,
        colorVar: colorFor(index),
        median: cell?.secondsPerClip?.median ?? null,
        low: cell?.secondsPerClip?.low ?? null,
        high: cell?.secondsPerClip?.high ?? null,
        clip: cell?.sampleClip ?? null,
        marks,
      };
    });

    const tops = bars.map((b) => b.high ?? b.median).filter((v): v is number => v !== null);
    const dataMax = tops.length === 0 ? 0 : Math.max(...tops);
    const { max, ticks } = niceTicks(dataMax);

    return {
      modelName: cells[0]!.modelName,
      max,
      dataMax,
      ticks,
      bars,
      portCommit: cells.find((c) => c.portCommit)?.portCommit ?? null,
      clip: bars.find((b) => b.clip)?.clip ?? null,
      settings: settings ? `${settings.width}x${settings.height}, ${settings.frames} frames, seed ${settings.seed}` : null,
      disclosure: VIDEO_DISCLOSURE,
      notes: cells.flatMap((c) => c.notes.map((n) => `${c.laneLabel}: ${n}`)),
    };
  });
}

/**
 * The image section: one chart per model, a bar per lane in seconds per image,
 * and the pictures themselves underneath.
 *
 * The pictures are the proof. Every lane drew from one seed, so they should be
 * the same image; showing them lets a viewer check that rather than take it on
 * trust, and a checksum that differs is said out loud.
 */
function buildImages(
  stats: ImageCellStat[],
  laneLabels: string[],
  settings: BoardInput["imageSettings"],
): BoardImages | null {
  if (stats.length === 0) return null;

  const byModel = new Map<string, ImageCellStat[]>();
  for (const stat of stats) {
    const list = byModel.get(stat.modelId);
    if (list) list.push(stat);
    else byModel.set(stat.modelId, [stat]);
  }

  const models: BoardImageModel[] = [];
  for (const [modelId, cells] of byModel) {
    const bars: BoardImageBar[] = laneLabels.map((lane, index) => {
      const cell = cells.find((c) => c.laneLabel === lane);
      const marks: string[] = [];
      if (!cell) marks.push("not run");
      else {
        if (cell.status === "failed") marks.push("failed");
        if (cell.status === "partial") marks.push(`${cell.imagesUsed}/${cell.imagesRecorded} used`);
        if (cell.sha256 === null && cell.imagesUsed > 1) marks.push("images differ");
      }
      return {
        laneLabel: lane,
        colorVar: colorFor(index),
        median: cell?.secondsPerImage?.median ?? null,
        low: cell?.secondsPerImage?.low ?? null,
        high: cell?.secondsPerImage?.high ?? null,
        loadSeconds: cell?.loadSeconds ?? null,
        peakMemoryGb: cell?.peakMemoryGb ?? null,
        image: cell?.sampleImage ?? null,
        sha256: cell?.sha256 ?? null,
        status: cell?.status ?? "not-run",
        marks,
      };
    });

    const tops = bars.map((b) => b.high ?? b.median).filter((v): v is number => v !== null);
    const dataMax = tops.length === 0 ? 0 : Math.max(...tops);
    const { max, ticks } = niceTicks(dataMax);

    const known = cells.filter((c) => c.sha256 !== null);
    const distinct = [...new Set(known.map((c) => c.sha256))];
    const warnings =
      distinct.length > 1
        ? [
            `The lanes did not draw the same picture from the same seed: ` +
              `${known.map((c) => `${c.laneLabel} ${c.sha256!.slice(0, 8)}`).join(", ")}. ` +
              `Compare the pictures before trusting the times.`,
          ]
        : [];

    models.push({
      modelId,
      modelName: cells[0]!.modelName,
      kind: cells[0]!.kind,
      max,
      dataMax,
      ticks,
      bars,
      warnings,
      notes: cells.flatMap((c) => c.notes.map((n) => `${c.laneLabel}: ${n}`)),
    });
  }

  const withVersion = stats.find((s) => s.mfluxVersion !== null);
  return {
    models,
    prompt: settings?.prompt ?? null,
    seed: settings?.seed ?? null,
    size: settings ? `${settings.width}x${settings.height}` : null,
    steps: settings?.steps ?? null,
    mfluxVersion: withVersion?.mfluxVersion ?? null,
  };
}

export function buildBoard(input: BoardInput): BoardData {
  const { manifest, cells } = input;
  const lanes = manifest.lanes.map((l, i) => ({ label: l.label, colorVar: colorFor(i), managed: l.managed }));
  const laneLabels = lanes.map((l) => l.label);

  const models: BoardModel[] = [];
  for (const model of manifest.models) {
    // Matched on the model's KEY, so the same model measured on two machines
    // under two different per-machine paths lands under one heading. The id is
    // still accepted, for a cells.json written before keys existed.
    const key = model.dir ?? model.id;
    const mine = cells.filter((c) => (c.modelKey ?? c.modelId) === key || c.modelId === model.id);
    if (mine.length === 0) continue;

    const rows: BoardRow[] = lengthsOf(mine).map((length) => {
      const perLane = laneLabels.map((lane) =>
        mine.find((c) => c.laneLabel === lane && c.nominalLabel === length.label),
      );
      return {
        nominalLabel: length.label,
        nominalTokens: length.tokens,
        torture: length.torture,
        reading: chart(
          "reading",
          "prompt tokens/sec",
          perLane.map((cell, i) => bar(cell, laneLabels[i]!, i, cell?.readSpeed)),
        ),
        writing: chart(
          "writing",
          "output tokens/sec",
          perLane.map((cell, i) => bar(cell, laneLabels[i]!, i, cell?.writeSpeed)),
        ),
        truePromptTokens: perLane.map((c) => c?.truePromptTokens?.median ?? null),
        notes: perLane.flatMap((c, i) => (c?.notes ?? []).map((n) => `${laneLabels[i]}: ${n}`)),
      };
    });

    models.push({
      modelId: model.id,
      modelName: model.name,
      quantization: model.quantization ?? null,
      fileSize: model.fileSize ?? null,
      activeParams: model.activeParams ?? null,
      headline: headlineFor(mine, laneLabels),
      rows,
      firstWord: firstWordChart(mine, laneLabels),
      engine: input.engine
        .filter((e) => e.modelId === model.id)
        .map((e) => ({
          laneLabel: e.laneLabel,
          nominalLabel: e.nominalLabel,
          readMedian: e.promptTps?.median ?? null,
          readLow: e.promptTps?.low ?? null,
          readHigh: e.promptTps?.high ?? null,
          writeMedian: e.generationTps?.median ?? null,
          writeLow: e.generationTps?.low ?? null,
          writeHigh: e.generationTps?.high ?? null,
          peakMemoryGb: e.peakMemoryGb,
          trials: e.trials,
          unavailable: e.unavailable,
        })),
      power: powerRows(input.power, model.id, laneLabels, mine),
    });
  }

  const warnings: string[] = [];
  const failed = cells.filter((c) => c.status === "failed" || c.status === "no-valid-runs");
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} cell(s) produced no usable number: ${failed
        .map((c) => `${c.laneLabel} ${c.nominalLabel}`)
        .join(", ")}.`,
    );
  }
  const partial = cells.filter((c) => c.status === "partial");
  if (partial.length > 0) {
    warnings.push(`${partial.length} cell(s) had runs excluded. Every exclusion is named under its chart.`);
  }
  // Two machines reporting two versions is the normal case, and on a merged
  // run it is unavoidable -- the footer prints both. What would make a number
  // unreadable is ONE lane changing version partway through its own cells.
  for (const lane of laneLabels) {
    const versions = [...new Set(cells.filter((c) => c.laneLabel === lane).flatMap((c) => c.fingerprints))];
    if (versions.length > 1) {
      warnings.push(`${lane} did not stay on one server version during this benchmark: ${versions.join(", ")}.`);
    }
  }
  if (manifest.finishedAt === null) {
    warnings.push("This run did not finish. What is here is what it got through.");
  }

  const images = buildImages(input.images ?? [], laneLabels, input.imageSettings ?? null);
  const video = buildVideo(input.video ?? [], laneLabels, input.videoSettings ?? null);
  for (const model of images?.models ?? []) warnings.push(...model.warnings);

  return {
    runName: manifest.runName,
    lanes,
    models,
    images,
    video,
    footer: {
      measured: manifest.measured ?? ["llm"],
      outputCap: manifest.outputCap,
      measuredRuns: manifest.measuredRuns,
      warmupRuns: manifest.warmupRuns,
      restSeconds: manifest.restSeconds,
      temperature: manifest.temperature,
      disableThinking: manifest.disableThinking,
      promptFile: manifest.promptFile,
      fingerprints: manifest.fingerprints,
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      charsPerToken: manifest.charsPerToken,
    },
    warnings,
  };
}

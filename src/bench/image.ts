/**
 * The image benchmark: the same method as the language-model grid, applied to
 * pictures.
 *
 * A cell is one lane × one image model. Each cell is one discarded warm-up
 * image, then N measured ones, from an identical prompt, seed, size and step
 * count on every lane. Because the seed is fixed, every lane should draw the
 * SAME picture -- so the pictures come back and sit side by side on the board
 * as proof, and a checksum that differs between lanes is shown rather than
 * quietly averaged over.
 *
 * The one honest number is the seconds to make one image with the model
 * already in memory. Loading the weights is timed too, reported separately,
 * and never folded in: a machine with faster storage would otherwise look like
 * a machine with a faster GPU.
 */

import { BENCH_MODELS_ROOT } from "./config.ts";
import { envPath } from "./setup.ts";
import { remoteArg } from "./ssh.ts";
import type { BenchConfig, BenchLane, BenchModel, SshTarget } from "./types.ts";

/** Where the shim is copied to on the machine that runs it. */
export const REMOTE_SHIM_PATH = "~/bench-envs/mflux_bench.py";

/** Which mflux CLI drives a model, keyed by what its `dir` starts with. */
export type ImageKind = "flux2-klein" | "z-image-turbo";

/**
 * mflux's own default step count per model, read out of its test suite at the
 * pinned version (tests/arg_parser/test_default_steps.py): flux2-klein-4b is
 * 4, z-image-turbo is 9. Left unset here so the shim asks mflux rather than
 * carrying a second copy of the number that could drift from it.
 */
export const KIND_BY_REPO: Record<string, ImageKind> = {
  "black-forest-labs/FLUX.2-klein-4B": "flux2-klein",
  "Tongyi-MAI/Z-Image-Turbo": "z-image-turbo",
};

export function imageKindFor(model: BenchModel): ImageKind | null {
  if (model.hfRepo && KIND_BY_REPO[model.hfRepo]) return KIND_BY_REPO[model.hfRepo]!;
  const haystack = `${model.dir ?? ""} ${model.id}`.toLowerCase();
  if (haystack.includes("z-image")) return "z-image-turbo";
  if (haystack.includes("flux2") || haystack.includes("flux.2") || haystack.includes("klein")) return "flux2-klein";
  return null;
}

// ------------------------------------------------------------------ settings

export interface ImageSettings {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** null means "whatever mflux's default is for this model", which is the honest default. */
  steps: number | null;
  quantize: number | null;
  measuredImages: number;
  warmupImages: number;
  restSeconds: number;
  timeoutMs: number;
}

export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  prompt:
    "A cutaway illustration of a desktop computer on a workbench, warm afternoon light, " +
    "fine mechanical detail, shallow depth of field",
  seed: 42,
  width: 1024,
  height: 1024,
  steps: null,
  quantize: null,
  measuredImages: 5,
  warmupImages: 1,
  restSeconds: 30,
  timeoutMs: 60 * 60 * 1000,
};

export function imageSettingsFrom(config: BenchConfig, raw: unknown): ImageSettings {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (key: keyof ImageSettings, fallback: number): number =>
    typeof o[key] === "number" && Number.isFinite(o[key]) ? (o[key] as number) : fallback;

  return {
    prompt: typeof o.prompt === "string" && o.prompt.trim() !== "" ? o.prompt : DEFAULT_IMAGE_SETTINGS.prompt,
    seed: num("seed", DEFAULT_IMAGE_SETTINGS.seed),
    width: num("width", DEFAULT_IMAGE_SETTINGS.width),
    height: num("height", DEFAULT_IMAGE_SETTINGS.height),
    steps: typeof o.steps === "number" ? o.steps : null,
    quantize: typeof o.quantize === "number" ? o.quantize : null,
    measuredImages: num("measuredImages", DEFAULT_IMAGE_SETTINGS.measuredImages),
    warmupImages: num("warmupImages", DEFAULT_IMAGE_SETTINGS.warmupImages),
    restSeconds: num("restSeconds", config.restSeconds),
    timeoutMs: num("timeoutMs", DEFAULT_IMAGE_SETTINGS.timeoutMs),
  };
}

// ------------------------------------------------------------------ plan

export interface ImageCell {
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  kind: ImageKind;
  measuredImages: number;
}

export interface ImageLanePlan {
  lane: BenchLane;
  target: SshTarget;
  cells: ImageCell[];
}

export interface ImageGridPlan {
  lanes: ImageLanePlan[];
  totalCells: number;
  totalImages: number;
  settings: ImageSettings;
  /** Models configured as images that this tool cannot drive, and why. */
  unsupported: { modelName: string; why: string }[];
}

/**
 * The grid, worked out before anything runs.
 *
 * Only managed lanes: the shim has to be put on the machine and run there, and
 * a manual lane is one nobody has given this tool a way in to.
 */
export function planImageGrid(config: BenchConfig, settings: ImageSettings): ImageGridPlan {
  const unsupported: { modelName: string; why: string }[] = [];
  const imageModels = config.models.filter((m) => m.kind === "image");

  const lanes: ImageLanePlan[] = [];
  for (const lane of config.lanes) {
    if (!lane.ssh) continue;
    const wanted = lane.models ? new Set(lane.models) : null;
    const cells: ImageCell[] = [];

    for (const model of imageModels) {
      if (wanted && !wanted.has(model.id)) continue;
      const kind = imageKindFor(model);
      if (kind === null) {
        if (!unsupported.some((u) => u.modelName === model.name)) {
          unsupported.push({
            modelName: model.name,
            why: "this tool only drives FLUX.2 klein and Z-Image Turbo through mflux",
          });
        }
        continue;
      }
      cells.push({
        laneLabel: lane.label,
        modelId: model.id,
        modelName: model.name,
        dir: model.dir ?? model.id,
        kind,
        measuredImages: settings.measuredImages,
      });
    }

    if (cells.length > 0) lanes.push({ lane, target: lane.ssh, cells });
  }

  return {
    lanes,
    totalCells: lanes.reduce((n, l) => n + l.cells.length, 0),
    totalImages: lanes.reduce((n, l) => n + l.cells.length * settings.measuredImages, 0),
    settings,
    unsupported,
  };
}

export function imageCellKey(laneLabel: string, modelId: string): string {
  return JSON.stringify([laneLabel, modelId]);
}

// ------------------------------------------------------------------ commands

/** Where a cell's images are written on the machine that makes them. */
export function remoteImageDir(runName: string, dir: string): string {
  return `~/bench-images/${runName}/${dir}`;
}

export function installShimCommand(): string {
  const dest = remoteArg(REMOTE_SHIM_PATH, "shim path");
  return `mkdir -p "$(dirname ${dest})" && cat > ${dest} && echo SHIM_WRITTEN`;
}

export interface ShimCommandOptions {
  cell: ImageCell;
  settings: ImageSettings;
  runName: string;
}

/**
 * The shim, run inside the image environment on that machine.
 *
 * `--steps` is only passed when the config sets one. Left off, mflux picks the
 * step count it ships for that model -- 4 for flux2-klein-4b, 9 for
 * z-image-turbo -- which is the number its own tests pin, and a better default
 * than anything invented here.
 */
export function shimCommand(opts: ShimCommandOptions): string {
  const { cell, settings, runName } = opts;
  const python = remoteArg(`${envPath("image")}/bin/python`, "image environment python");
  const shim = remoteArg(REMOTE_SHIM_PATH, "shim path");
  const model = remoteArg(`${BENCH_MODELS_ROOT}/${cell.dir}`, "model directory");
  // The directory is validated like any other config-derived path; the
  // "/img_{i}.png" tail is our own literal, and its braces are the shim's
  // placeholder, so it is appended after the check rather than run through it.
  const outDir = remoteArg(remoteImageDir(runName, cell.dir), "image output directory");
  const output = `${outDir.replace(/'$/, "")}/img_{i}.png'`;

  const parts = [
    python,
    shim,
    "--kind",
    `'${cell.kind}'`,
    "--model",
    model,
    "--prompt",
    `'${settings.prompt.replace(/'/g, "'\\''")}'`,
    "--seed",
    `'${Math.trunc(settings.seed)}'`,
    "--width",
    `'${Math.trunc(settings.width)}'`,
    "--height",
    `'${Math.trunc(settings.height)}'`,
    "--count",
    `'${Math.trunc(cell.measuredImages)}'`,
    "--warmup",
    `'${Math.trunc(settings.warmupImages)}'`,
    "--output",
    output,
  ];
  if (settings.steps !== null) parts.push("--steps", `'${Math.trunc(settings.steps)}'`);
  if (settings.quantize !== null) parts.push("--quantize", `'${Math.trunc(settings.quantize)}'`);
  return parts.join(" ");
}

// ------------------------------------------------------------------ parsing

export interface ShimImage {
  index: number;
  warmup: boolean;
  seconds: number;
  path: string;
  sha256: string;
  /** "pixels" when the picture itself was hashed, "file" when only the bytes were. */
  checksumOf: "pixels" | "file";
}

export interface ShimOutput {
  mfluxVersion: string | null;
  mlxVersion: string | null;
  loadSeconds: number | null;
  images: ShimImage[];
  peakMemoryGb: number | null;
  error: string | null;
}

/**
 * Reads the shim's JSON lines.
 *
 * Tolerant of anything else on the stream: mflux and its dependencies print
 * progress bars and warnings, and a benchmark that fell over because a library
 * logged a deprecation would be a bad benchmark.
 */
export function parseShimOutput(stdout: string): ShimOutput {
  const out: ShimOutput = {
    mfluxVersion: null,
    mlxVersion: null,
    loadSeconds: null,
    images: [],
    peakMemoryGb: null,
    error: null,
  };

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (event.event) {
      case "versions":
        out.mfluxVersion = typeof event.mflux === "string" ? event.mflux : null;
        out.mlxVersion = typeof event.mlx === "string" ? event.mlx : null;
        break;
      case "loaded":
        if (typeof event.seconds === "number") out.loadSeconds = event.seconds;
        break;
      case "image":
        if (typeof event.seconds === "number" && typeof event.index === "number") {
          out.images.push({
            index: event.index,
            warmup: event.warmup === true,
            seconds: event.seconds,
            path: typeof event.path === "string" ? event.path : "",
            sha256: typeof event.sha256 === "string" ? event.sha256 : "",
            checksumOf: event.checksum_of === "pixels" ? "pixels" : "file",
          });
        }
        break;
      case "done":
        out.peakMemoryGb = typeof event.peak_memory_gb === "number" ? event.peak_memory_gb : null;
        break;
      case "error":
        out.error = typeof event.message === "string" ? event.message : "the shim reported an error";
        break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ records

export interface ImageRunRecord {
  ts: string;
  runName: string;
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  kind: ImageKind;
  /** 0 for the discarded warm-up, then 1..N. */
  runIndex: number;
  warmup: boolean;
  /** Seconds to make this image, model already loaded. */
  seconds: number | null;
  /** Seconds to load the weights. Reported once per cell, never mixed in. */
  loadSeconds: number | null;
  seed: number;
  width: number;
  height: number;
  steps: number | null;
  prompt: string;
  remotePath: string;
  /** Where the picture ended up in the run folder, if it was copied back. */
  localFile: string | null;
  sha256: string;
  /** Whether that checksum is of the pixels or only of the file bytes. */
  checksumOf: "pixels" | "file";
  peakMemoryGb: number | null;
  mfluxVersion: string | null;
  mlxVersion: string | null;
  error: string | null;
}

export interface ImageCellStat {
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  kind: ImageKind;
  status: "ok" | "partial" | "failed" | "not-run";
  imagesRecorded: number;
  imagesUsed: number;
  secondsPerImage: { median: number; low: number; high: number; n: number } | null;
  loadSeconds: number | null;
  peakMemoryGb: number | null;
  /** The checksum every measured image of this cell shared, when they agreed. */
  sha256: string | null;
  sampleImage: string | null;
  mfluxVersion: string | null;
  mlxVersion: string | null;
  notes: string[];
}

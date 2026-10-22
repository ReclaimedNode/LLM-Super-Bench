/**
 * The video benchmark: LTX-2.5 through an MLX port, timed the same way as
 * everything else here.
 *
 * Labelled experimental on the board on purpose. The weights are a community
 * quantisation and the runner is a port, pinned to one commit so a number can
 * be reproduced, and the whole thing is fail-soft: if it will not install or
 * will not run, the rest of the tool is unaffected and the board says why.
 *
 * One honesty note that shows up in every label: the port's CLI loads the
 * model and generates in a single invocation and prints one "Time:" line for
 * the lot, so seconds-per-clip here INCLUDES the model load. Unlike the image
 * side there is no way to split them without writing another shim, and one
 * piece of Python in this repo is already one more than the house style wants.
 * Every lane pays the same load, so lanes stay comparable; the number is just
 * not a pure generation time, and it never claims to be.
 */

import { BENCH_MODELS_ROOT } from "./config.ts";
import { stat3 } from "./stats.ts";
import { remoteArg } from "./ssh.ts";
import type { BenchConfig, BenchLane, SshTarget } from "./types.ts";

/** The port, pinned. A moving branch is not a measurement you can repeat. */
export const LTX_REPO = "https://github.com/xocialize/ltx-2-mlx.git";
export const LTX_BRANCH = "ltx-2.5";
export const LTX_COMMIT = "c952c8f601e4fc5371d91b609ef5e0d85ba23751";
export const LTX_CHECKOUT = "~/bench-envs/ltx-2-mlx";

/**
 * What the licence requires to be said, wherever a clip from this is shown.
 *
 * Not a nicety: the LTX-2 Community License's acceptable-use policy forbids
 * generating or disseminating content "without expressly and intelligibly
 * disclaiming that the information and/or content is machine generated", and
 * §6 puts the transparency obligations on the person deploying it.
 */
export const VIDEO_DISCLOSURE =
  "These clips are machine generated. The LTX-2 Community License requires that to be said plainly " +
  "wherever they are shown.";

export interface VideoSettings {
  prompt: string;
  seed: number;
  width: number;
  height: number;
  /** LTX wants 8k+1: 49 frames is 2 seconds at 24fps. */
  frames: number;
  /** null leaves the port's own default (8 for one-stage). */
  steps: number | null;
  measuredClips: number;
  warmupClips: number;
  restSeconds: number;
  timeoutMs: number;
  /** The port streams the DiT under this flag, which is what keeps peak memory down. */
  lowRam: boolean;
}

/**
 * Deliberately small.
 *
 * 512x288 at 49 frames is two seconds of video, well inside the geometries the
 * model card reports measuring, and the point of the default is that it
 * finishes in a few minutes on the older machine rather than that it looks
 * impressive. Nothing here has been timed, so the default errs small.
 */
export const DEFAULT_VIDEO_SETTINGS: VideoSettings = {
  prompt: "A slow push in on a desk lamp switching on in a dark workshop, dust in the beam",
  seed: 42,
  width: 512,
  height: 288,
  frames: 49,
  steps: null,
  measuredClips: 3,
  warmupClips: 1,
  restSeconds: 30,
  timeoutMs: 90 * 60 * 1000,
  lowRam: true,
};

export function videoSettingsFrom(config: BenchConfig, raw: unknown): VideoSettings {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const num = (key: keyof VideoSettings, fallback: number): number =>
    typeof o[key] === "number" && Number.isFinite(o[key]) ? (o[key] as number) : fallback;
  return {
    prompt: typeof o.prompt === "string" && o.prompt.trim() !== "" ? o.prompt : DEFAULT_VIDEO_SETTINGS.prompt,
    seed: num("seed", DEFAULT_VIDEO_SETTINGS.seed),
    width: num("width", DEFAULT_VIDEO_SETTINGS.width),
    height: num("height", DEFAULT_VIDEO_SETTINGS.height),
    frames: num("frames", DEFAULT_VIDEO_SETTINGS.frames),
    steps: typeof o.steps === "number" ? o.steps : null,
    measuredClips: num("measuredClips", DEFAULT_VIDEO_SETTINGS.measuredClips),
    warmupClips: num("warmupClips", DEFAULT_VIDEO_SETTINGS.warmupClips),
    restSeconds: num("restSeconds", config.restSeconds),
    timeoutMs: num("timeoutMs", DEFAULT_VIDEO_SETTINGS.timeoutMs),
    lowRam: o.lowRam !== false,
  };
}

/** LTX compresses in eights: a frame count that is not 8k+1 is not a valid clip. */
export function isValidFrameCount(frames: number): boolean {
  return Number.isInteger(frames) && frames >= 9 && (frames - 1) % 8 === 0;
}

/** The nearest valid 8k+1 frame count at or below `frames`. */
export function nearestFrameCount(frames: number): number {
  if (frames < 9) return 9;
  return Math.floor((frames - 1) / 8) * 8 + 1;
}

// ------------------------------------------------------------------ plan

export interface VideoCell {
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  measuredClips: number;
}

export interface VideoLanePlan {
  lane: BenchLane;
  target: SshTarget;
  cells: VideoCell[];
}

export interface VideoGridPlan {
  lanes: VideoLanePlan[];
  totalCells: number;
  totalClips: number;
  settings: VideoSettings;
}

export function planVideoGrid(config: BenchConfig, settings: VideoSettings): VideoGridPlan {
  const models = config.models.filter((m) => m.kind === "video");
  const lanes: VideoLanePlan[] = [];

  for (const lane of config.lanes) {
    if (!lane.ssh) continue;
    const wanted = lane.models ? new Set(lane.models) : null;
    const cells = models
      .filter((m) => !wanted || wanted.has(m.id))
      .map((m) => ({
        laneLabel: lane.label,
        modelId: m.id,
        modelName: m.name,
        dir: m.dir ?? m.id,
        measuredClips: settings.measuredClips,
      }));
    if (cells.length > 0) lanes.push({ lane, target: lane.ssh, cells });
  }

  return {
    lanes,
    totalCells: lanes.reduce((n, l) => n + l.cells.length, 0),
    totalClips: lanes.reduce((n, l) => n + l.cells.length * settings.measuredClips, 0),
    settings,
  };
}

// ------------------------------------------------------------------ commands

/**
 * Clone the port at its pinned commit, or leave it alone if it is already
 * there at that commit. Never a bare `git pull`: the whole reason the commit
 * is written down is that the numbers should not move when the branch does.
 */
export function installPortCommand(): string {
  const dir = remoteArg(LTX_CHECKOUT, "port checkout");
  return (
    `export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"; ` +
    `if [ -d ${dir}/.git ]; then ` +
    `  cd ${dir} && [ "$(git rev-parse HEAD)" = '${LTX_COMMIT}' ] && echo PORT_PRESENT && exit 0; ` +
    `fi; ` +
    `mkdir -p "$(dirname ${dir})" && rm -rf ${dir} && ` +
    `git clone --branch '${LTX_BRANCH}' '${LTX_REPO}' ${dir} && ` +
    // Plain sync, not --all-extras: the extras pull in the port's trainer,
    // which is not needed to generate a clip and is one more thing to fail.
    `cd ${dir} && git checkout '${LTX_COMMIT}' && uv sync && echo PORT_INSTALLED`
  );
}

export function portVersionCommand(): string {
  const dir = remoteArg(LTX_CHECKOUT, "port checkout");
  return `cd ${dir} 2>/dev/null && git rev-parse --short HEAD || echo NO_PORT`;
}

export interface VideoCommandOptions {
  cell: VideoCell;
  settings: VideoSettings;
  runName: string;
  index: number;
}

export function remoteVideoDir(runName: string, dir: string): string {
  return `~/bench-video/${runName}/${dir}`;
}

export function generateClipCommand(opts: VideoCommandOptions): string {
  const { cell, settings, runName, index } = opts;
  const checkout = remoteArg(LTX_CHECKOUT, "port checkout");
  const model = remoteArg(`${BENCH_MODELS_ROOT}/${cell.dir}`, "model directory");
  const outDir = remoteArg(remoteVideoDir(runName, cell.dir), "video output directory");
  const output = `${outDir.replace(/'$/, "")}/clip_${index}.mp4'`;

  const parts = [
    `export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH";`,
    `mkdir -p ${outDir} &&`,
    `cd ${checkout} &&`,
    // --no-sync, and never a bare `uv run`. The port's virtual environment
    // carries a hand-installed mlx-lm built from main, which the lockfile
    // knows nothing about; a sync silently replaces it with the locked
    // version, and the older one has no gemma4_unified text encoder, which is
    // the encoder these weights need. Seen live: one `uv run` put the
    // environment back to 0.31.1 and the model stopped loading.
    "uv run --no-sync ltx-2-mlx generate",
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
    "--frames",
    `'${Math.trunc(settings.frames)}'`,
    "--output",
    output,
  ];
  if (settings.steps !== null) parts.push("--steps", `'${Math.trunc(settings.steps)}'`);
  if (settings.lowRam) parts.push("--low-ram");
  return parts.join(" ");
}

// ------------------------------------------------------------------ parsing

/**
 * The port prints `Time: 83.4s` when it finishes. That is the whole
 * invocation -- weights loaded and clip generated -- which is why every label
 * on this number says so.
 */
/**
 * The END of a command's output, which is where the reason it failed is.
 *
 * Learnt live: a clone that worked and a build that did not produced 300
 * characters of git's "you are in detached HEAD state" advice, and the actual
 * error -- a packaging fault three screens further down -- never reached the
 * terminal at all.
 */
export function lastOutput(text: string, limit = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

export function parseClipSeconds(stdout: string): number | null {
  const matches = [...stdout.matchAll(/^\s*Time:\s*([\d.]+)s\s*$/gm)];
  const last = matches.at(-1);
  if (!last) return null;
  const seconds = Number(last[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

export function parseSavedPath(stdout: string): string | null {
  const match = /Saved to:\s*(\S+)/.exec(stdout);
  return match ? match[1]! : null;
}

// ------------------------------------------------------------------ records

export interface VideoRunRecord {
  ts: string;
  runName: string;
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  runIndex: number;
  warmup: boolean;
  /** Seconds for the whole invocation: model load AND generation. */
  secondsIncludingLoad: number | null;
  seed: number;
  width: number;
  height: number;
  frames: number;
  steps: number | null;
  prompt: string;
  portCommit: string;
  remotePath: string;
  localFile: string | null;
  error: string | null;
}

export interface VideoCellStat {
  laneLabel: string;
  modelId: string;
  modelName: string;
  dir: string;
  status: "ok" | "partial" | "failed" | "not-run";
  clipsRecorded: number;
  clipsUsed: number;
  secondsPerClip: { median: number; low: number; high: number; n: number } | null;
  portCommit: string | null;
  sampleClip: string | null;
  notes: string[];
}

export function videoCellKeyOf(r: { laneLabel: string; modelId: string }): string {
  return JSON.stringify([r.laneLabel, r.modelId]);
}

export function summariseVideoCells(cells: VideoCell[], records: VideoRunRecord[]): VideoCellStat[] {
  const byCell = new Map<string, VideoRunRecord[]>();
  for (const record of records) {
    const key = videoCellKeyOf(record);
    const list = byCell.get(key);
    if (list) list.push(record);
    else byCell.set(key, [record]);
  }

  return cells.map((cell) => {
    const mine = byCell.get(videoCellKeyOf(cell)) ?? [];
    const measured = mine.filter((r) => !r.warmup);
    const used = measured.filter((r) => r.error === null && r.secondsIncludingLoad !== null);
    const notes: string[] = [];
    const failed = measured.filter((r) => r.error !== null).length;
    if (failed > 0) notes.push(`${failed} of ${measured.length} clips failed.`);

    let status: VideoCellStat["status"];
    if (measured.length === 0) status = "not-run";
    else if (used.length === 0) status = "failed";
    else if (used.length < measured.length) status = "partial";
    else status = "ok";

    const sample = used.find((r) => r.localFile !== null);
    return {
      laneLabel: cell.laneLabel,
      modelId: cell.modelId,
      modelName: cell.modelName,
      dir: cell.dir,
      status,
      clipsRecorded: measured.length,
      clipsUsed: used.length,
      secondsPerClip: stat3(used.map((r) => r.secondsIncludingLoad).filter((v): v is number => v !== null)),
      portCommit: mine.find((r) => r.portCommit)?.portCommit ?? null,
      sampleClip: sample?.localFile ?? null,
      notes,
    };
  });
}

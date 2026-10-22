/**
 * `bun run draw` -- one prompt, every Mac, one picture each, for the camera.
 *
 * This is a show, not a measurement. Every lane starts drawing at the same
 * moment, so each machine is working while the other one is, and the seconds
 * they report are seconds under exactly the conditions the audience can see.
 * A benchmark wants the opposite: `bun run imagebench` runs one machine at a
 * time, throws the first picture away and measures five more, and that is the
 * number worth quoting anywhere.
 *
 * Nothing here re-implements the machinery that already exists. Reaching a
 * sleeping Mac is `reachLane`, putting the timing shim on it is
 * `installShimCommand`, reading what it printed is `parseShimOutput`, and
 * bringing the picture back is `fetchRemoteFile`. What this file adds is the
 * one-prompt-one-picture shape, the parallel start, and the plain English.
 *
 * Everything above `runDraw` is pure: the argument parsing, the remote command
 * string, the file names, the verdict line and the exit rule are all functions
 * of their input, so they can be proven without a Mac in the room.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { BENCH_MODELS_ROOT } from "./config.ts";
import { REMOTE_SHIM_PATH, installShimCommand, parseShimOutput } from "./image.ts";
import type { ImageKind } from "./image.ts";
import { reachLane } from "./reach.ts";
import type { Pinger } from "./reach.ts";
import { envPath } from "./setup.ts";
import { fetchRemoteFile, remoteArg, runRemote, runRemoteWithInput } from "./ssh.ts";
import type { RemoteRunner } from "./ssh.ts";
import type { BenchConfig, BenchLane, SshTarget } from "./types.ts";

/** Something a person got wrong, said in a sentence they can act on. */
export class DrawError extends Error {}

// ------------------------------------------------------------------ settings

export type DrawModelKey = "flux" | "zimage";

export interface DrawModel {
  key: DrawModelKey;
  /** What it is called on screen. */
  name: string;
  /** The folder it sits in under ~/bench-models on every machine. */
  dir: string;
  /** Which mflux CLI drives it. */
  kind: ImageKind;
}

export const DRAW_MODELS: Record<DrawModelKey, DrawModel> = {
  flux: { key: "flux", name: "FLUX.2 klein 4B", dir: "FLUX.2-klein-4B", kind: "flux2-klein" },
  zimage: { key: "zimage", name: "Z-Image Turbo", dir: "Z-Image-Turbo", kind: "z-image-turbo" },
};

/** The same fixed seed the image benchmark uses, so every lane draws the same picture. */
export const DRAW_SEED = 42;
/** One square picture, the size the benchmark uses, so the two are comparable. */
export const DRAW_SIZE = 1024;
/**
 * How long one lane may take. Generous on purpose: the first draw of the day
 * reads tens of gigabytes of weights off the disk before it draws anything,
 * and a run that gave up in the middle of that on camera would be worse than
 * a run that waited.
 */
export const DRAW_TIMEOUT_MS = 20 * 60_000;
/** Copying one PNG back over the network. */
export const DRAW_FETCH_TIMEOUT_MS = 5 * 60_000;

// ------------------------------------------------------------------ arguments

export interface DrawArgs {
  help: boolean;
  prompt: string;
  model: DrawModel;
  /** Lane labels the person named. Empty means every lane this tool can reach. */
  lanes: string[];
  seed: number;
  open: boolean;
}

const VALUE_FLAGS = new Set(["--model", "--lane", "--seed"]);

/** "Z-Image" and "zimage" are the same word said two ways. */
function modelFor(value: string): DrawModel {
  const normalised = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalised === "flux" || normalised === "flux2" || normalised === "flux2klein") return DRAW_MODELS.flux;
  if (normalised === "zimage" || normalised === "zimageturbo") return DRAW_MODELS.zimage;
  throw new DrawError(`I do not know the model "${value}". It is either flux or zimage.`);
}

export function parseDrawArgs(argv: string[]): DrawArgs {
  const bare: string[] = [];
  const lanes: string[] = [];
  let model = DRAW_MODELS.flux;
  let seed = DRAW_SEED;
  let open = true;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--no-open") {
      open = false;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new DrawError(`${arg} needs a value after it.`);
      i++;
      if (arg === "--model") model = modelFor(value);
      else if (arg === "--lane") lanes.push(value);
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) throw new DrawError(`--seed takes a whole number, not "${value}".`);
        seed = parsed;
      }
      continue;
    }

    if (arg.startsWith("-")) throw new DrawError(`I do not know the option ${arg}. Run bun run draw --help.`);
    bare.push(arg);
  }

  if (help) return { help: true, prompt: "", model, lanes, seed, open };

  if (bare.length === 0) {
    throw new DrawError(`Tell me what to draw, in quotes: bun run draw "a fox reading in a library".`);
  }
  if (bare.length > 1) {
    throw new DrawError(
      `Put the whole prompt inside one pair of quotes. I was given ${bare.length} separate words or phrases: ` +
        bare.map((b) => `"${b}"`).join(", "),
    );
  }

  return { help: false, prompt: bare[0]!, model, lanes, seed, open };
}

// ------------------------------------------------------------------ lanes

export interface DrawLane {
  lane: BenchLane;
  target: SshTarget;
}

/** A lane label as a file name: "M5 Ultra 256GB" becomes "m5-ultra-256gb". */
export function laneSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "lane" : slug;
}

/**
 * Which machines draw.
 *
 * Every lane the config gives a way in to, unless the person named some. A
 * name is matched as written or as its file-name form, so `--lane m5-ultra-256gb`
 * works as well as `--lane "M5 Ultra 256GB"`.
 */
export function drawLanes(config: BenchConfig, wanted: string[] = []): DrawLane[] {
  const managed = config.lanes.filter((lane): lane is BenchLane & { ssh: SshTarget } => lane.ssh !== undefined);
  if (managed.length === 0) {
    throw new DrawError("No lane in bench.config.json has an `ssh` block, so there is no machine to draw on.");
  }

  if (wanted.length === 0) return managed.map((lane) => ({ lane, target: lane.ssh }));

  const chosen: DrawLane[] = [];
  for (const name of wanted) {
    const hit = managed.find((lane) => lane.label === name || laneSlug(lane.label) === laneSlug(name));
    if (!hit) {
      throw new DrawError(
        `There is no lane called "${name}". The ones in bench.config.json are: ${managed.map((l) => l.label).join(", ")}.`,
      );
    }
    if (!chosen.some((c) => c.lane.label === hit.label)) chosen.push({ lane: hit, target: hit.ssh });
  }
  return chosen;
}

// ------------------------------------------------------------------ paths

export const DRAW_RESULTS_ROOT = resolve(PROJECT_ROOT, "results/draw");

/** Where this run's pictures land on this Mac. */
export function drawRunDir(stamp: string): string {
  return resolve(DRAW_RESULTS_ROOT, stamp);
}

/** One lane's picture on this Mac. */
export function localDrawPath(stamp: string, laneLabel: string): string {
  return resolve(drawRunDir(stamp), `${laneSlug(laneLabel)}.png`);
}

/** Where the picture is written on the machine that draws it. */
export function remoteDrawDir(stamp: string): string {
  return `~/bench-draw/${stamp}`;
}

// ------------------------------------------------------------------ command

export interface DrawCommandOptions {
  model: DrawModel;
  prompt: string;
  seed: number;
  stamp: string;
}

/**
 * The shim, run inside the image environment on that machine, for one picture.
 *
 * No warm-up and no step count: the audience is watching a cold machine draw
 * one picture, and mflux's own default step count for that model is a better
 * number than anything invented here.
 *
 * Every path comes from the config or from this file's own constants and goes
 * through `remoteArg`, which refuses anything a shell could act on. The prompt
 * is the exception -- it is whatever the person typed, spaces and all -- so it
 * is single quoted with its own quotes escaped, exactly as the image benchmark
 * does it, and it can only ever be one argument.
 */
export function drawCommand(opts: DrawCommandOptions): string {
  const { model, prompt, seed, stamp } = opts;
  const python = remoteArg(`${envPath("image")}/bin/python`, "image environment python");
  const shim = remoteArg(REMOTE_SHIM_PATH, "shim path");
  const modelPath = remoteArg(`${BENCH_MODELS_ROOT}/${model.dir}`, "model directory");
  // The directory is checked like any other path; the "/img_{i}.png" tail is
  // our own literal, and its braces are the shim's placeholder, so it is
  // appended after the check rather than run through it.
  const outDir = remoteArg(remoteDrawDir(stamp), "draw output directory");
  const output = `${outDir.replace(/'$/, "")}/img_{i}.png'`;

  return [
    python,
    shim,
    "--kind",
    `'${model.kind}'`,
    "--model",
    modelPath,
    "--prompt",
    `'${prompt.replace(/'/g, "'\\''")}'`,
    "--seed",
    `'${Math.trunc(seed)}'`,
    "--width",
    `'${DRAW_SIZE}'`,
    "--height",
    `'${DRAW_SIZE}'`,
    "--count",
    "'1'",
    "--warmup",
    "'0'",
    "--output",
    output,
  ].join(" ");
}

/** Opening the pictures is macOS's `open`, as an argument array, never a shell string. */
export function openArgs(paths: string[]): string[] {
  return ["open", ...paths];
}

// ------------------------------------------------------------------ results

export interface DrawLaneResult {
  label: string;
  ok: boolean;
  /** Seconds to read the weights in. Never added to the drawing time. */
  loadSeconds: number | null;
  /** Seconds to draw the picture, with the model already in memory. */
  drawSeconds: number | null;
  /** Where the picture ended up on this Mac. */
  localPath: string | null;
  /** Plain English, when something went wrong on this lane. */
  error: string | null;
}

/** What one lane's block says on screen. */
export function laneReport(result: DrawLaneResult): string[] {
  const lines = [`  ${result.label}`];
  if (result.loadSeconds !== null) lines.push(`    loaded the model in ${result.loadSeconds.toFixed(1)} s`);
  if (result.drawSeconds !== null) lines.push(`    drew the picture in ${result.drawSeconds.toFixed(2)} s`);
  if (result.localPath !== null) lines.push(`    picture: ${result.localPath}`);
  if (result.error !== null) lines.push(`    ${result.error}`);
  return lines;
}

/**
 * The one line that compares the machines.
 *
 * Fastest against slowest, from the drawing time alone -- the weight load is
 * reported beside it and never folded in, because a machine with a faster
 * disk would otherwise look like a machine with a faster chip. Null when
 * fewer than two lanes came back with a picture: there is nothing to compare.
 */
export function verdictLine(results: DrawLaneResult[]): string | null {
  const drawn = results
    .filter((r) => r.ok && r.drawSeconds !== null)
    .sort((a, b) => a.drawSeconds! - b.drawSeconds!);
  if (drawn.length < 2) return null;

  const fastest = drawn[0]!;
  const slowest = drawn.at(-1)!;
  const times = `(${fastest.drawSeconds!.toFixed(2)} s against ${slowest.drawSeconds!.toFixed(2)} s)`;
  const ratio = slowest.drawSeconds! / fastest.drawSeconds!;

  if (ratio.toFixed(1) === "1.0") {
    return `${fastest.label} and ${slowest.label} drew it in about the same time ${times}.`;
  }
  return `${fastest.label} drew it ${ratio.toFixed(1)}x faster than ${slowest.label} ${times}.`;
}

/**
 * Non-zero when any lane failed, and when nothing ran at all.
 *
 * One machine falling over never stops the other -- the lanes run
 * independently and every one of them finishes -- but the command still says
 * it went wrong, so a script driving this is not told everything was fine.
 */
export function drawExitCode(results: DrawLaneResult[]): number {
  if (results.length === 0) return 1;
  return results.every((r) => r.ok) ? 0 : 1;
}

// ------------------------------------------------------------------ running

export interface DrawRunOptions {
  lanes: DrawLane[];
  model: DrawModel;
  prompt: string;
  seed: number;
  stamp: string;
  /** The timing shim's source, sent down the same ssh that runs it. */
  shimSource: string;
  /** One plain line at a time, as each machine gets on with it. */
  log?: (laneLabel: string, message: string) => void;
  /** Test seams. Everything that touches a machine or the disk goes through one. */
  run?: RemoteRunner;
  sendShim?: typeof runRemoteWithInput;
  fetchFile?: typeof fetchRemoteFile;
  write?: (path: string, bytes: Uint8Array) => Promise<void>;
  ping?: Pinger;
  sleepFor?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

async function writeLocalFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, bytes);
}

/**
 * Every lane draws at once.
 *
 * That is the whole point of this command and the reason its seconds are not a
 * measurement. Each lane is walked end to end on its own and catches its own
 * failures, so one Mac being asleep, missing the model, or falling over
 * mid-draw costs that lane its picture and nothing else.
 */
export async function runDraw(opts: DrawRunOptions): Promise<DrawLaneResult[]> {
  const run = opts.run ?? runRemote;
  const sendShim = opts.sendShim ?? runRemoteWithInput;
  const fetchFile = opts.fetchFile ?? fetchRemoteFile;
  const write = opts.write ?? writeLocalFile;
  const timeoutMs = opts.timeoutMs ?? DRAW_TIMEOUT_MS;
  const say = (label: string, message: string) => opts.log?.(label, message);

  const command = drawCommand({ model: opts.model, prompt: opts.prompt, seed: opts.seed, stamp: opts.stamp });

  const drawOne = async (lane: DrawLane): Promise<DrawLaneResult> => {
    const label = lane.lane.label;
    const blank: DrawLaneResult = { label, ok: false, loadSeconds: null, drawSeconds: null, localPath: null, error: null };

    try {
      const reachable = await reachLane(lane.target, {
        run,
        ping: opts.ping,
        sleep: opts.sleepFor,
        log: (message) => say(label, message),
      });
      if (!reachable.ok) return { ...blank, error: reachable.detail };

      const sent = await sendShim(lane.target, installShimCommand(), opts.shimSource, { timeoutMs: 60_000 });
      if (!sent.stdout.includes("SHIM_WRITTEN")) {
        return {
          ...blank,
          error: `could not put the timing shim on this machine: ${(sent.stderr || "").trim().slice(0, 200)}`,
        };
      }

      say(label, "drawing");
      const result = await run(lane.target, command, { timeoutMs });
      const parsed = parseShimOutput(`${result.stdout}\n${result.stderr}`);

      if (parsed.error !== null || parsed.images.length === 0) {
        return {
          ...blank,
          loadSeconds: parsed.loadSeconds,
          error:
            parsed.error ??
            `no picture came back: ${(result.stderr || result.stdout).trim().slice(0, 300) || "the shim printed nothing"}`,
        };
      }

      const image = parsed.images.find((i) => !i.warmup) ?? parsed.images[0]!;
      const drawn: DrawLaneResult = {
        ...blank,
        loadSeconds: parsed.loadSeconds,
        drawSeconds: image.seconds,
      };

      const bytes = await fetchFile(lane.target, image.path, { timeoutMs: DRAW_FETCH_TIMEOUT_MS });
      if (!bytes) {
        return { ...drawn, error: `it drew the picture in ${image.seconds.toFixed(2)} s, but the file would not copy back.` };
      }

      const localPath = localDrawPath(opts.stamp, label);
      await write(localPath, bytes);
      say(label, `done in ${image.seconds.toFixed(2)} s`);
      return { ...drawn, ok: true, localPath };
    } catch (err) {
      return { ...blank, error: `something went wrong talking to this machine: ${String(err)}` };
    }
  };

  return await Promise.all(opts.lanes.map(drawOne));
}

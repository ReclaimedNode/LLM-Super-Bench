/**
 * `bun run clip` -- one prompt, every Mac, one short video each, for the camera.
 *
 * The moving-picture twin of `bun run draw`, and the same warning applies twice
 * over. Every lane starts generating at the same moment, so each machine is
 * working while the other one is, and on top of that the port cannot separate
 * loading the model from making the clip: it prints one `Time:` line for the
 * whole invocation. So the seconds here are a show, not a measurement, and
 * every label on them says both things out loud. The honest number comes from
 * `bun run videobench`, which uses one machine at a time and throws the first
 * clip away.
 *
 * Nothing here re-implements the machinery that already exists. Reaching a
 * sleeping Mac is `reachLane`, the pinned checkout is `LTX_CHECKOUT`, the model
 * root is `BENCH_MODELS_ROOT`, reading the port's timing is `parseClipSeconds`,
 * the tail of a failed command is `lastOutput`, and bringing the clip back is
 * `fetchRemoteFile`. What this file adds is the one-prompt-one-clip shape, the
 * parallel start, and the plain English.
 *
 * Everything above `runClip` is pure: the argument parsing, the remote command
 * string, the file names, the verdict line and the exit rule are all functions
 * of their input, so they can be proven without a Mac in the room.
 */

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { BENCH_MODELS_ROOT } from "./config.ts";
import { laneSlug } from "./draw.ts";
import { reachLane } from "./reach.ts";
import type { Pinger } from "./reach.ts";
import { FILE_WRITTEN, fetchRemoteFile, remoteArg, runRemote, sendRemoteFile } from "./ssh.ts";
import type { RemoteRunner } from "./ssh.ts";
import type { BenchConfig, BenchLane, SshTarget } from "./types.ts";
import { LTX_CHECKOUT, lastOutput, parseClipSeconds } from "./video.ts";

/** Something a person got wrong, said in a sentence they can act on. */
export class ClipError extends Error {}

// ------------------------------------------------------------------ settings

/** The quantised LTX-2.5 weights, in the same models folder as everything else. */
export const CLIP_MODEL_DIR = "ltx-2.5-mlx-q8";

/**
 * The port's own virtual environment, entered directly rather than through
 * `uv run`, which wants a network and a lock check before it will start.
 */
export const CLIP_RUNNER = ".venv/bin/ltx-2-mlx";

/**
 * The reason this line exists: the port finds ffmpeg with `shutil.which`, and
 * on one of these Macs ffmpeg lives in ~/.local/bin while on the other it
 * lives in /opt/homebrew/bin. A plain ssh shell is not a login shell and has
 * neither on its PATH, so without this the clip encodes to nothing at all.
 */
export const CLIP_PATH_EXPORT = "export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH";

/** 24 frames a second, which is what the frame counts below are counted in. */
export const CLIP_FRAME_RATE = 24;

/** The seed every lane generates with, so the two clips are the same clip. */
export const CLIP_SEED = 42;

/**
 * How long one lane may take. Generous on purpose: the first clip of the day
 * reads tens of gigabytes of weights off the disk before it renders anything,
 * and a run that gave up in the middle of that on camera would be worse than
 * a run that waited.
 */
export const CLIP_TIMEOUT_MS = 30 * 60_000;
/** Copying one mp4 back over the network. */
export const CLIP_FETCH_TIMEOUT_MS = 5 * 60_000;
/** Copying one starting picture out to a machine. A megabyte or two, not a model. */
export const CLIP_SEND_TIMEOUT_MS = 2 * 60_000;

export type ClipSizeKey = "small" | "big";

export interface ClipSize {
  key: ClipSizeKey;
  width: number;
  height: number;
  /** LTX compresses in eights, so a valid clip is 8k+1 frames. */
  frames: number;
}

/**
 * Two sizes, and both of them err small.
 *
 * The point of the default is that it finishes while the camera is still
 * rolling, not that it looks impressive. `big` is there for when the shot
 * wants something worth looking at and the wait is affordable.
 */
export const CLIP_SIZES: Record<ClipSizeKey, ClipSize> = {
  small: { key: "small", width: 512, height: 256, frames: 49 },
  big: { key: "big", width: 704, height: 480, frames: 97 },
};

/** How long the clip runs, in seconds, from its frame count. */
export function clipSeconds(size: ClipSize): number {
  return (size.frames - 1) / CLIP_FRAME_RATE;
}

// ------------------------------------------------------------- the first frame

/** The two kinds of picture the port will decode. */
export type ClipImageExt = "png" | "jpg";

/** A picture to start the clip from, already read off this Mac. */
export interface ClipStartImage {
  bytes: Uint8Array;
  ext: ClipImageExt;
}

/**
 * Which of the two kinds of picture a file is, by its name.
 *
 * Refused by name rather than sent anyway, because the port decodes PNG and
 * JPEG and nothing else: a TIFF handed over would cost the wait and then fail
 * on the machine, which on a filming day is the expensive way to find out.
 */
export function clipImageExt(path: string): ClipImageExt {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "png";
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  throw new ClipError(`I can only start a clip from a .png or a .jpg. "${path}" is neither.`);
}

/**
 * The picture, off this Mac, ready to be sent to every lane.
 *
 * Read once here rather than once per lane: the file is the same file for all
 * of them, and a read that fails should say so before any machine is asked to
 * do anything.
 */
export async function loadStartImage(path: string): Promise<ClipStartImage> {
  const ext = clipImageExt(path);
  const file = Bun.file(path);
  if (!(await file.exists())) throw new ClipError(`There is no picture at ${path}.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) throw new ClipError(`The picture at ${path} is empty.`);
  return { bytes, ext };
}

// ------------------------------------------------------------------ arguments

export interface ClipArgs {
  help: boolean;
  prompt: string;
  size: ClipSize;
  /** Lane labels the person named. Empty means every lane this tool can reach. */
  lanes: string[];
  seed: number;
  open: boolean;
  /** A picture on this Mac the clip starts from. Null for a clip from nothing. */
  image: string | null;
}

const VALUE_FLAGS = new Set(["--size", "--lane", "--seed", "--image"]);

function sizeFor(value: string): ClipSize {
  const normalised = value.toLowerCase().replace(/[^a-z]/g, "");
  if (normalised === "small") return CLIP_SIZES.small;
  if (normalised === "big") return CLIP_SIZES.big;
  throw new ClipError(`I do not know the size "${value}". It is either small or big.`);
}

export function parseClipArgs(argv: string[]): ClipArgs {
  const bare: string[] = [];
  const lanes: string[] = [];
  let size = CLIP_SIZES.small;
  let seed = CLIP_SEED;
  let open = true;
  let help = false;
  let image: string | null = null;

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
      if (value === undefined || value.startsWith("--")) throw new ClipError(`${arg} needs a value after it.`);
      i++;
      if (arg === "--size") size = sizeFor(value);
      else if (arg === "--lane") lanes.push(value);
      else if (arg === "--image") {
        // Checked here, where the person is still at the keyboard, rather than
        // on the machine twenty minutes later.
        clipImageExt(value);
        image = value;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) throw new ClipError(`--seed takes a whole number, not "${value}".`);
        seed = parsed;
      }
      continue;
    }

    if (arg.startsWith("-")) throw new ClipError(`I do not know the option ${arg}. Run bun run clip --help.`);
    bare.push(arg);
  }

  if (help) return { help: true, prompt: "", size, lanes, seed, open, image };

  if (bare.length === 0) {
    throw new ClipError(`Tell me what to film, in quotes: bun run clip "a paper plane over a city at night".`);
  }
  if (bare.length > 1) {
    throw new ClipError(
      `Put the whole prompt inside one pair of quotes. I was given ${bare.length} separate words or phrases: ` +
        bare.map((b) => `"${b}"`).join(", "),
    );
  }

  return { help: false, prompt: bare[0]!, size, lanes, seed, open, image };
}

// ------------------------------------------------------------------ lanes

export interface ClipLane {
  lane: BenchLane;
  target: SshTarget;
}

/**
 * Which machines film.
 *
 * Every lane the config gives a way in to, unless the person named some. A
 * name is matched as written or as its file-name form, so `--lane m5-ultra-256gb`
 * works as well as `--lane "M5 Ultra 256GB"`.
 */
export function clipLanes(config: BenchConfig, wanted: string[] = []): ClipLane[] {
  const managed = config.lanes.filter((lane): lane is BenchLane & { ssh: SshTarget } => lane.ssh !== undefined);
  if (managed.length === 0) {
    throw new ClipError("No lane in bench.config.json has an `ssh` block, so there is no machine to film on.");
  }

  if (wanted.length === 0) return managed.map((lane) => ({ lane, target: lane.ssh }));

  const chosen: ClipLane[] = [];
  for (const name of wanted) {
    const hit = managed.find((lane) => lane.label === name || laneSlug(lane.label) === laneSlug(name));
    if (!hit) {
      throw new ClipError(
        `There is no lane called "${name}". The ones in bench.config.json are: ${managed.map((l) => l.label).join(", ")}.`,
      );
    }
    if (!chosen.some((c) => c.lane.label === hit.label)) chosen.push({ lane: hit, target: hit.ssh });
  }
  return chosen;
}

// ------------------------------------------------------------------ paths

export const CLIP_RESULTS_ROOT = resolve(PROJECT_ROOT, "results/clip");

/** Where this run's clips land on this Mac. */
export function clipRunDir(stamp: string): string {
  return resolve(CLIP_RESULTS_ROOT, stamp);
}

/** One lane's clip on this Mac. */
export function localClipPath(stamp: string, laneLabel: string): string {
  return resolve(clipRunDir(stamp), `${laneSlug(laneLabel)}.mp4`);
}

/** Where the clip is written on the machine that makes it. */
export function remoteClipDir(stamp: string): string {
  return `~/bench-clips/${stamp}`;
}

/** The one file each machine is asked to write. */
export function remoteClipPath(stamp: string): string {
  return `${remoteClipDir(stamp)}/clip.mp4`;
}

/**
 * Where the starting picture is put on the machine that films from it.
 *
 * Beside the clip it becomes, in this run's folder, so the two are cleaned up
 * together and nothing from an earlier run is ever the frame a later one
 * starts on.
 */
export function remoteStartImagePath(stamp: string, ext: ClipImageExt): string {
  return `${remoteClipDir(stamp)}/start.${ext}`;
}

// ------------------------------------------------------------------ command

export interface ClipCommandOptions {
  prompt: string;
  seed: number;
  size: ClipSize;
  stamp: string;
  /**
   * The picture on THAT machine the clip starts from, or null for a clip from
   * nothing. The port calls this its legacy single-image form: the picture
   * becomes frame 0 at full strength, and the port itself resizes and centre
   * crops it to the clip's shape, so a square 1024 picture needs nothing done
   * to it here.
   */
  imagePath?: string | null;
}

/**
 * The port, run inside its own environment on that machine, for one clip.
 *
 * No warm-up and no step count: the audience is watching a cold machine make
 * one clip, and `--distilled` is the port's own fast path for these weights.
 *
 * Every path comes from the config or from this file's own constants and goes
 * through `remoteArg`, which refuses anything a shell could act on. The prompt
 * is the exception -- it is whatever the person typed, spaces and all -- so it
 * is single quoted with its own quotes escaped, exactly as the picture race
 * does it, and it can only ever be one argument.
 */
export function clipCommand(opts: ClipCommandOptions): string {
  const { prompt, seed, size, stamp } = opts;
  const checkout = remoteArg(LTX_CHECKOUT, "port checkout");
  const model = remoteArg(`${BENCH_MODELS_ROOT}/${CLIP_MODEL_DIR}`, "model directory");
  // The directory is checked like any other path; the "/clip.mp4" tail is our
  // own literal, so it is appended after the check rather than run through it.
  const outDir = remoteArg(remoteClipDir(stamp), "clip output directory");
  const output = `${outDir.replace(/'$/, "")}/clip.mp4'`;

  const parts = [
    `${CLIP_PATH_EXPORT};`,
    `mkdir -p ${outDir} &&`,
    `cd ${checkout} &&`,
    `${CLIP_RUNNER} generate`,
    "--model",
    model,
    "--prompt",
    `'${prompt.replace(/'/g, "'\\''")}'`,
    "--seed",
    `'${Math.trunc(seed)}'`,
    "--width",
    `'${Math.trunc(size.width)}'`,
    "--height",
    `'${Math.trunc(size.height)}'`,
    "--frames",
    `'${Math.trunc(size.frames)}'`,
    "--frame-rate",
    `'${CLIP_FRAME_RATE}'`,
    "--distilled",
    "--output",
    output,
  ];

  // Last, and only when there is one, so a clip from nothing is the same
  // command it has always been, character for character.
  if (opts.imagePath) parts.push("--image", remoteArg(opts.imagePath, "starting picture"));

  return parts.join(" ");
}

/** Opening the clips is macOS's `open`, as an argument array, never a shell string. */
export function openArgs(paths: string[]): string[] {
  return ["open", ...paths];
}

/**
 * Why a lane came back with nothing, in the machine's own words.
 *
 * The last dozen lines rather than the first, because the reason a run failed
 * is always at the end: a port that clones fine and dies three screens later
 * fills the top of the output with progress bars and detached-HEAD advice.
 * `lastOutput` puts the character cap on it.
 */
export function clipFailureDetail(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = lines.slice(-12).join("\n");
  return lastOutput(tail, 1200) || "it printed nothing at all";
}

// ------------------------------------------------------------------ results

export interface ClipLaneResult {
  label: string;
  ok: boolean;
  /**
   * Seconds for the whole invocation: reading the weights in AND making the
   * clip. The port prints one number for the lot and there is no way to split
   * them, so every label on this says so.
   */
  seconds: number | null;
  /** Where the clip ended up on this Mac. */
  localPath: string | null;
  /** Plain English, when something went wrong on this lane. */
  error: string | null;
}

/** What one lane's block says on screen. */
export function laneReport(result: ClipLaneResult): string[] {
  const lines = [`  ${result.label}`];
  if (result.seconds !== null) {
    lines.push(`    made the clip in ${result.seconds.toFixed(1)} s, load and generation together`);
  }
  if (result.localPath !== null) lines.push(`    clip: ${result.localPath}`);
  if (result.error !== null) lines.push(`    ${result.error}`);
  return lines;
}

/**
 * The one line that compares the machines.
 *
 * Fastest against slowest, from the only number the port gives -- which has
 * the weight load inside it, on both machines equally. Null when fewer than
 * two lanes came back with a clip: there is nothing to compare.
 */
export function verdictLine(results: ClipLaneResult[]): string | null {
  const made = results.filter((r) => r.ok && r.seconds !== null).sort((a, b) => a.seconds! - b.seconds!);
  if (made.length < 2) return null;

  const fastest = made[0]!;
  const slowest = made.at(-1)!;
  const times = `(${fastest.seconds!.toFixed(1)} s against ${slowest.seconds!.toFixed(1)} s)`;
  const ratio = slowest.seconds! / fastest.seconds!;

  if (ratio.toFixed(1) === "1.0") {
    return `${fastest.label} and ${slowest.label} made it in about the same time ${times}.`;
  }
  return `${fastest.label} made it ${ratio.toFixed(1)}x faster than ${slowest.label} ${times}.`;
}

/**
 * Non-zero when any lane failed, and when nothing ran at all.
 *
 * One machine falling over never stops the other -- the lanes run
 * independently and every one of them finishes -- but the command still says
 * it went wrong, so a script driving this is not told everything was fine.
 */
export function clipExitCode(results: ClipLaneResult[]): number {
  if (results.length === 0) return 1;
  return results.every((r) => r.ok) ? 0 : 1;
}

// ------------------------------------------------------------------ running

export interface ClipRunOptions {
  lanes: ClipLane[];
  prompt: string;
  seed: number;
  size: ClipSize;
  stamp: string;
  /**
   * The picture every lane starts its clip from, already read off this Mac.
   * Null, or left out, for a clip from nothing.
   */
  startImage?: ClipStartImage | null;
  /** One plain line at a time, as each machine gets on with it. */
  log?: (laneLabel: string, message: string) => void;
  /** Test seams. Everything that touches a machine or the disk goes through one. */
  run?: RemoteRunner;
  sendFile?: typeof sendRemoteFile;
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
 * Every lane films at once.
 *
 * That is the whole point of this command and one of the two reasons its
 * seconds are not a measurement. Each lane is walked end to end on its own and
 * catches its own failures, so one Mac being asleep, missing the weights, or
 * falling over mid-render costs that lane its clip and nothing else.
 */
export async function runClip(opts: ClipRunOptions): Promise<ClipLaneResult[]> {
  const run = opts.run ?? runRemote;
  const sendFile = opts.sendFile ?? sendRemoteFile;
  const fetchFile = opts.fetchFile ?? fetchRemoteFile;
  const write = opts.write ?? writeLocalFile;
  const timeoutMs = opts.timeoutMs ?? CLIP_TIMEOUT_MS;
  const say = (label: string, message: string) => opts.log?.(label, message);

  const startImage = opts.startImage ?? null;
  const imagePath = startImage === null ? null : remoteStartImagePath(opts.stamp, startImage.ext);
  const command = clipCommand({
    prompt: opts.prompt,
    seed: opts.seed,
    size: opts.size,
    stamp: opts.stamp,
    imagePath,
  });

  const clipOne = async (lane: ClipLane): Promise<ClipLaneResult> => {
    const label = lane.lane.label;
    const blank: ClipLaneResult = { label, ok: false, seconds: null, localPath: null, error: null };

    try {
      const reachable = await reachLane(lane.target, {
        run,
        ping: opts.ping,
        sleep: opts.sleepFor,
        log: (message) => say(label, message),
      });
      if (!reachable.ok) return { ...blank, error: reachable.detail };

      // The picture goes over before the port is asked for anything, because
      // the command it is about to be sent names that file.
      if (startImage !== null && imagePath !== null) {
        say(label, "copying the picture over");
        const sent = await sendFile(lane.target, imagePath, startImage.bytes, { timeoutMs: CLIP_SEND_TIMEOUT_MS });
        if (!sent.stdout.includes(FILE_WRITTEN)) {
          return {
            ...blank,
            error: `the picture would not copy onto this machine: ${(sent.stderr || "").trim().slice(0, 200) || "it said nothing at all"}`,
          };
        }
      }

      say(label, startImage === null ? "making the clip" : "animating the picture");
      const result = await run(lane.target, command, { timeoutMs });
      const output = `${result.stdout}\n${result.stderr}`;
      const seconds = parseClipSeconds(output);

      if (seconds === null) {
        return {
          ...blank,
          error: `no clip came back. This machine said:\n${clipFailureDetail(output)}`,
        };
      }

      const made: ClipLaneResult = { ...blank, seconds };
      const bytes = await fetchFile(lane.target, remoteClipPath(opts.stamp), { timeoutMs: CLIP_FETCH_TIMEOUT_MS });
      if (!bytes) {
        return { ...made, error: `it made the clip in ${seconds.toFixed(1)} s, but the file would not copy back.` };
      }

      const localPath = localClipPath(opts.stamp, label);
      await write(localPath, bytes);
      say(label, `done in ${seconds.toFixed(1)} s`);
      return { ...made, ok: true, localPath };
    } catch (err) {
      return { ...blank, error: `something went wrong talking to this machine: ${String(err)}` };
    }
  };

  return await Promise.all(opts.lanes.map(clipOne));
}

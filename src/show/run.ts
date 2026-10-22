/**
 * `bun run show` -- everything behind the on-camera test page that can be
 * proven without a Mac in the room.
 *
 * The page is one screen for every test this repo can run: the picture race,
 * the video race, and each of the everyday jobs. None of those jobs is
 * re-implemented here. The command each machine is sent is the exact string
 * `drawCommand`, `clipCommand` and the `DAILY_TESTS` table already build, the
 * work is still walked by `runDraw`, `runClip` and `runDaily`, and the sentence
 * under the lanes is still written by their own `verdictLine` functions. What
 * this file adds is the run's shape: who starts when, what the page is told
 * while it waits, and what is safe to hand back over HTTP.
 *
 * Everything in here is a function of its input or takes a seam for the parts
 * that are not, so the whole run -- both lanes finishing, one lane falling
 * over, a second START arriving mid-run, a media path that points somewhere it
 * should not -- is tested against a fake machine rather than against the two
 * Macs, which are needed for filming.
 *
 * One rule this file exists to keep: every second the page shows was measured
 * on this side of the wire. The live clock is a monotonic reading taken here
 * and sent down; the final number is the one the machine measured for itself
 * and reported. The browser does no timing at all.
 */

import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import {
  CLIP_SEED,
  CLIP_SIZES,
  clipSeconds,
  runClip,
  verdictLine as clipVerdictLine,
} from "../bench/clip.ts";
import type { ClipLaneResult, ClipSize, ClipSizeKey, ClipStartImage } from "../bench/clip.ts";
import * as daily from "../bench/daily.ts";
import type { DailyLaneResult, DailyTest } from "../bench/daily.ts";
import {
  DRAW_MODELS,
  DRAW_SEED,
  laneSlug,
  runDraw,
  verdictLine as drawVerdictLine,
} from "../bench/draw.ts";
import type { DrawLaneResult } from "../bench/draw.ts";
import type { Pinger } from "../bench/reach.ts";
import type { fetchRemoteFile, RemoteRunner, runRemoteWithInput, sendRemoteFile } from "../bench/ssh.ts";
import type { BenchLane, SshTarget } from "../bench/types.ts";
import { VIDEO_DISCLOSURE } from "../bench/video.ts";
import { elapsedSeconds, monotonicNow } from "../timing.ts";

// ------------------------------------------------------------------ the port

/** The port the page is served on when the config does not name one. */
export const DEFAULT_SHOW_PORT = 9800;

/**
 * The page's port, out of the raw config file.
 *
 * Read from the raw JSON rather than the validated config because
 * `validateBenchConfig` only carries the keys the benchmark itself uses, and a
 * key it drops would be a port silently ignored -- the run would come up on
 * 9800 while the person watched 9900 and saw nothing.
 */
export function showPortFrom(raw: unknown): number {
  if (typeof raw === "object" && raw !== null) {
    const value = (raw as Record<string, unknown>).showPort;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  }
  return DEFAULT_SHOW_PORT;
}

// ------------------------------------------------------------------ the tests

export type ShowTestKind = "draw" | "clip" | "daily";

/** One choice inside a toggle: the clip's size, the footage job's model. */
export interface ShowChoice {
  id: string;
  /** What the toggle says. */
  label: string;
  /** The detail under it, for somebody who wants to know what they picked. */
  note: string | null;
}

export interface ShowTest {
  id: string;
  /** What the button says. */
  label: string;
  kind: ShowTestKind;
  /** One plain line about what the machines are about to do. */
  about: string;
  /** The two tests that need words typed in. Null for the rest. */
  prompt: { placeholder: string; ask: string } | null;
  /**
   * The second row of toggles: the clip's small and big, the transcription's
   * two recordings. Null where there is nothing of that kind to choose.
   */
  sizes: ShowChoice[] | null;
  /**
   * The first row: the footage job's two model sizes, the transcription's six
   * Whisper models, the clip's two starting points. Null where there is
   * nothing of that kind to choose.
   */
  models: ShowChoice[] | null;
  /**
   * The same line, one per combination of toggles, for the tests whose job
   * changes with them. Null for every test where nothing changes.
   *
   * The footage job describes itself by the model it runs, so leaving `about`
   * to stand for both sizes puts a sentence naming the 32B model under a run
   * of the 8B one. The transcription does the same with its model and its
   * recording, which is why the key is both. Each line here is that job's own
   * description, built from the table, so the page and the machine never
   * disagree about what was run.
   */
  aboutByModel: Record<string, string> | null;
}

/**
 * The key one combination of toggles is described under.
 *
 * A job with one row of choices is keyed by that choice alone, which is what
 * the footage job has always been. A job with two rows needs both, because its
 * sentence names both: the transcription at turbo over the take and at turbo
 * over the whole day are different jobs with different labels.
 */
export function aboutKey(modelId: string | null, sizeId: string | null): string {
  return sizeId === null ? String(modelId) : `${modelId}/${sizeId}`;
}

/**
 * The names the vision job needs, looked up on the module rather than
 * imported.
 *
 * The everyday-jobs table grows on its own schedule, and this page is merged
 * on top of whichever version of it is there. A named import of a job that has
 * not landed yet would stop the whole page from starting; a lookup that comes
 * back undefined just leaves that one button, and its 32B/8B toggle, off the
 * screen until the job exists.
 */
interface FootageModelLike {
  key: string;
  name: string;
  dir: string;
}

const dailyExtras = daily as unknown as Partial<{
  footageTest: (model: FootageModelLike) => DailyTest;
  FOOTAGE_MODELS: Record<string, FootageModelLike>;
  FOOTAGE_MODEL_ORDER: string[];
}>;

/** The 32B/8B toggle, when the vision job is in this build of the table. */
function footageChoices(): ShowChoice[] | null {
  const models = dailyExtras.FOOTAGE_MODELS;
  const order = dailyExtras.FOOTAGE_MODEL_ORDER;
  if (!models || !order) return null;
  const choices = order
    .map((key) => models[key])
    .filter((model): model is FootageModelLike => model !== undefined)
    .map((model) => ({ id: model.key, label: model.key.toUpperCase(), note: model.name }));
  return choices.length === 0 ? null : choices;
}

/**
 * One description per model for the vision job, built by asking the table for
 * that job at that size. Null when this build of the table has no such job.
 */
function footageAbouts(): Record<string, string> | null {
  const models = dailyExtras.FOOTAGE_MODELS;
  const order = dailyExtras.FOOTAGE_MODEL_ORDER;
  const make = dailyExtras.footageTest;
  if (!models || !order || !make) return null;

  const abouts: Record<string, string> = {};
  for (const key of order) {
    const model = models[key];
    if (model !== undefined) abouts[key] = make(model).description;
  }
  return Object.keys(abouts).length === 0 ? null : abouts;
}

/** The six Whisper models, in the order the table lists them. */
function whisperChoices(): ShowChoice[] {
  return daily.WHISPER_MODEL_ORDER.map((key) => {
    const model = daily.WHISPER_MODELS[key];
    return { id: model.key, label: model.key.toUpperCase(), note: model.name };
  });
}

/** The two recordings the transcription can be pointed at. */
function audioChoices(): ShowChoice[] {
  return daily.AUDIO_FILE_ORDER.map((key) => {
    const file = daily.AUDIO_FILES[key];
    return { id: file.key, label: file.toggle, note: file.description };
  });
}

/**
 * One line per model-and-recording, built by asking the table for that job.
 *
 * Twelve of them, because the page has to caption a run before it is told what
 * the machines measured, and every one of the twelve is a different sentence.
 */
function transcribeAbouts(): Record<string, string> {
  const abouts: Record<string, string> = {};
  for (const modelKey of daily.WHISPER_MODEL_ORDER) {
    for (const fileKey of daily.AUDIO_FILE_ORDER) {
      const test = daily.transcribeTest(daily.WHISPER_MODELS[modelKey], daily.AUDIO_FILES[fileKey]);
      abouts[aboutKey(modelKey, fileKey)] = test.description;
    }
  }
  return abouts;
}

/** The toggle rows one everyday job carries, and the line each combination gets. */
function dailyChoicesFor(name: string): Pick<ShowTest, "sizes" | "models" | "aboutByModel"> {
  if (name === "footage") return { sizes: null, models: footageChoices(), aboutByModel: footageAbouts() };
  if (name === "transcribe") {
    return { sizes: audioChoices(), models: whisperChoices(), aboutByModel: transcribeAbouts() };
  }
  return { sizes: null, models: null, aboutByModel: null };
}

/** The clip's sizes, read off the table that decides what they mean. */
function clipChoices(): ShowChoice[] {
  return Object.values(CLIP_SIZES).map((size: ClipSize) => ({
    id: size.key,
    label: size.key.toUpperCase(),
    note: `${size.width}x${size.height}, ${clipSeconds(size).toFixed(1)} seconds long`,
  }));
}

/**
 * What the clip starts from: nothing, or the last picture that lane drew.
 *
 * The second one is the pair of tests told as one story on camera -- draw a
 * picture on both Macs, then watch both Macs animate the picture they drew --
 * so it is a toggle on the clip rather than a test of its own.
 */
export const CLIP_FROM_SCRATCH = "scratch";
export const CLIP_FROM_PICTURE = "last";

export const CLIP_ABOUT_SCRATCH =
  "One prompt, one short video on every Mac at once. The seconds hold the model load as well as the generation.";

export const CLIP_ABOUT_PICTURE =
  "The last picture each Mac drew becomes the first frame of a short video on that same Mac, from one prompt. " +
  "The seconds hold the model load as well as the generation.";

function clipSourceChoices(): ShowChoice[] {
  return [
    { id: CLIP_FROM_SCRATCH, label: "FROM SCRATCH", note: "the clip starts from nothing but the words" },
    { id: CLIP_FROM_PICTURE, label: "FROM LAST PICTURE", note: "the clip starts on the picture this Mac last drew" },
  ];
}

/** One line per starting point and size, because the page captions a run before it starts. */
function clipAbouts(): Record<string, string> {
  const abouts: Record<string, string> = {};
  for (const source of [CLIP_FROM_SCRATCH, CLIP_FROM_PICTURE]) {
    for (const size of Object.values(CLIP_SIZES)) {
      abouts[aboutKey(source, size.key)] = source === CLIP_FROM_PICTURE ? CLIP_ABOUT_PICTURE : CLIP_ABOUT_SCRATCH;
    }
  }
  return abouts;
}

/** True when this request asked for the clip to start on the lane's last picture. */
export function clipFromPicture(request: ShowRunRequest): boolean {
  return request.test.kind === "clip" && request.modelId === CLIP_FROM_PICTURE;
}

/** Shorthand a button can hold, for the jobs whose names are already short. */
const DAILY_BUTTON_LABELS: Record<string, string> = {
  hevc: "HEVC",
  prores: "PRORES",
  transcribe: "TRANSCRIBE",
  footage: "FOOTAGE",
  laya: "LAYA",
};

/**
 * Every test the page can run, in the order the buttons appear.
 *
 * The two that make something to look at first, then the everyday jobs in the
 * order the table lists them -- which is the order `bun run daily` prints, so
 * the page and the terminal never disagree about what comes first.
 */
export function showTests(): ShowTest[] {
  const tests: ShowTest[] = [
    {
      id: "draw",
      label: "DRAW",
      kind: "draw",
      about: `One prompt, one 1024x1024 picture on every Mac at once, drawn with ${DRAW_MODELS.flux.name}.`,
      prompt: {
        placeholder: "a fox reading in a library",
        ask: "Type what you want drawn, then press START.",
      },
      sizes: null,
      models: null,
      aboutByModel: null,
    },
    {
      id: "clip",
      label: "CLIP",
      kind: "clip",
      about: CLIP_ABOUT_SCRATCH,
      prompt: {
        placeholder: "a paper plane over a city at night",
        ask: "Type what you want filmed, then press START.",
      },
      sizes: clipChoices(),
      models: clipSourceChoices(),
      aboutByModel: clipAbouts(),
    },
  ];

  for (const name of daily.DAILY_TEST_ORDER) {
    const test = (daily.DAILY_TESTS as Record<string, DailyTest>)[name]!;
    tests.push({
      id: name,
      label: DAILY_BUTTON_LABELS[name] ?? name.toUpperCase(),
      kind: "daily",
      about: test.description,
      prompt: null,
      ...dailyChoicesFor(name),
    });
  }

  return tests;
}

/**
 * The everyday job behind one button, at whatever the toggles were left on.
 *
 * The command inside it is the table's own, never rebuilt here. A name this
 * build of the table does not have comes back null, and the request that named
 * it is refused rather than run against something else. A toggle value the
 * table does not know falls back to the job as it stands rather than throwing,
 * because `parseRunRequest` has already refused anything that is not one of
 * the choices this page offered.
 */
export function dailyTestFor(id: string, modelId: string | null, sizeId: string | null = null): DailyTest | null {
  const order = daily.DAILY_TEST_ORDER as string[];
  if (!order.includes(id)) return null;

  const base = (daily.DAILY_TESTS as Record<string, DailyTest>)[id]!;

  if (id === "transcribe") {
    if (modelId === null && sizeId === null) return base;
    const model = daily.WHISPER_MODELS[(modelId ?? "large-v3") as daily.WhisperModelKey];
    const file = daily.AUDIO_FILES[(sizeId ?? "take") as daily.AudioFileKey];
    return model && file ? daily.transcribeTest(model, file) : base;
  }

  if (id !== "footage" || modelId === null) return base;

  const make = dailyExtras.footageTest;
  const model = dailyExtras.FOOTAGE_MODELS?.[modelId];
  return make && model ? make(model) : base;
}

// ------------------------------------------------------------------ requests

export interface ShowRunRequest {
  test: ShowTest;
  /** Empty for every test that does not take one. */
  prompt: string;
  /** The choice that was made, or the first one when nothing was named. */
  sizeId: string | null;
  modelId: string | null;
}

function choose(
  choices: ShowChoice[] | null,
  wanted: unknown,
  what: string,
): { ok: true; id: string | null } | { ok: false; message: string } {
  if (choices === null || choices.length === 0) return { ok: true, id: null };
  if (wanted === undefined || wanted === null) return { ok: true, id: choices[0]!.id };
  if (typeof wanted !== "string" || !choices.some((c) => c.id === wanted)) {
    return {
      ok: false,
      message: `I do not know the ${what} "${String(wanted)}". It is one of: ${choices.map((c) => c.id).join(", ")}.`,
    };
  }
  return { ok: true, id: wanted };
}

/**
 * What the page asked for, or the plain sentence saying why it cannot happen.
 *
 * Refused rather than guessed at, in every case: a test nobody has, a prompt
 * nobody typed, a size that is not one of the sizes. The alternative is a
 * machine spending twenty minutes on something other than what was pressed,
 * which on a filming day costs the take.
 */
export function parseRunRequest(
  body: unknown,
  tests: ShowTest[],
): { ok: true; request: ShowRunRequest } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "I could not read that request." };
  }
  const obj = body as Record<string, unknown>;

  const wanted = obj.test;
  const test = typeof wanted === "string" ? tests.find((t) => t.id === wanted) : undefined;
  if (!test) {
    return {
      ok: false,
      message:
        `I do not know the test "${String(wanted ?? "")}". ` +
        `The ones on this page are: ${tests.map((t) => t.id).join(", ")}.`,
    };
  }

  let prompt = "";
  if (test.prompt !== null) {
    const typed = typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    if (typed === "") return { ok: false, message: test.prompt.ask };
    prompt = typed;
  }

  const size = choose(test.sizes, obj.size, "size");
  if (!size.ok) return { ok: false, message: size.message };

  // Named for what the row actually is on that test, so a refusal reads like
  // the button it came from rather than like a model nobody offered.
  const model = choose(test.models, obj.model, test.kind === "clip" ? "starting point" : "model");
  if (!model.ok) return { ok: false, message: model.message };

  return { ok: true, request: { test, prompt, sizeId: size.id, modelId: model.id } };
}

/**
 * The line that belongs to the run that was actually asked for.
 *
 * `test.about` is what the page shows before anything has been toggled. Once a
 * model, or a model and a recording, have been chosen the job is a different
 * job with a different description, and this is the one both the line under
 * the buttons and the run-start event use, so neither can caption an 8B run
 * with 32B's sentence or a whole shoot day with the take's.
 */
export function aboutFor(request: ShowRunRequest): string {
  const byModel = request.test.aboutByModel;
  if (byModel === null || request.modelId === null) return request.test.about;
  return byModel[aboutKey(request.modelId, request.sizeId)] ?? request.test.about;
}

// ------------------------------------------------------------------ one run

/** One run at a time, because the machines are the machines. */
export const BUSY_MESSAGE =
  "A test is already running on the Macs. Wait for it to finish, then press START again.";

export class RunLock {
  #busy = false;

  get busy(): boolean {
    return this.#busy;
  }

  /** True when this caller now holds the run. False when somebody else does. */
  take(): boolean {
    if (this.#busy) return false;
    this.#busy = true;
    return true;
  }

  release(): void {
    this.#busy = false;
  }
}

// ------------------------------------------------------------------ media

export const SHOW_RESULTS_ROOT = resolve(PROJECT_ROOT, "results/show");

/** The two kinds of file a test can hand back, and nothing else. */
export const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  mp4: "video/mp4",
};

export type MediaExt = "png" | "mp4";

/** Where this run's pictures and clips land on this Mac. */
export function showRunDir(stamp: string): string {
  return resolve(SHOW_RESULTS_ROOT, stamp);
}

/** One lane's file on this Mac. */
export function showMediaPath(stamp: string, laneLabel: string, ext: MediaExt): string {
  return resolve(showRunDir(stamp), `${laneSlug(laneLabel)}.${ext}`);
}

/** The same file, as the page asks for it. */
export function showMediaUrl(stamp: string, laneLabel: string, ext: MediaExt): string {
  return `/media/${encodeURIComponent(stamp)}/${laneSlug(laneLabel)}.${ext}`;
}

/**
 * The file a /media request names, or null.
 *
 * Null for anything that is not a picture or a clip inside this run folder --
 * including a path that climbs out of it with `..`, one that is written to
 * climb out once it is decoded, and one that names some other kind of file
 * entirely. The page is served off a laptop on a shoot, so the only files it
 * hands out are the ones a test just made.
 */
export function resolveShowMedia(relativePath: string): { path: string; contentType: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }
  if (decoded === "" || decoded.includes("\0")) return null;

  const wanted = resolve(SHOW_RESULTS_ROOT, decoded);
  if (!wanted.startsWith(`${SHOW_RESULTS_ROOT}/`)) return null;

  const ext = wanted.slice(wanted.lastIndexOf(".") + 1).toLowerCase();
  const contentType = MEDIA_TYPES[ext];
  return contentType === undefined ? null : { path: wanted, contentType };
}

// ------------------------------------------------------------------ outcomes

export interface ShowLaneRef {
  laneId: string;
  label: string;
}

/** A lane as this page runs it: the config's lane, and the way in to it. */
export interface ShowMachine extends ShowLaneRef {
  lane: BenchLane;
  target: SshTarget;
}

export interface ShowMedia {
  url: string;
  kind: "image" | "video";
  /**
   * The sentence that has to sit under this file wherever it is shown, or null
   * where nothing is owed.
   *
   * It travels with the clip rather than being printed once at the top of the
   * page because the camera frames one lane at a time: a licence line that is
   * only in the header is a line that is not in the shot. Pictures carry
   * nothing -- this is the LTX-2 Community License's obligation, and it is
   * about the clips.
   */
  disclosure: string | null;
}

/**
 * What one lane came back with.
 *
 * The CLI's own result type, untouched, plus the two things the page needs
 * that the CLI has no use for: which lane it was, and where the file it made
 * can be fetched from. Keeping the original result rather than flattening it
 * is what lets the verdict below be the CLIs' sentence rather than a second
 * copy of it.
 */
export type ShowOutcome =
  | { kind: "draw"; laneId: string; result: DrawLaneResult; mediaUrl: string | null }
  | {
      kind: "clip";
      laneId: string;
      result: ClipLaneResult;
      mediaUrl: string | null;
      /** True when this clip started on the picture the lane drew. */
      fromPicture?: boolean;
    }
  | { kind: "daily"; laneId: string; result: DailyLaneResult; numberLabel: string };

/** A lane that never got as far as running, said in the shape of a result. */
export function blankOutcome(kind: ShowTestKind, lane: ShowLaneRef, message: string): ShowOutcome {
  if (kind === "draw") {
    return {
      kind,
      laneId: lane.laneId,
      mediaUrl: null,
      result: { label: lane.label, ok: false, loadSeconds: null, drawSeconds: null, localPath: null, error: message },
    };
  }
  if (kind === "clip") {
    return {
      kind,
      laneId: lane.laneId,
      mediaUrl: null,
      result: { label: lane.label, ok: false, seconds: null, localPath: null, error: message },
    };
  }
  return {
    kind,
    laneId: lane.laneId,
    numberLabel: "",
    result: { label: lane.label, ok: false, seconds: null, words: null, answer: null, error: message },
  };
}

/**
 * Why a lane came back with nothing: the sentence first, the machine's own
 * words after it.
 *
 * The CLIs put both in one string because a terminal reads top to bottom. The
 * page has two places to put them -- a line in the lane and a block under it --
 * so they are split on the first line break.
 */
export function splitFailure(error: string | null): { reason: string; lines: string[] } {
  const all = (error ?? "").split("\n").map((line) => line.trimEnd());
  while (all.length > 0 && all[0]!.trim() === "") all.shift();
  while (all.length > 0 && all.at(-1)!.trim() === "") all.pop();
  if (all.length === 0) return { reason: "it did not say why.", lines: [] };
  return { reason: all[0]!.trim(), lines: all.slice(1) };
}

// ------------------------------------------------------------ last pictures

/**
 * The picture each lane came away from this run with, by lane.
 *
 * Only a finished picture run leaves any, which is what the clip's FROM LAST
 * PICTURE toggle animates. The path is worked out the same way the run wrote
 * it -- this run's folder, the lane's own name -- rather than read off the
 * result, whose `localPath` is where the picture race would have put it.
 */
export function picturesFrom(outcomes: ShowOutcome[], stamp: string): Map<string, string> {
  const pictures = new Map<string, string>();
  for (const outcome of outcomes) {
    if (outcome.kind !== "draw" || !outcome.result.ok || outcome.mediaUrl === null) continue;
    pictures.set(outcome.laneId, showMediaPath(stamp, outcome.result.label, "png"));
  }
  return pictures;
}

/**
 * Why a clip cannot start from a picture yet, or null when every lane has one.
 *
 * Said before anything is sent to a machine: a run that started on one lane
 * and refused on the other would leave the two lanes showing different tests,
 * which is the one thing this page must never do on camera.
 */
export function missingPictureMessage(lanes: ShowLaneRef[], pictures: Map<string, string>): string | null {
  const without = lanes.filter((lane) => !pictures.has(lane.laneId)).map((lane) => lane.label);
  if (without.length === 0) return null;
  const named = without.length === 1 ? without[0]! : `${without.slice(0, -1).join(", ")} and ${without.at(-1)!}`;
  const lane = without.length === 1 ? "lane has" : "lanes have";
  return `Draw a picture first; the ${named} ${lane} none yet.`;
}

// ------------------------------------------------------------------ events

export type ShowEvent =
  | { type: "run-start"; runId: string; testId: string; testLabel: string; about: string; lanes: ShowLaneRef[] }
  | { type: "lane-start"; laneId: string }
  | { type: "tick"; lanes: { laneId: string; elapsedSec: number }[] }
  | {
      type: "lane-done";
      laneId: string;
      seconds: number | null;
      label: string;
      extras: string[];
      answer: string[] | null;
      media: ShowMedia | null;
    }
  | { type: "lane-failed"; laneId: string; reason: string; lines: string[] }
  | { type: "verdict"; line: string | null }
  | { type: "run-done"; runId: string };

/** The one event a finished lane produces: what it did, or why it did not. */
export function laneEvent(outcome: ShowOutcome): ShowEvent {
  if (!outcome.result.ok) {
    const { reason, lines } = splitFailure(outcome.result.error);
    return { type: "lane-failed", laneId: outcome.laneId, reason, lines };
  }

  if (outcome.kind === "draw") {
    const extras =
      outcome.result.loadSeconds === null
        ? []
        : [`loaded the model in ${outcome.result.loadSeconds.toFixed(1)} s`];
    return {
      type: "lane-done",
      laneId: outcome.laneId,
      seconds: outcome.result.drawSeconds,
      label: "seconds to draw it",
      extras,
      answer: null,
      media: outcome.mediaUrl === null ? null : { url: outcome.mediaUrl, kind: "image", disclosure: null },
    };
  }

  if (outcome.kind === "clip") {
    return {
      type: "lane-done",
      laneId: outcome.laneId,
      seconds: outcome.result.seconds,
      // The label under the number says where the clip started, because the
      // two runs look identical on screen and take very different times.
      label: outcome.fromPicture
        ? "seconds, load and generation together, from the last picture"
        : "seconds, load and generation together",
      extras: [],
      answer: null,
      media:
        outcome.mediaUrl === null
          ? null
          : { url: outcome.mediaUrl, kind: "video", disclosure: VIDEO_DISCLOSURE },
    };
  }

  const extras =
    outcome.result.words === null ? [] : [`${outcome.result.words.toLocaleString("en-US")} words transcribed`];
  return {
    type: "lane-done",
    laneId: outcome.laneId,
    seconds: outcome.result.seconds,
    label: outcome.numberLabel,
    extras,
    answer: outcome.result.answer,
    media: null,
  };
}

/**
 * The line under both lanes.
 *
 * Every word of it comes from the CLI that owns that test -- `draw.ts` says
 * "drew it", `clip.ts` says "made it", `daily.ts` says "did it", and each of
 * them decides on its own what counts as the same time. A run is one test, so
 * the whole set of outcomes is one kind and one of the three writes the line.
 */
export function verdictFor(outcomes: ShowOutcome[]): string | null {
  const first = outcomes[0];
  if (first === undefined) return null;

  if (first.kind === "draw") {
    return drawVerdictLine(
      outcomes.filter((o): o is Extract<ShowOutcome, { kind: "draw" }> => o.kind === "draw").map((o) => o.result),
    );
  }
  if (first.kind === "clip") {
    return clipVerdictLine(
      outcomes.filter((o): o is Extract<ShowOutcome, { kind: "clip" }> => o.kind === "clip").map((o) => o.result),
    );
  }
  return daily.verdictLine(
    outcomes.filter((o): o is Extract<ShowOutcome, { kind: "daily" }> => o.kind === "daily").map((o) => o.result),
  );
}

// ------------------------------------------------------------------ the run

/** How often the page is told what the clocks say. */
export const SHOW_TICK_MS = 100;

/** Starts a repeating job and hands back the way to stop it. A seam, for tests. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export interface RunShowOptions {
  runId: string;
  test: ShowTest;
  /**
   * The line the page is told this run is, when the toggle changed it.
   * Defaults to the test's own, which is right for every test with no toggle.
   */
  about?: string;
  lanes: ShowLaneRef[];
  /** One lane, end to end. The only thing here that touches a machine. */
  runLane: (lane: ShowLaneRef) => Promise<ShowOutcome>;
  emit: (event: ShowEvent) => void;
  /** Monotonic milliseconds. Never Date.now(), which can jump. */
  now?: () => number;
  tickMs?: number;
  schedule?: Schedule;
}

/**
 * One run, from START to the verdict.
 *
 * Every lane starts at the same moment and is walked on its own, exactly as
 * the CLIs do it, so one Mac being asleep or falling over costs that lane its
 * number and nothing else. While a lane is still working the page is sent its
 * elapsed seconds ten times a second; once it finishes, its own measured
 * number replaces the clock and it stops being ticked.
 */
export async function runShow(opts: RunShowOptions): Promise<ShowOutcome[]> {
  const now = opts.now ?? monotonicNow;
  const tickMs = opts.tickMs ?? SHOW_TICK_MS;
  const schedule = opts.schedule ?? defaultSchedule;

  opts.emit({
    type: "run-start",
    runId: opts.runId,
    testId: opts.test.id,
    testLabel: opts.test.label,
    about: opts.about ?? opts.test.about,
    lanes: opts.lanes.map((l) => ({ laneId: l.laneId, label: l.label })),
  });

  const startedAt = new Map<string, number>();
  const running = new Set<string>();

  const tick = () => {
    const lanes = opts.lanes
      .filter((lane) => running.has(lane.laneId))
      .map((lane) => ({
        laneId: lane.laneId,
        elapsedSec: elapsedSeconds(startedAt.get(lane.laneId) ?? now(), now()),
      }));
    if (lanes.length > 0) opts.emit({ type: "tick", lanes });
  };

  const stopTicking = schedule(tick, tickMs);

  const outcomes = await Promise.all(
    opts.lanes.map(async (lane) => {
      startedAt.set(lane.laneId, now());
      running.add(lane.laneId);
      opts.emit({ type: "lane-start", laneId: lane.laneId });

      let outcome: ShowOutcome;
      try {
        outcome = await opts.runLane(lane);
      } catch (err) {
        // A runner that throws is this tool being wrong, not the machine. It
        // still reads as one lane failing rather than taking the run down.
        outcome = blankOutcome(opts.test.kind, lane, `something went wrong on this side: ${String(err)}`);
      }
      running.delete(lane.laneId);
      opts.emit(laneEvent(outcome));
      return outcome;
    }),
  );

  stopTicking();
  opts.emit({ type: "verdict", line: verdictFor(outcomes) });
  opts.emit({ type: "run-done", runId: opts.runId });
  return outcomes;
}

// ------------------------------------------------------------------ the lanes

export interface LaneRunnerDeps {
  /** The timing shim's source, for the picture test. Sent down the same ssh. */
  shimSource: string;
  /** Where a picture or a clip is put once it has been copied back. */
  writeMedia: (path: string, bytes: Uint8Array) => Promise<void>;
  /**
   * The most recent picture each lane drew, by lane, for a clip that starts
   * from one. Empty, or left out, when nothing has been drawn yet.
   */
  pictures?: Map<string, string>;
  /** Test seams. Everything that touches a machine goes through one. */
  run?: RemoteRunner;
  sendShim?: typeof runRemoteWithInput;
  sendFile?: typeof sendRemoteFile;
  fetchFile?: typeof fetchRemoteFile;
  /** Reads a picture back off this Mac, to send it to the machine that drew it. */
  readMedia?: (path: string) => Promise<Uint8Array>;
  ping?: Pinger;
  sleepFor?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/** The default read: the file this Mac wrote when the picture came back. */
async function readLocalMedia(path: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

/**
 * How one lane does one test.
 *
 * Every branch hands the whole job to the command the CLI already owns --
 * `runDraw`, `runClip`, `runDaily` -- with a single lane in it. That is what
 * keeps the page honest: there is no second copy of the ssh dance, no second
 * copy of the remote command, and a fix made for the terminal is a fix the
 * camera gets too.
 *
 * The one thing that is different is where the file lands. The CLIs keep their
 * pictures in results/draw and their clips in results/clip; this page keeps
 * everything one run made in results/show/<stamp> so a single route can serve
 * it, so the write seam is pointed there.
 */
export function laneRunnerFor(
  request: ShowRunRequest,
  stamp: string,
  machines: Map<string, ShowMachine>,
  deps: LaneRunnerDeps,
): (lane: ShowLaneRef) => Promise<ShowOutcome> {
  return async (lane: ShowLaneRef): Promise<ShowOutcome> => {
    const machine = machines.get(lane.laneId);
    if (machine === undefined) {
      return blankOutcome(request.test.kind, lane, "this lane is not in bench.config.json any more.");
    }
    const only = [{ lane: machine.lane, target: machine.target }];

    if (request.test.kind === "draw") {
      const path = showMediaPath(stamp, lane.label, "png");
      const [result] = await runDraw({
        lanes: only,
        model: DRAW_MODELS.flux,
        prompt: request.prompt,
        seed: DRAW_SEED,
        stamp,
        shimSource: deps.shimSource,
        run: deps.run,
        sendShim: deps.sendShim,
        fetchFile: deps.fetchFile,
        write: async (_where, bytes) => deps.writeMedia(path, bytes),
        ping: deps.ping,
        sleepFor: deps.sleepFor,
        timeoutMs: deps.timeoutMs,
      });
      const drawn = result ?? blankResultDraw(lane.label);
      return {
        kind: "draw",
        laneId: lane.laneId,
        result: drawn,
        mediaUrl: drawn.ok ? showMediaUrl(stamp, lane.label, "png") : null,
      };
    }

    if (request.test.kind === "clip") {
      const path = showMediaPath(stamp, lane.label, "mp4");
      const size = CLIP_SIZES[(request.sizeId ?? "small") as ClipSizeKey] ?? CLIP_SIZES.small;

      // Every lane animates the picture IT drew, so the picture is looked up
      // per lane and read here rather than once for the run.
      const fromPicture = clipFromPicture(request);
      let startImage: ClipStartImage | null = null;
      if (fromPicture) {
        const picture = deps.pictures?.get(lane.laneId);
        if (picture === undefined) {
          return blankOutcome("clip", lane, "this lane has not drawn a picture yet.");
        }
        try {
          startImage = { bytes: await (deps.readMedia ?? readLocalMedia)(picture), ext: "png" };
        } catch (err) {
          return blankOutcome("clip", lane, `the picture this lane drew could not be read: ${String(err)}`);
        }
      }

      const [result] = await runClip({
        lanes: only,
        prompt: request.prompt,
        seed: CLIP_SEED,
        size,
        stamp,
        startImage,
        run: deps.run,
        sendFile: deps.sendFile,
        fetchFile: deps.fetchFile,
        write: async (_where, bytes) => deps.writeMedia(path, bytes),
        ping: deps.ping,
        sleepFor: deps.sleepFor,
        timeoutMs: deps.timeoutMs,
      });
      const made = result ?? blankResultClip(lane.label);
      return {
        kind: "clip",
        laneId: lane.laneId,
        result: made,
        mediaUrl: made.ok ? showMediaUrl(stamp, lane.label, "mp4") : null,
        fromPicture,
      };
    }

    const test = dailyTestFor(request.test.id, request.modelId, request.sizeId);
    if (test === null) {
      return blankOutcome("daily", lane, `there is no everyday job called "${request.test.id}" any more.`);
    }
    const [result] = await daily.runDaily({
      lanes: only,
      test,
      run: deps.run,
      ping: deps.ping,
      sleepFor: deps.sleepFor,
      timeoutMs: deps.timeoutMs,
    });
    return {
      kind: "daily",
      laneId: lane.laneId,
      result: result ?? blankResultDaily(lane.label),
      numberLabel: test.label,
    };
  };
}

/** A lane the CLI somehow returned nothing for. Should never happen; said plainly if it does. */
function blankResultDraw(label: string): DrawLaneResult {
  return { label, ok: false, loadSeconds: null, drawSeconds: null, localPath: null, error: "this lane did not run." };
}

function blankResultClip(label: string): ClipLaneResult {
  return { label, ok: false, seconds: null, localPath: null, error: "this lane did not run." };
}

function blankResultDaily(label: string): DailyLaneResult {
  return { label, ok: false, seconds: null, words: null, answer: null, error: "this lane did not run." };
}

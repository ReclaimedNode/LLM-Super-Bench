/**
 * `bun run daily` -- one everyday job, every Mac, at the same moment, for the
 * camera.
 *
 * The picture race and the video race both ask the machines to do something
 * nobody does on a Tuesday. This one asks them to do the work that actually
 * fills a working day here: transcode a take that came off the camera,
 * transcribe it, describe a minute of it with a vision model, or put the
 * decision model through 300 questions whose answers are already known.
 * Same files, same command, both Macs starting together.
 *
 * Two of the jobs produce something to read as well as a number, so they print
 * it between ANSWER-BEGIN and ANSWER-END and `parseDailyAnswer` lifts it out.
 * That is the whole point of those two: the seconds say which Mac was faster,
 * and the text underneath says whether what it produced was any good.
 *
 * The same warning applies as it does to `bun run draw` and `bun run clip`:
 * every lane starts at the same moment, so each machine is working while the
 * other one is, and these seconds are a show rather than a measurement. What
 * makes them worth showing anyway is that the job is real -- the audience
 * recognises it, and the difference they see is the difference they would get.
 *
 * Nothing here re-implements the machinery that already exists. Reaching a
 * sleeping Mac is `reachLane`, running the command is `runRemote`, the tail of
 * a failed command is `lastOutput`, and a lane's file name is `laneSlug`. What
 * this file adds is the table of jobs, the parallel start, and the plain
 * English.
 *
 * Everything above `runDaily` is pure: the argument parsing, the five remote
 * command strings, the timings and answers read back out, the verdict line and
 * the exit rule are all functions of their input, so they can be proven
 * without a Mac in the room.
 */

import { laneSlug } from "./draw.ts";
import { reachLane } from "./reach.ts";
import type { Pinger } from "./reach.ts";
import { remoteArg, runRemote } from "./ssh.ts";
import type { RemoteRunner } from "./ssh.ts";
import type { BenchConfig, BenchLane, SshTarget } from "./types.ts";
import { lastOutput } from "./video.ts";

/** Something a person got wrong, said in a sentence they can act on. */
export class DailyError extends Error {}

// ------------------------------------------------------------------ settings

/**
 * The reason this line exists: ffmpeg lives in ~/.local/bin on one of these
 * Macs and in /opt/homebrew/bin on the other. A plain ssh shell is not a login
 * shell and has neither on its PATH, so without this the job dies at once with
 * "command not found". `clip.ts` carries the same line for the same reason.
 */
export const DAILY_PATH_EXPORT = "export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH";

/**
 * `"$HOME"`, because a tilde inside single quotes is a literal tilde and the
 * path would not exist. `remoteArg` is the one place that knows that.
 */
const HOME = remoteArg("~");

/** The folder each Mac keeps the take in. Both machines already have it. */
export const DAILY_DIR = `${HOME}/bench-daily`;

/** The take itself: one 13.8-minute 4K camera file, the same on both machines. */
export const DAILY_TAKE = "take.mp4";
/** Its audio, pulled out beforehand, for the transcription job. */
export const DAILY_TAKE_AUDIO = "take.wav";
/** A whole shoot day's audio, beside it, for the long version of that job. */
export const DAILY_DAY_AUDIO = "day.wav";

/** The Python that has mlx_whisper in it, in its own environment on each Mac. */
export const WHISPER_PYTHON = `${HOME}/bench-envs/whisper/bin/python`;

/** The Python that has mlx_vlm in it, for the job that looks at footage. */
export const VLM_PYTHON = `${HOME}/bench-envs/vlm/bin/python`;
/** The Python that runs the decision model. */
export const LAYA_PYTHON = `${HOME}/bench-envs/laya/bin/python`;

/**
 * Where the weights live on every machine.
 *
 * The same folder `BENCH_MODELS_ROOT` in config.ts names for the picture and
 * video races, written in the `"$HOME"` form these commands use.
 */
export const DAILY_MODELS_ROOT = `${HOME}/bench-models`;

/** One minute cut out of the take, silent, for the job that describes footage. */
export const FOOTAGE_VIDEO = "window60.mp4";
/** Where that job's own noise goes, so only its answer comes back up the wire. */
export const FOOTAGE_LOG = "vlm-daily.log";

/** The decision model's folder, and the log it writes. */
export const LAYA_DIR = `${DAILY_DIR}/laya`;
export const LAYA_LOG = "laya-daily.log";

/**
 * How a job hands back something to read as well as a number.
 *
 * Two markers rather than "everything after the seconds", because both of
 * these jobs write a log full of progress bars and fetch notices first, and
 * the markers are what separate the part worth reading from the rest.
 */
export const ANSWER_BEGIN = "ANSWER-BEGIN";
export const ANSWER_END = "ANSWER-END";

/**
 * How long one lane may take.
 *
 * Generous on purpose: a fourteen-minute 4K take is a lot of frames, the first
 * transcription of the day pulls the weights down before it starts, and a run
 * that gave up in the middle of that on camera would be worse than a run that
 * waited.
 */
export const DAILY_TIMEOUT_MS = 30 * 60_000;

// ------------------------------------------------------------------ the jobs

export type DailyTestName = "hevc" | "prores" | "transcribe" | "footage" | "laya";

export interface DailyTest {
  name: DailyTestName;
  /** What this job is, for somebody who was not in the room. */
  description: string;
  /** What the number on screen is a number OF. */
  label: string;
  /** Exactly what that machine is asked to run. */
  command: string;
  /**
   * True for the jobs whose command prints an answer block.
   *
   * This table is the only thing that knows which ones those are, so it is the
   * only thing that gets to say so. A job that is supposed to say something and
   * came back with nothing said nothing worth timing either: it is a failure
   * with a fast-looking number on it, which is the worst shape a lane can take
   * on camera.
   */
  answers: boolean;
}

/**
 * The shell that times a job and says how long it took.
 *
 * `date +%s.%N` on both sides and `bc` for the subtraction, because that is
 * arithmetic every one of these machines can already do without anything being
 * installed. The job itself is chained with `&&`, so a failed job never gets as
 * far as printing a time and the lane reads as the failure it is.
 */
function timed(job: string): string {
  return `S=$(date +%s.%N) && ${job} && E=$(date +%s.%N) && echo "SECONDS $(echo "$E - $S" | bc)"`;
}

/**
 * The same, for a job that also has something to say.
 *
 * The markers are echoed rather than written by the job itself, so a job that
 * dies mid-sentence cannot leave a closing marker behind and pass a truncated
 * answer off as a whole one.
 */
function timedWithAnswer(job: string, capture: string): string {
  return `${timed(job)} && echo "${ANSWER_BEGIN}" && ${capture} && echo "${ANSWER_END}"`;
}

/** One ffmpeg transcode of the take, timed, in the folder the take lives in. */
function transcodeCommand(encoder: string[], output: string): string {
  const job = ["ffmpeg -hide_banner -loglevel error -y -i", DAILY_TAKE, ...encoder, output].join(" ");
  return [`${DAILY_PATH_EXPORT};`, `cd ${DAILY_DIR} &&`, timed(job)].join(" ");
}

// -------------------------------------------------------- the transcription

export type WhisperModelKey = "large-v3" | "turbo" | "medium" | "small" | "base" | "tiny";

export interface WhisperModel {
  key: WhisperModelKey;
  /** What it is called on screen. */
  name: string;
  /** The weights, fetched once and cached by huggingface_hub after that. */
  repo: string;
}

/**
 * Six sizes of the same model, largest first.
 *
 * large-v3 is the one a real take gets, and it stays the default so every
 * number already on the board still means what it said. The five under it are
 * there because the question an audience actually asks is what you give up by
 * going smaller: turbo is the same model with most of the decoder taken out,
 * and tiny is small enough to finish while the shot is still on it.
 */
export const WHISPER_MODELS: Record<WhisperModelKey, WhisperModel> = {
  "large-v3": { key: "large-v3", name: "Whisper large-v3", repo: "mlx-community/whisper-large-v3-mlx" },
  turbo: { key: "turbo", name: "Whisper large-v3 turbo", repo: "mlx-community/whisper-large-v3-turbo" },
  medium: { key: "medium", name: "Whisper medium", repo: "mlx-community/whisper-medium-mlx" },
  small: { key: "small", name: "Whisper small", repo: "mlx-community/whisper-small-mlx" },
  base: { key: "base", name: "Whisper base", repo: "mlx-community/whisper-base-mlx" },
  tiny: { key: "tiny", name: "Whisper tiny", repo: "mlx-community/whisper-tiny-mlx" },
};

export const WHISPER_MODEL_ORDER: WhisperModelKey[] = ["large-v3", "turbo", "medium", "small", "base", "tiny"];

export type AudioFileKey = "take" | "day";

/**
 * One of the two recordings that job can be pointed at.
 *
 * Four ways of saying the same thing, because the same file has to read well
 * in four places: the page's toggle, the note under it, the sentence that says
 * what the job is, and the label the seconds sit under. Deriving any of them
 * from another one gives a caption that reads like a machine wrote it.
 */
export interface AudioFile {
  key: AudioFileKey;
  /** What the page's toggle says. */
  toggle: string;
  /** What it is, for somebody deciding which one to pick. */
  description: string;
  /** What a sentence calls it. */
  name: string;
  /** How much audio it is, for the label the number sits under. */
  length: string;
  /** The file itself, beside the take in ~/bench-daily. */
  file: string;
}

/**
 * The 13.8-minute take, and a whole shoot day.
 *
 * The take is the default because it is the file every other job in this table
 * already uses, so the four numbers sit beside each other honestly. The day is
 * the one that shows what the difference between these machines is worth: a
 * gap of a couple of minutes on a take is most of an afternoon on a shoot day.
 */
export const AUDIO_FILES: Record<AudioFileKey, AudioFile> = {
  take: {
    key: "take",
    toggle: "13.8 MIN",
    description: "the 13.8-minute take",
    name: "the take",
    length: "13.8 minutes",
    file: DAILY_TAKE_AUDIO,
  },
  day: {
    key: "day",
    toggle: "WHOLE DAY",
    description: "the whole shoot day, 2 h 5 min",
    name: "the whole shoot day",
    length: "2 h 5 min",
    file: DAILY_DAY_AUDIO,
  },
};

export const AUDIO_FILE_ORDER: AudioFileKey[] = ["take", "day"];

/**
 * The transcription, timed inside Python rather than around it.
 *
 * `snapshot_download` first and the clock started after it, so the number is
 * the transcription and not the download. The snippet is single quoted as one
 * argument; every value in it comes from the two tables above, which are this
 * file's own literals, so there is nothing in it a shell could act on.
 *
 * The two settings are not tuning choices, they are what makes the two lanes
 * comparable, and they only work as a pair.
 *
 * `temperature=0.0` is the first half. Left alone, mlx_whisper walks a list of
 * temperatures and starts sampling whenever a segment comes back with low
 * confidence, so the same audio gives a different transcript every time. The
 * first live run showed exactly that: 1401 words on one Mac and 1233 on the
 * other, from one file. A scalar rather than a list is what turns the fallback
 * off.
 *
 * `condition_on_previous_text=False` is the second half, and it exists because
 * of the first. With one temperature there is no fallback left to break a bad
 * patch, so a silent stretch sends the model into a repetition loop -- and
 * because each 30-second window is normally primed with the text of the one
 * before it, the loop is handed forward and runs to the end of the file. Live:
 * the whole shoot day came back as one sentence repeated 4,499 times, and even
 * the 13.8-minute take's 940 words were 685 repeats of one short token. Starting each
 * window clean stops the loop being handed forward.
 *
 * What it does not do is make the two machines agree word for word: tiny over
 * the take came back 1032 words on one Mac and 1010 on the other. That is a
 * real difference and it is on screen under each lane, so it is worth saying
 * plainly -- the pin is what stops a lane sampling its way to a different
 * transcript on a rerun, not a promise that two different chips decode
 * identically.
 */
export function transcribeCommand(model: WhisperModel, file: AudioFile): string {
  const python = [
    "import time, mlx_whisper;",
    "from huggingface_hub import snapshot_download;",
    `p = snapshot_download("${model.repo}");`,
    "t = time.time();",
    `r = mlx_whisper.transcribe("${file.file}", path_or_hf_repo=p, temperature=0.0, condition_on_previous_text=False);`,
    'print("SECONDS", round(time.time() - t, 2));',
    'print("WORDS", len(r["text"].split()))',
  ].join(" ");
  return [`${DAILY_PATH_EXPORT};`, `cd ${DAILY_DIR} &&`, `${WHISPER_PYTHON} -c '${python}'`].join(" ");
}

/**
 * The transcription job, at whichever model and whichever recording.
 *
 * Both are named in the description and in the label for the same reason the
 * footage job names its model: the page prints these lines under two toggles,
 * and a sentence that says large-v3 over a run of tiny is a caption that
 * contradicts the machine on camera.
 */
export function transcribeTest(
  model: WhisperModel = WHISPER_MODELS["large-v3"],
  file: AudioFile = AUDIO_FILES.take,
): DailyTest {
  return {
    name: "transcribe",
    description: `Transcribe ${file.name}'s audio (${file.length}) with ${model.name} on MLX.`,
    label: `${file.length} of audio, ${model.name} transcription`,
    command: transcribeCommand(model, file),
    answers: false,
  };
}

// ------------------------------------------------------------- the vision job

export type FootageModelKey = "32b" | "8b";

export interface FootageModel {
  key: FootageModelKey;
  /** What it is called on screen. */
  name: string;
  /** The folder it sits in under ~/bench-models on every machine. */
  dir: string;
}

/**
 * Two sizes of the same model.
 *
 * 32B is the one worth showing, because it is the size that gives an answer
 * you would actually act on. 8B is there for when the shot needs the job to
 * finish sooner, and for showing what the smaller machine can still carry.
 */
export const FOOTAGE_MODELS: Record<FootageModelKey, FootageModel> = {
  "32b": { key: "32b", name: "Qwen3-VL 32B", dir: "Qwen3-VL-32B-Instruct-4bit" },
  "8b": { key: "8b", name: "Qwen3-VL 8B", dir: "Qwen3-VL-8B-Instruct-4bit" },
};

export const FOOTAGE_MODEL_ORDER: FootageModelKey[] = ["32b", "8b"];

/**
 * What the model is asked about the footage.
 *
 * Written to keep it on the ground: what is on screen, what kind of clip it
 * is, when things happen. The last line is there because a silent clip invites
 * a model to invent what was being said, and an invented quote in an ingest
 * pass is worse than no answer at all.
 */
export const FOOTAGE_PROMPT =
  "You are watching 60 seconds of raw, silent camera footage from a YouTube shoot. " +
  "Describe only what is physically there: who is on screen and what they are doing, " +
  "whether this is a person on camera or a screen recording, what is on any visible screen, " +
  "and notable moments with the second they happen. Then classify the clip in one line as one of: " +
  "talking head, screen recording, b-roll, mixed. No guesses about audio.";

/**
 * One pass of the vision model over a minute of footage, timed.
 *
 * Everything the port prints goes to a log rather than up the wire, because
 * mlx_vlm writes progress bars with carriage returns in them and a terminal
 * that is being filmed does not want forty of those. What comes back is the
 * log with the fetch notices and warnings taken out, carriage returns turned
 * into newlines so a progress bar reads as lines rather than one long smear,
 * and the blank lines dropped.
 */
export function footageCommand(model: FootageModel): string {
  const job = [
    `${VLM_PYTHON} -m mlx_vlm.generate`,
    `--model ${DAILY_MODELS_ROOT}/${model.dir}`,
    `--video ${FOOTAGE_VIDEO}`,
    "--fps 1.0",
    "--max-tokens 400",
    "--temperature 0",
    `--prompt '${FOOTAGE_PROMPT}'`,
    `> ${FOOTAGE_LOG} 2>&1`,
  ].join(" ");
  // The backslash before the pipe is grep's own alternation, not a shell pipe,
  // and the \r and \n are the two characters tr wants, not real ones.
  const capture = `grep -v -i 'fetching\\|warning' ${FOOTAGE_LOG} | tr '\\r' '\\n' | grep -v '^$'`;
  return [`${DAILY_PATH_EXPORT};`, `cd ${DAILY_DIR} &&`, timedWithAnswer(job, capture)].join(" ");
}

/**
 * The footage job, at whichever size of the model.
 *
 * The description names the model it was built with rather than a size written
 * into the sentence, because the page prints this line under the 32B/8B toggle
 * and a hardcoded "32B" there is a caption that contradicts the run on camera.
 */
export function footageTest(model: FootageModel = FOOTAGE_MODELS["32b"]): DailyTest {
  return {
    name: "footage",
    description:
      "Describe 60 seconds of raw, silent camera footage with a local vision model " +
      `(${model.name}, 4-bit, MLX) at 1 frame per second, the way an automatic footage-ingest pass would.`,
    label: `60 s of footage described with ${model.name}, model load included`,
    command: footageCommand(model),
    answers: true,
  };
}

// ----------------------------------------------------------- the decision job

/**
 * The decision model, over the questions we already have answers for.
 *
 * The script is the one that ran by hand on both machines, and it prints its
 * own scoreboard: per task, how many questions, how many it got wrong, and the
 * accuracy. The last six lines are that scoreboard, so that is what comes back.
 */
export function layaCommand(): string {
  const job = `${LAYA_PYTHON} run_laya.py > ${LAYA_LOG} 2>&1`;
  return [`${DAILY_PATH_EXPORT};`, `cd ${LAYA_DIR} &&`, timedWithAnswer(job, `tail -6 ${LAYA_LOG}`)].join(" ");
}

/**
 * Five jobs, and every one of them is something that happens here every week.
 *
 * The two transcodes go through VideoToolbox, which is the hardware encoder on
 * the chip -- that is the part the audience is watching, not ffmpeg's software
 * path. The transcription stands on the full large-v3 weights over the take,
 * because that is what a real take gets, and `--model` and `--file` move it
 * without moving anything else. The last two hand back their working as well as a
 * time: the vision model says what it saw, and the decision model says what it
 * scored, so the faster Mac still has to be the one that got it right.
 */
export const DAILY_TESTS: Record<DailyTestName, DailyTest> = {
  hevc: {
    name: "hevc",
    description: "Transcode a 13.8-minute 4K camera take to HEVC on the hardware encoder.",
    label: "13.8-minute take, HEVC hardware transcode",
    command: transcodeCommand(
      ["-c:v hevc_videotoolbox", "-b:v 20M", "-tag:v hvc1", "-c:a copy"],
      "out-hevc.mp4",
    ),
    answers: false,
  },
  prores: {
    name: "prores",
    description: "Transcode the same take to ProRes 422 on the hardware encoder.",
    label: "13.8-minute take, ProRes 422 hardware transcode",
    command: transcodeCommand(["-c:v prores_videotoolbox", "-profile:v 2", "-c:a copy"], "out-prores.mov"),
    answers: false,
  },
  transcribe: transcribeTest(),
  footage: footageTest(),
  laya: {
    name: "laya",
    description:
      "Run Laya, an open decision model, on 300 labelled questions (200 spam, " +
      "100 banking), and report accuracy and speed.",
    label: "300 questions answered, model load included",
    command: layaCommand(),
    answers: true,
  },
};

/** The order they are listed in: the take itself first, then the two that think about it. */
export const DAILY_TEST_ORDER: DailyTestName[] = ["hevc", "prores", "transcribe", "footage", "laya"];

/**
 * How wide the descriptions are allowed to get.
 *
 * Narrow on purpose. This list is on camera during the pre-roll, at a font
 * size that fits a fraction of a normal terminal's width, and a description
 * that soft-wraps wherever the window happens to end reads as a mess.
 */
export const DAILY_LIST_WIDTH = 72;

/** Breaks a line at spaces so it fits. A word longer than the width still runs over. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** A flag one job takes, and everything that may follow it. */
export interface DailyChoiceFlag {
  flag: string;
  values: string[];
}

/**
 * Which jobs have something to choose, and what the choices are called.
 *
 * One table rather than a sentence in each place that needs it, so the list
 * `bun run daily` prints, the help, and the message that refuses a wrong value
 * all say the same words. A job that is not in here takes no flag beyond
 * `--lane`, and saying one at it is an error rather than something ignored.
 */
export const DAILY_CHOICES: Partial<Record<DailyTestName, DailyChoiceFlag[]>> = {
  transcribe: [
    { flag: "--model", values: WHISPER_MODEL_ORDER },
    { flag: "--file", values: AUDIO_FILE_ORDER },
  ],
  footage: [{ flag: "--model", values: FOOTAGE_MODEL_ORDER }],
};

/** What `bun run daily` with no job named prints. */
export function testListLines(): string[] {
  return DAILY_TEST_ORDER.flatMap((name, i) => {
    const test = DAILY_TESTS[name];
    const body = wrap(test.description, DAILY_LIST_WIDTH).map((line) => `    ${line}`);
    // Under the description, because what a person does next with a job that
    // has choices is ask what the choices are, and the alternative is reading
    // the help for a job they have already found.
    const choices = (DAILY_CHOICES[name] ?? []).map((c) => `    ${c.flag.padEnd(8)} ${c.values.join(", ")}`);
    return i === 0 ? [`  ${test.name}`, ...body, ...choices] : ["", `  ${test.name}`, ...body, ...choices];
  });
}

// ------------------------------------------------------------------ arguments

export interface DailyArgs {
  help: boolean;
  /** null means nothing was named, so the jobs get listed instead of run. */
  test: DailyTest | null;
  /** Lane labels the person named. Empty means every lane this tool can reach. */
  lanes: string[];
}

const VALUE_FLAGS = new Set(["--lane", "--model", "--file"]);

/** "32B", "32b" and "Qwen3-VL 32B" are the same word said three ways. */
function plainly(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function footageModelFor(value: string): FootageModel {
  const normalised = plainly(value);
  for (const key of FOOTAGE_MODEL_ORDER) {
    if (normalised === key || normalised === `qwen3vl${key}`) return FOOTAGE_MODELS[key];
  }
  throw new DailyError(`I do not know the model "${value}". It is either 32b or 8b.`);
}

/** The same, for the transcription: "LARGE-V3", "large v3" and "largev3" all land. */
function whisperModelFor(value: string): WhisperModel {
  const normalised = plainly(value);
  for (const key of WHISPER_MODEL_ORDER) {
    if (normalised === plainly(key)) return WHISPER_MODELS[key];
  }
  throw new DailyError(
    `I do not know the model "${value}". It is one of: ${WHISPER_MODEL_ORDER.join(", ")}.`,
  );
}

/** Either recording, by its short name or by the file it actually is. */
function audioFileFor(value: string): AudioFile {
  const normalised = plainly(value);
  for (const key of AUDIO_FILE_ORDER) {
    const audio = AUDIO_FILES[key];
    if (normalised === plainly(key) || normalised === plainly(audio.file)) return audio;
  }
  throw new DailyError(`I do not know the file "${value}". It is one of: ${AUDIO_FILE_ORDER.join(", ")}.`);
}

/**
 * The job that was named, built with whatever was chosen for it.
 *
 * The flags are resolved here rather than where they were typed, because what
 * `--model` means depends on the job: the vision model's size for the footage
 * job, the Whisper model for the transcription. A flag aimed at a job that has
 * no such choice is said out loud rather than quietly dropped -- a person who
 * typed it is expecting something, and a silent run of the default is the one
 * outcome that looks like it worked.
 */
function testFor(value: string, model: string | null, file: string | null): DailyTest {
  const normalised = plainly(value);
  for (const name of DAILY_TEST_ORDER) {
    if (normalised !== name) continue;

    const takes = (flag: string) => (DAILY_CHOICES[name] ?? []).some((c) => c.flag === flag);
    if (file !== null && !takes("--file")) {
      throw new DailyError(`--file only means anything to the transcribe test, and this one is ${name}.`);
    }
    if (model !== null && !takes("--model")) {
      throw new DailyError(
        `--model only means anything to the footage and transcribe tests, and this one is ${name}.`,
      );
    }

    if (name === "footage") return model === null ? DAILY_TESTS.footage : footageTest(footageModelFor(model));
    if (name === "transcribe") {
      if (model === null && file === null) return DAILY_TESTS.transcribe;
      return transcribeTest(
        model === null ? WHISPER_MODELS["large-v3"] : whisperModelFor(model),
        file === null ? AUDIO_FILES.take : audioFileFor(file),
      );
    }
    return DAILY_TESTS[name];
  }
  throw new DailyError(
    `I do not know the test "${value}". The ones I have are ${DAILY_TEST_ORDER.join(", ")}. ` +
      `Run bun run daily on its own to see what each one does.`,
  );
}

export function parseDailyArgs(argv: string[]): DailyArgs {
  const bare: string[] = [];
  const lanes: string[] = [];
  // Kept as the word that was typed until the job is known, because the job is
  // what decides which table the word is looked up in.
  let model: string | null = null;
  let file: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new DailyError(`${arg} needs a value after it.`);
      i++;
      if (arg === "--model") model = value;
      else if (arg === "--file") file = value;
      else lanes.push(value);
      continue;
    }

    if (arg.startsWith("-")) throw new DailyError(`I do not know the option ${arg}. Run bun run daily --help.`);
    bare.push(arg);
  }

  if (help) return { help: true, test: null, lanes };

  // Naming nothing is not a mistake: it is how a person asks what the jobs are.
  if (bare.length === 0) return { help: false, test: null, lanes };

  if (bare.length > 1) {
    throw new DailyError(
      `I run one test at a time. I was given ${bare.length}: ${bare.map((b) => `"${b}"`).join(", ")}.`,
    );
  }

  return { help: false, test: testFor(bare[0]!, model, file), lanes };
}

// ------------------------------------------------------------------ lanes

export interface DailyLane {
  lane: BenchLane;
  target: SshTarget;
}

/**
 * Which machines run it.
 *
 * Every lane the config gives a way in to, unless the person named some. A
 * name is matched as written or as its file-name form, so `--lane m5-ultra-256gb`
 * works as well as `--lane "M5 Ultra 256GB"`.
 */
export function dailyLanes(config: BenchConfig, wanted: string[] = []): DailyLane[] {
  const managed = config.lanes.filter((lane): lane is BenchLane & { ssh: SshTarget } => lane.ssh !== undefined);
  if (managed.length === 0) {
    throw new DailyError("No lane in bench.config.json has an `ssh` block, so there is no machine to run this on.");
  }

  if (wanted.length === 0) return managed.map((lane) => ({ lane, target: lane.ssh }));

  const chosen: DailyLane[] = [];
  for (const name of wanted) {
    const hit = managed.find((lane) => lane.label === name || laneSlug(lane.label) === laneSlug(name));
    if (!hit) {
      throw new DailyError(
        `There is no lane called "${name}". The ones in bench.config.json are: ${managed.map((l) => l.label).join(", ")}.`,
      );
    }
    if (!chosen.some((c) => c.lane.label === hit.label)) chosen.push({ lane: hit, target: hit.ssh });
  }
  return chosen;
}

// ------------------------------------------------------------------ the timing

/**
 * The seconds the machine printed.
 *
 * The last SECONDS line rather than the first, so a job that somehow says it
 * twice is read as having finished the second time. `bc` writes a value below
 * one with no leading zero, so ".5" has to count as a number here.
 */
export function parseDailySeconds(output: string): number | null {
  const matches = [...output.matchAll(/^\s*SECONDS\s+(\d+\.?\d*|\.\d+)\s*$/gm)];
  const last = matches.at(-1);
  if (!last) return null;
  const seconds = Number(last[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * What the machine had to say, for the jobs that say something.
 *
 * Read line by line rather than by cutting the string between two markers,
 * because a vision model asked to describe a screen recording can perfectly
 * well write the word ANSWER-END in the middle of a sentence, and a marker
 * that only counts when it is the whole line cannot be faked that way.
 *
 * A block that was opened and never closed is still handed back: a job killed
 * by the timeout half way through printing has said something worth reading,
 * and the alternative is showing nothing at all. A block with no content in it
 * is null, so nothing is printed rather than an empty gap.
 */
export function parseDailyAnswer(output: string): string[] | null {
  const lines = output.split("\n").map((line) => line.replace(/\r/g, "").trimEnd());
  const begin = lines.findIndex((line) => line.trim() === ANSWER_BEGIN);
  if (begin === -1) return null;

  const body: string[] = [];
  for (const line of lines.slice(begin + 1)) {
    if (line.trim() === ANSWER_END) break;
    body.push(line);
  }

  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body.at(-1)!.trim() === "") body.pop();
  return body.length === 0 ? null : body;
}

/** Nothing printed, a block that opened and never closed, or a whole one. */
export type DailyAnswerState = "none" | "unfinished" | "whole";

/**
 * Whether the machine finished saying what it had to say.
 *
 * `parseDailyAnswer` hands back a block that was never closed, on purpose --
 * half an answer is still worth reading. This says what shape the block was,
 * which is a different question, and it is the one the lane's pass or fail
 * turns on: the closing marker is echoed by the shell only after the job
 * itself exited, so a missing one means the job died mid-sentence.
 *
 * Matched on whole lines for the same reason `parseDailyAnswer` is: a vision
 * model describing a screen recording can write the marker into a sentence.
 */
export function dailyAnswerState(output: string): DailyAnswerState {
  const lines = output.split("\n").map((line) => line.replace(/\r/g, "").trimEnd());
  const begin = lines.findIndex((line) => line.trim() === ANSWER_BEGIN);
  if (begin === -1) return "none";
  return lines.slice(begin + 1).some((line) => line.trim() === ANSWER_END) ? "whole" : "unfinished";
}

/** How many words came out of the transcription. Null for the jobs that make none. */
export function parseDailyWords(output: string): number | null {
  const matches = [...output.matchAll(/^\s*WORDS\s+(\d+)\s*$/gm)];
  const last = matches.at(-1);
  if (!last) return null;
  const words = Number(last[1]);
  return Number.isInteger(words) ? words : null;
}

/**
 * Why a lane came back with nothing, in the machine's own words.
 *
 * The last dozen lines rather than the first, because the reason a job failed
 * is always at the end: ffmpeg says what it cannot do on its final line, and a
 * Python traceback puts the actual error underneath the stack. `lastOutput`
 * puts the character cap on it.
 */
export function dailyFailureDetail(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = lines.slice(-12).join("\n");
  return lastOutput(tail, 1200) || "it printed nothing at all";
}

// ------------------------------------------------------------------ results

export interface DailyLaneResult {
  label: string;
  ok: boolean;
  /** Seconds for the job itself, as the machine measured it. */
  seconds: number | null;
  /** Words in the transcript, when the job was the transcription. */
  words: number | null;
  /** What the machine said, for the jobs that say something. */
  answer: string[] | null;
  /** Plain English, when something went wrong on this lane. */
  error: string | null;
}

/**
 * What one lane's block says on screen.
 *
 * The answer is indented one step further than the seconds, because it is what
 * that machine said rather than something this tool is reporting about it, and
 * on camera the two want to be told apart at a glance.
 */
export function laneReport(result: DailyLaneResult, test: DailyTest): string[] {
  const lines = [`  ${result.label}`];
  if (result.seconds !== null) lines.push(`    ${test.label}: ${result.seconds.toFixed(1)} s`);
  if (result.words !== null) lines.push(`    ${result.words} words transcribed`);
  if (result.answer !== null) lines.push(...result.answer.map((line) => `      ${line}`));
  if (result.error !== null) lines.push(`    ${result.error}`);
  return lines;
}

/**
 * The one line that compares the machines.
 *
 * Fastest against slowest, from the seconds the machines measured themselves.
 * Null when fewer than two lanes finished the job: there is nothing to compare.
 */
export function verdictLine(results: DailyLaneResult[]): string | null {
  const done = results.filter((r) => r.ok && r.seconds !== null).sort((a, b) => a.seconds! - b.seconds!);
  if (done.length < 2) return null;

  const fastest = done[0]!;
  const slowest = done.at(-1)!;
  const times = `(${fastest.seconds!.toFixed(1)} s against ${slowest.seconds!.toFixed(1)} s)`;
  const ratio = slowest.seconds! / fastest.seconds!;

  if (ratio.toFixed(1) === "1.0") {
    return `${fastest.label} and ${slowest.label} did it in about the same time ${times}.`;
  }
  return `${fastest.label} did it ${ratio.toFixed(1)}x faster than ${slowest.label} ${times}.`;
}

/**
 * Non-zero when any lane failed, and when nothing ran at all.
 *
 * One machine falling over never stops the other -- the lanes run
 * independently and every one of them finishes -- but the command still says
 * it went wrong, so a script driving this is not told everything was fine.
 */
export function dailyExitCode(results: DailyLaneResult[]): number {
  if (results.length === 0) return 1;
  return results.every((r) => r.ok) ? 0 : 1;
}

// ------------------------------------------------------------------ running

export interface DailyRunOptions {
  lanes: DailyLane[];
  test: DailyTest;
  /** One plain line at a time, as each machine gets on with it. */
  log?: (laneLabel: string, message: string) => void;
  /** Test seams. Everything that touches a machine goes through one. */
  run?: RemoteRunner;
  ping?: Pinger;
  sleepFor?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Every lane runs the job at once.
 *
 * That is the whole point of this command and the reason its seconds are not a
 * measurement. Each lane is walked end to end on its own and catches its own
 * failures, so one Mac being asleep, missing the take, or falling over
 * mid-transcode costs that lane its number and nothing else.
 */
export async function runDaily(opts: DailyRunOptions): Promise<DailyLaneResult[]> {
  const run = opts.run ?? runRemote;
  const timeoutMs = opts.timeoutMs ?? DAILY_TIMEOUT_MS;
  const say = (label: string, message: string) => opts.log?.(label, message);

  const runOne = async (lane: DailyLane): Promise<DailyLaneResult> => {
    const label = lane.lane.label;
    const blank: DailyLaneResult = { label, ok: false, seconds: null, words: null, answer: null, error: null };

    try {
      const reachable = await reachLane(lane.target, {
        run,
        ping: opts.ping,
        sleep: opts.sleepFor,
        log: (message) => say(label, message),
      });
      if (!reachable.ok) return { ...blank, error: reachable.detail };

      say(label, "working on it");
      const result = await run(lane.target, opts.test.command, { timeoutMs });
      const output = `${result.stdout}\n${result.stderr}`;

      // A time on its own is not a finished job. The shell prints SECONDS part
      // way along the chain, so everything after it -- the answer capture, the
      // tail of a log, the job's own clean-up -- can still fall over and leave
      // a number sitting there looking like a win. What the command exited
      // with is the machine's own verdict on itself, so both are read.
      const seconds = parseDailySeconds(output);
      if (!result.ok || seconds === null) {
        return {
          ...blank,
          error: `it did not finish the job. This machine said:\n${dailyFailureDetail(output)}`,
        };
      }

      const answer = dailyAnswerState(output);
      if (answer === "unfinished") {
        return {
          ...blank,
          error: `it stopped in the middle of its answer. This machine said:\n${dailyFailureDetail(output)}`,
        };
      }
      if (opts.test.answers && answer === "none") {
        return {
          ...blank,
          error: `it timed the job but never said what it found. This machine said:\n${dailyFailureDetail(output)}`,
        };
      }

      say(label, `done in ${seconds.toFixed(1)} s`);
      return {
        ...blank,
        ok: true,
        seconds,
        words: parseDailyWords(output),
        answer: parseDailyAnswer(output),
      };
    } catch (err) {
      return { ...blank, error: `something went wrong talking to this machine: ${String(err)}` };
    }
  };

  return await Promise.all(opts.lanes.map(runOne));
}

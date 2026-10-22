/**
 * `bun run daily` -- the on-camera everyday-work race.
 *
 * The parts worth proving here are the ones that are wrong silently: a command
 * whose ffmpeg flags drifted and now encodes in software instead of on the
 * chip, a missing PATH line that leaves the machine unable to find ffmpeg at
 * all, a timing line read the wrong way, a verdict that overstates which Mac
 * won, and a failure that exits zero and tells a script everything was fine.
 * All of those are functions of their input, so none of them needs a Mac.
 *
 * The three remote commands are asserted character for character on purpose.
 * They run on two machines that are being filmed tomorrow, and a flag that
 * quietly stopped saying `hevc_videotoolbox` would still produce a file, still
 * print a time, and still look completely fine on screen.
 *
 * The one end-to-end shape is driven against a fake machine, the same way the
 * picture and video races' tests are: two lanes, one of which falls over,
 * because that cannot be arranged on real hardware on demand and is exactly
 * the case that must not take the other lane down with it.
 */

import { describe, expect, test } from "bun:test";
import { validateBenchConfig } from "../src/bench/config.ts";
import {
  AUDIO_FILES,
  AUDIO_FILE_ORDER,
  DAILY_TEST_ORDER,
  DAILY_TESTS,
  DailyError,
  FOOTAGE_MODELS,
  WHISPER_MODELS,
  WHISPER_MODEL_ORDER,
  dailyAnswerState,
  dailyExitCode,
  dailyFailureDetail,
  dailyLanes,
  footageTest,
  laneReport,
  parseDailyAnswer,
  parseDailyArgs,
  parseDailySeconds,
  parseDailyWords,
  runDaily,
  testListLines,
  transcribeTest,
  verdictLine,
} from "../src/bench/daily.ts";
import type { DailyLaneResult } from "../src/bench/daily.ts";
import type { RemoteResult } from "../src/bench/ssh.ts";

// ------------------------------------------------------------------ fixtures

function config() {
  return validateBenchConfig({
    promptLengths: [{ label: "512", tokens: 512 }],
    models: [{ name: "Text", dir: "Text-4bit", hfRepo: "vendor/Text-4bit" }],
    lanes: [
      {
        label: "M3 Ultra 512GB",
        baseUrl: "http://one.local:8090",
        ssh: { host: "one.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      {
        label: "M5 Ultra 256GB",
        baseUrl: "http://two.local:8090",
        ssh: { host: "two.local", binDir: "~/bench-envs/llm/bin", port: 8090 },
      },
      { label: "Manual", baseUrl: "http://localhost:9002" },
    ],
  });
}

function result(over: Partial<DailyLaneResult> = {}): DailyLaneResult {
  return { label: "A", ok: true, seconds: 90.2, words: null, answer: null, error: null, ...over };
}

/** A machine that answers the way these jobs answer. */
class FakeMachine {
  commands: string[] = [];
  /** Seconds per host, so one machine can be made faster than the other. */
  secondsByHost: Record<string, number> = {};
  /** Hosts that fall over instead of finishing the job. */
  failHosts: string[] = [];
  /** Hosts that never answer ssh at all. */
  unreachableHosts: string[] = [];
  /** Words to print after the seconds, as the transcription job does. */
  words: number | null = null;
  /** Lines to print between the markers, as the footage and laya jobs do. */
  answer: string[] | null = null;

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (this.unreachableHosts.includes(target.host)) {
      return { ok: false, code: 255, stdout: "", stderr: "ssh: connect to host: Operation timed out" };
    }
    if (command === "echo READY") return ok("READY\n");

    if (this.failHosts.includes(target.host)) {
      return {
        ok: false,
        code: 1,
        stdout: "",
        stderr: "take.mp4: No such file or directory\n",
      };
    }
    const seconds = this.secondsByHost[target.host] ?? 90.2;
    const lines = [`SECONDS ${seconds}`];
    if (this.words !== null) lines.push(`WORDS ${this.words}`);
    if (this.answer !== null) lines.push("ANSWER-BEGIN", ...this.answer, "ANSWER-END");
    return ok(`${lines.join("\n")}\n`);
  };
}

// ------------------------------------------------------------------ arguments

describe("reading the command line", () => {
  test("the test name is the first thing that is not a flag", () => {
    const args = parseDailyArgs(["hevc"]);
    expect(args.test).toBe(DAILY_TESTS.hevc);
    expect(args.help).toBe(false);
  });

  test("every job can be named", () => {
    for (const name of DAILY_TEST_ORDER) {
      expect(parseDailyArgs([name]).test).toBe(DAILY_TESTS[name]);
    }
  });

  test("the footage job takes 32b unless 8b is asked for, and says which in its label", () => {
    const standard = parseDailyArgs(["footage"]).test!;
    expect(standard.label).toContain("Qwen3-VL 32B");
    expect(standard.command).toContain("Qwen3-VL-32B-Instruct-4bit");

    const small = parseDailyArgs(["footage", "--model", "8b"]).test!;
    expect(small.label).toContain("Qwen3-VL 8B");
    expect(small.command).toContain("Qwen3-VL-8B-Instruct-4bit");
    expect(small.command).not.toContain("Qwen3-VL-32B-Instruct-4bit");
  });

  test("the footage job describes itself by the model it was built with", () => {
    // The page prints this sentence under the 32B/8B toggle, so a size written
    // into the words would caption an 8B run with the 32B model's name.
    const small = footageTest(FOOTAGE_MODELS["8b"]).description;
    expect(small).toContain("Qwen3-VL 8B");
    expect(small).not.toContain("32B");
    expect(footageTest(FOOTAGE_MODELS["32b"]).description).toContain("Qwen3-VL 32B");
    expect(DAILY_TESTS.footage.description).toContain("Qwen3-VL 32B");
  });

  test("the model is named the way a person would say it, in any case", () => {
    for (const written of ["8b", "8B", "Qwen3-VL-8B"]) {
      expect(parseDailyArgs(["footage", "--model", written]).test!.label).toContain("Qwen3-VL 8B");
    }
    expect(parseDailyArgs(["footage", "--model", "32B"]).test!.label).toContain("Qwen3-VL 32B");
  });

  test("a vision model nobody has is refused by name", () => {
    expect(() => parseDailyArgs(["footage", "--model", "70b"])).toThrow(/either 32b or 8b/);
  });

  test("--model on a job that has no model to pick is said out loud, not ignored", () => {
    expect(() => parseDailyArgs(["hevc", "--model", "8b"])).toThrow(
      /only means anything to the footage and transcribe tests/,
    );
    expect(() => parseDailyArgs(["hevc", "--model", "8b"])).toThrow(/this one is hevc/);
  });

  test("the transcription takes large-v3 over the take unless something else is asked for", () => {
    const standard = parseDailyArgs(["transcribe"]).test!;
    expect(standard).toBe(DAILY_TESTS.transcribe);
    expect(standard.command).toContain("mlx-community/whisper-large-v3-mlx");
    expect(standard.command).toContain('"take.wav"');
  });

  test("--model and --file move the transcription, and both show up in what it says", () => {
    const chosen = parseDailyArgs(["transcribe", "--model", "turbo", "--file", "day"]).test!;
    expect(chosen.command).toContain("mlx-community/whisper-large-v3-turbo");
    expect(chosen.command).toContain('"day.wav"');
    expect(chosen.label).toBe("2 h 5 min of audio, Whisper large-v3 turbo transcription");
    expect(chosen.description).toBe(
      "Transcribe the whole shoot day's audio (2 h 5 min) with Whisper large-v3 turbo on MLX.",
    );
  });

  test("either flag on its own leaves the other one where it was", () => {
    const smaller = parseDailyArgs(["transcribe", "--model", "tiny"]).test!;
    expect(smaller.command).toContain('"take.wav"');
    expect(smaller.label).toBe("13.8 minutes of audio, Whisper tiny transcription");

    const longer = parseDailyArgs(["transcribe", "--file", "day"]).test!;
    expect(longer.command).toContain("mlx-community/whisper-large-v3-mlx");
    expect(longer.label).toBe("2 h 5 min of audio, Whisper large-v3 transcription");
  });

  test("the Whisper model and the recording are named the way a person would say them", () => {
    for (const written of ["LARGE-V3", "large v3", "largev3"]) {
      expect(parseDailyArgs(["transcribe", "--model", written]).test!.command).toContain(
        "mlx-community/whisper-large-v3-mlx",
      );
    }
    // The file by its own name as well as its short one, because a person
    // looking at ~/bench-daily sees day.wav rather than "day".
    expect(parseDailyArgs(["transcribe", "--file", "day.wav"]).test!.command).toContain('"day.wav"');
  });

  test("a Whisper model nobody has is refused with the real ones named", () => {
    expect(() => parseDailyArgs(["transcribe", "--model", "huge"])).toThrow(DailyError);
    expect(() => parseDailyArgs(["transcribe", "--model", "huge"])).toThrow(/I do not know the model "huge"/);
    expect(() => parseDailyArgs(["transcribe", "--model", "huge"])).toThrow(
      /large-v3, turbo, medium, small, base, tiny/,
    );
  });

  test("a recording nobody has is refused with the real ones named", () => {
    expect(() => parseDailyArgs(["transcribe", "--file", "week"])).toThrow(DailyError);
    expect(() => parseDailyArgs(["transcribe", "--file", "week"])).toThrow(/I do not know the file "week"/);
    expect(() => parseDailyArgs(["transcribe", "--file", "week"])).toThrow(/take, day/);
  });

  test("--file on a job that has no recording to pick is said out loud, not ignored", () => {
    expect(() => parseDailyArgs(["footage", "--file", "day"])).toThrow(
      /--file only means anything to the transcribe test/,
    );
    expect(() => parseDailyArgs(["footage", "--file", "day"])).toThrow(/this one is footage/);
    expect(() => parseDailyArgs(["hevc", "--file", "take"])).toThrow(/this one is hevc/);
  });

  test("--file needs a value after it, like every other flag that takes one", () => {
    expect(() => parseDailyArgs(["transcribe", "--file"])).toThrow(/needs a value/);
  });

  test("naming nothing lists the jobs instead of running one", () => {
    const args = parseDailyArgs([]);
    expect(args.test).toBeNull();
    expect(args.help).toBe(false);
  });

  test("a job nobody has heard of is refused by name, with the real ones listed", () => {
    expect(() => parseDailyArgs(["h265"])).toThrow(DailyError);
    expect(() => parseDailyArgs(["h265"])).toThrow(/I do not know the test "h265"/);
    expect(() => parseDailyArgs(["h265"])).toThrow(/hevc, prores, transcribe, footage, laya/);
  });

  test("two job names at once is caught rather than silently running the first", () => {
    expect(() => parseDailyArgs(["hevc", "prores"])).toThrow(/one test at a time/);
  });

  test("--lane can be given more than once and keeps the order", () => {
    const args = parseDailyArgs(["hevc", "--lane", "M5 Ultra 256GB", "--lane", "M3 Ultra 512GB"]);
    expect(args.lanes).toEqual(["M5 Ultra 256GB", "M3 Ultra 512GB"]);
  });

  test("no --lane means every lane", () => {
    expect(parseDailyArgs(["hevc"]).lanes).toEqual([]);
  });

  test("--help needs no job, and an unknown option is named", () => {
    expect(parseDailyArgs(["--help"]).help).toBe(true);
    expect(parseDailyArgs(["-h"]).help).toBe(true);
    expect(() => parseDailyArgs(["hevc", "--fast"])).toThrow(/--fast/);
    expect(() => parseDailyArgs(["hevc", "--lane"])).toThrow(/needs a value/);
  });
});

// ------------------------------------------------------------------ the list

describe("the list of jobs", () => {
  test("the shortest job reads exactly like this", () => {
    expect(testListLines().slice(0, 2)).toEqual([
      "  hevc",
      "    Transcode a 13.8-minute 4K camera take to HEVC on the hardware encoder.",
    ]);
  });

  test("every job is named, in order, with a blank line between them", () => {
    const lines = testListLines();
    expect(lines.filter((l) => !l.startsWith("    ") && l !== "")).toEqual(DAILY_TEST_ORDER.map((n) => `  ${n}`));
    for (let i = 1; i < lines.length; i++) {
      // A name is only ever preceded by a blank line, never by another name.
      if (/^ {2}\S/.test(lines[i]!)) expect(lines[i - 1]).toBe("");
    }
  });

  test("every description survives the wrap word for word", () => {
    const lines = testListLines();
    for (const name of DAILY_TEST_ORDER) {
      const start = lines.indexOf(`  ${name}`);
      const body: string[] = [];
      for (const line of lines.slice(start + 1)) {
        // The flag lines sit under the description at the same indent, and
        // they are the choices rather than the sentence, so the sentence ends
        // where the first one starts.
        if (!line.startsWith("    ") || line.trim().startsWith("--")) break;
        body.push(line.trim());
      }
      expect(body.join(" ")).toBe(DAILY_TESTS[name].description);
    }
  });

  test("the jobs with something to choose print the choices under themselves", () => {
    const lines = testListLines();
    expect(lines).toContain("    --model  large-v3, turbo, medium, small, base, tiny");
    expect(lines).toContain("    --file   take, day");
    expect(lines).toContain("    --model  32b, 8b");

    // And a job with nothing to choose prints no flag line at all: hevc is its
    // name, one line of description, then the gap before the next job.
    const hevc = lines.indexOf("  hevc");
    expect(lines[hevc + 2]).toBe("");
  });

  test("no line is wide enough to wrap again on a terminal that is being filmed", () => {
    // The two long descriptions are the reason the wrap exists at all.
    for (const line of testListLines()) expect(line.length).toBeLessThanOrEqual(76);
    expect(testListLines().filter((l) => l.startsWith("    ")).length).toBeGreaterThan(DAILY_TEST_ORDER.length);
  });

  test("the list and the table hold the same five jobs, in the same order", () => {
    expect(DAILY_TEST_ORDER).toEqual(["hevc", "prores", "transcribe", "footage", "laya"]);
    expect(Object.keys(DAILY_TESTS)).toEqual(DAILY_TEST_ORDER);
  });
});

// ------------------------------------------------------------------ commands

describe("what one machine is asked to run", () => {
  test("hevc, exactly, because every character of it matters", () => {
    expect(DAILY_TESTS.hevc.command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `cd "$HOME"/bench-daily && ` +
        `S=$(date +%s.%N) && ` +
        `ffmpeg -hide_banner -loglevel error -y -i take.mp4 ` +
        `-c:v hevc_videotoolbox -b:v 20M -tag:v hvc1 -c:a copy out-hevc.mp4 && ` +
        `E=$(date +%s.%N) && ` +
        `echo "SECONDS $(echo "$E - $S" | bc)"`,
    );
  });

  test("prores, exactly", () => {
    expect(DAILY_TESTS.prores.command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `cd "$HOME"/bench-daily && ` +
        `S=$(date +%s.%N) && ` +
        `ffmpeg -hide_banner -loglevel error -y -i take.mp4 ` +
        `-c:v prores_videotoolbox -profile:v 2 -c:a copy out-prores.mov && ` +
        `E=$(date +%s.%N) && ` +
        `echo "SECONDS $(echo "$E - $S" | bc)"`,
    );
  });

  test("transcribe, exactly", () => {
    expect(DAILY_TESTS.transcribe.command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `cd "$HOME"/bench-daily && ` +
        `"$HOME"/bench-envs/whisper/bin/python -c ` +
        `'import time, mlx_whisper; ` +
        `from huggingface_hub import snapshot_download; ` +
        `p = snapshot_download("mlx-community/whisper-large-v3-mlx"); ` +
        `t = time.time(); ` +
        `r = mlx_whisper.transcribe("take.wav", path_or_hf_repo=p, temperature=0.0, ` +
        `condition_on_previous_text=False); ` +
        `print("SECONDS", round(time.time() - t, 2)); ` +
        `print("WORDS", len(r["text"].split()))'`,
    );
  });

  test("the default transcription still says exactly what it always said", () => {
    // The six models and the two recordings are new; the job the board's
    // numbers were measured on is not, and a moved word here would quietly
    // relabel every one of them.
    expect(DAILY_TESTS.transcribe.description).toBe(
      "Transcribe the take's audio (13.8 minutes) with Whisper large-v3 on MLX.",
    );
    expect(DAILY_TESTS.transcribe.label).toBe("13.8 minutes of audio, Whisper large-v3 transcription");
  });

  test("transcribe at turbo over the whole day, exactly, and nothing else moved", () => {
    expect(transcribeTest(WHISPER_MODELS.turbo, AUDIO_FILES.day).command).toBe(
      DAILY_TESTS.transcribe.command
        .replace("mlx-community/whisper-large-v3-mlx", "mlx-community/whisper-large-v3-turbo")
        .replace('"take.wav"', '"day.wav"'),
    );
  });

  test("every model asks for its own weights, and every recording for its own file", () => {
    for (const key of WHISPER_MODEL_ORDER) {
      const model = WHISPER_MODELS[key];
      expect(transcribeTest(model, AUDIO_FILES.take).command).toContain(`snapshot_download("${model.repo}")`);
    }
    for (const key of AUDIO_FILE_ORDER) {
      const file = AUDIO_FILES[key];
      expect(transcribeTest(WHISPER_MODELS["large-v3"], file).command).toContain(
        `mlx_whisper.transcribe("${file.file}", path_or_hf_repo=p, temperature=0.0, condition_on_previous_text=False)`,
      );
    }
  });

  test("all twelve of them stay pinned, timed and labelled the same way", () => {
    for (const modelKey of WHISPER_MODEL_ORDER) {
      for (const fileKey of AUDIO_FILE_ORDER) {
        const job = transcribeTest(WHISPER_MODELS[modelKey], AUDIO_FILES[fileKey]);
        // Both halves of the pin, on every one of them: a model or a file that
        // kept only the temperature is the one that loops on silence.
        expect(job.command).toContain("temperature=0.0");
        expect(job.command).toContain("condition_on_previous_text=False");
        expect(job.command).toContain('print("SECONDS", round(time.time() - t, 2));');
        expect(job.command).toContain('print("WORDS", len(r["text"].split()))');
        expect(job.command).toContain(`cd "$HOME"/bench-daily &&`);
        // Both toggles are named, because the page prints this label under
        // both of them and the terminal prints it beside the seconds.
        expect(job.label).toContain(WHISPER_MODELS[modelKey].name);
        expect(job.label).toContain(AUDIO_FILES[fileKey].length);
        expect(job.description).toContain(WHISPER_MODELS[modelKey].name);
        expect(job.description).toContain(AUDIO_FILES[fileKey].name);
      }
    }
  });

  test("footage, exactly", () => {
    expect(DAILY_TESTS.footage.command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `cd "$HOME"/bench-daily && ` +
        `S=$(date +%s.%N) && ` +
        `"$HOME"/bench-envs/vlm/bin/python -m mlx_vlm.generate ` +
        `--model "$HOME"/bench-models/Qwen3-VL-32B-Instruct-4bit ` +
        `--video window60.mp4 --fps 1.0 --max-tokens 400 --temperature 0 ` +
        `--prompt 'You are watching 60 seconds of raw, silent camera footage from a YouTube shoot. ` +
        `Describe only what is physically there: who is on screen and what they are doing, ` +
        `whether this is a person on camera or a screen recording, what is on any visible screen, ` +
        `and notable moments with the second they happen. Then classify the clip in one line as one of: ` +
        `talking head, screen recording, b-roll, mixed. No guesses about audio.' ` +
        `> vlm-daily.log 2>&1 && ` +
        `E=$(date +%s.%N) && ` +
        `echo "SECONDS $(echo "$E - $S" | bc)" && ` +
        `echo "ANSWER-BEGIN" && ` +
        `grep -v -i 'fetching\\|warning' vlm-daily.log | tr '\\r' '\\n' | grep -v '^$' && ` +
        `echo "ANSWER-END"`,
    );
  });

  test("footage at 8b, exactly, and nothing but the model moved", () => {
    const small = footageTest(FOOTAGE_MODELS["8b"]).command;
    expect(small).toBe(
      DAILY_TESTS.footage.command.replace("Qwen3-VL-32B-Instruct-4bit", "Qwen3-VL-8B-Instruct-4bit"),
    );
  });

  test("laya, exactly", () => {
    expect(DAILY_TESTS.laya.command).toBe(
      `export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH; ` +
        `cd "$HOME"/bench-daily/laya && ` +
        `S=$(date +%s.%N) && ` +
        `"$HOME"/bench-envs/laya/bin/python run_laya.py > laya-daily.log 2>&1 && ` +
        `E=$(date +%s.%N) && ` +
        `echo "SECONDS $(echo "$E - $S" | bc)" && ` +
        `echo "ANSWER-BEGIN" && ` +
        `tail -6 laya-daily.log && ` +
        `echo "ANSWER-END"`,
    );
  });

  test("the grep alternation is grep's, not the shell's, and tr gets two characters not two newlines", () => {
    // `\\|` in the source is one backslash and a pipe on the machine, which is
    // BRE alternation. A bare `|` would pipe the log into a program called
    // warning. And `'\r'` must arrive as a backslash and an r, not as a real
    // carriage return, or tr is asked to translate nothing.
    const command = DAILY_TESTS.footage.command;
    expect(command).toContain("grep -v -i 'fetching\\|warning'");
    expect(command).toContain("tr '\\r' '\\n'");
    expect(command).not.toContain("'fetching|warning'");
    expect(command).not.toContain("\r");
  });

  test("both talking jobs hide their own noise in a log and hand back only the answer", () => {
    expect(DAILY_TESTS.footage.command).toContain("> vlm-daily.log 2>&1");
    expect(DAILY_TESTS.laya.command).toContain("> laya-daily.log 2>&1");
    for (const name of ["footage", "laya"] as const) {
      expect(DAILY_TESTS[name].command).toContain('echo "ANSWER-BEGIN"');
      expect(DAILY_TESTS[name].command.endsWith('echo "ANSWER-END"')).toBe(true);
    }
  });

  test("the vision model is told not to invent what it cannot hear", () => {
    // A silent clip invites a model to make up dialogue, and an invented quote
    // in an ingest pass is worse than no answer.
    expect(DAILY_TESTS.footage.command).toContain("No guesses about audio.");
    expect(DAILY_TESTS.footage.command).toContain("--temperature 0");
    expect(DAILY_TESTS.footage.command).toContain("--fps 1.0");
  });

  test("every job starts with the PATH line, because a plain ssh shell has no ffmpeg", () => {
    // One Mac keeps ffmpeg in ~/.local/bin and the other in /opt/homebrew/bin,
    // and a plain ssh shell has neither.
    for (const name of DAILY_TEST_ORDER) {
      expect(DAILY_TESTS[name].command.startsWith("export PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH;")).toBe(true);
    }
  });

  test("both transcodes go through the chip's encoder, not ffmpeg's software one", () => {
    expect(DAILY_TESTS.hevc.command).toContain("-c:v hevc_videotoolbox");
    expect(DAILY_TESTS.prores.command).toContain("-c:v prores_videotoolbox");
    expect(DAILY_TESTS.hevc.command).not.toContain("libx265");
    expect(DAILY_TESTS.prores.command).not.toContain("-c:v prores_ks");
  });

  test("the audio is copied rather than re-encoded, so the number is the picture", () => {
    expect(DAILY_TESTS.hevc.command).toContain("-c:a copy");
    expect(DAILY_TESTS.prores.command).toContain("-c:a copy");
  });

  test("the transcription is pinned both ways, so no lane samples and none loops", () => {
    // Left alone, mlx_whisper walks a list of temperatures and samples when a
    // segment's confidence is low, so the same audio transcribes differently
    // every run. The first live run showed it: 1401 words against 1233, one
    // file. A scalar, not a list, is what turns that fallback off.
    //
    // And with no fallback left, a silent stretch loops -- one sentence 4,499
    // times on the whole-day file, 685 repeats of one short token inside the take's 940
    // words -- because each window is primed with the text of the one before
    // it and hands the loop forward. Both settings or neither: the temperature
    // on its own is what causes the second failure. Neither makes two
    // different chips decode identically -- tiny over the take came back 1032
    // words against 1010 -- and nothing here claims they do.
    expect(DAILY_TESTS.transcribe.command).toContain("temperature=0.0");
    expect(DAILY_TESTS.transcribe.command).toContain("condition_on_previous_text=False");
    expect(DAILY_TESTS.transcribe.command).toContain(
      'mlx_whisper.transcribe("take.wav", path_or_hf_repo=p, temperature=0.0, condition_on_previous_text=False)',
    );
  });

  test("the transcription clock starts after the weights are fetched, not before", () => {
    const command = DAILY_TESTS.transcribe.command;
    expect(command.indexOf("snapshot_download(")).toBeLessThan(command.indexOf("t = time.time()"));
    expect(command).toContain("whisper-large-v3-mlx");
  });

  test("every job runs where its files already are, and reads them", () => {
    for (const name of ["hevc", "prores", "transcribe", "footage"] as const) {
      expect(DAILY_TESTS[name].command).toContain(`cd "$HOME"/bench-daily &&`);
    }
    // Laya is the one with a folder of its own, because it has a script and a
    // question set rather than a single file.
    expect(DAILY_TESTS.laya.command).toContain(`cd "$HOME"/bench-daily/laya &&`);

    expect(DAILY_TESTS.hevc.command).toContain("-i take.mp4");
    expect(DAILY_TESTS.prores.command).toContain("-i take.mp4");
    expect(DAILY_TESTS.transcribe.command).toContain('"take.wav"');
    expect(DAILY_TESTS.footage.command).toContain("--video window60.mp4");
    expect(DAILY_TESTS.laya.command).toContain("run_laya.py");
  });

  test("a job that fails never reaches the line that prints a time", () => {
    // Chained with &&, so a broken ffmpeg cannot report having taken 0.3 s and
    // a vision model that died cannot leave a closing marker behind.
    for (const name of DAILY_TEST_ORDER) {
      if (name === "transcribe") continue; // it times itself inside Python
      expect(DAILY_TESTS[name].command).toContain(`&& E=$(date +%s.%N) && echo "SECONDS`);
    }
  });

  test("the jobs the table says will answer are exactly the ones whose command prints one", () => {
    // The flag is what a missing answer is judged against, so it has to track
    // the command rather than somebody's memory of which jobs talk.
    for (const name of DAILY_TEST_ORDER) {
      expect(DAILY_TESTS[name].answers).toBe(DAILY_TESTS[name].command.includes('echo "ANSWER-BEGIN"'));
    }
    expect(DAILY_TESTS.footage.answers).toBe(true);
    expect(DAILY_TESTS.laya.answers).toBe(true);
    expect(DAILY_TESTS.hevc.answers).toBe(false);
  });
});

// ------------------------------------------------------------------ lanes

describe("choosing the machines", () => {
  test("every lane with a way in, and never a manual one", () => {
    expect(dailyLanes(config()).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
  });

  test("--lane restricts to what was named, by label or by file name", () => {
    expect(dailyLanes(config(), ["M5 Ultra 256GB"]).map((l) => l.lane.label)).toEqual(["M5 Ultra 256GB"]);
    expect(dailyLanes(config(), ["m3-ultra-512gb"]).map((l) => l.lane.label)).toEqual(["M3 Ultra 512GB"]);
  });

  test("a lane nobody has is refused, and the real ones are listed", () => {
    expect(() => dailyLanes(config(), ["M7 Ultra"])).toThrow(/M3 Ultra 512GB, M5 Ultra 256GB/);
  });
});

// ------------------------------------------------------------------ the timing

describe("reading what the machine printed", () => {
  test("the SECONDS line is the seconds", () => {
    expect(parseDailySeconds("SECONDS 90.2\n")).toBe(90.2);
  });

  test("decimals survive, however many bc printed", () => {
    expect(parseDailySeconds("SECONDS 90.217343000\n")).toBe(90.217343);
    expect(parseDailySeconds("SECONDS 120\n")).toBe(120);
    // bc writes a value below one with no leading zero.
    expect(parseDailySeconds("SECONDS .53\n")).toBe(0.53);
  });

  test("the line is found among everything else the job printed", () => {
    const output = ["frame= 2400 fps=180", "SECONDS 90.2", ""].join("\n");
    expect(parseDailySeconds(output)).toBe(90.2);
  });

  test("output with no SECONDS line at all is a lane that failed", () => {
    expect(parseDailySeconds("take.mp4: No such file or directory\n")).toBeNull();
    expect(parseDailySeconds("")).toBeNull();
    expect(parseDailySeconds("SECONDS lots\n")).toBeNull();
  });

  test("an answer block is read as missing, half-printed, or whole", () => {
    expect(dailyAnswerState("SECONDS 90.2\n")).toBe("none");
    expect(dailyAnswerState(["SECONDS 26.2", "ANSWER-BEGIN", "A man sits at a"].join("\n"))).toBe("unfinished");
    expect(dailyAnswerState(["SECONDS 26.2", "ANSWER-BEGIN", "all of it", "ANSWER-END"].join("\n"))).toBe("whole");
  });

  test("a marker written into a sentence is not a marker", () => {
    const output = ["SECONDS 26.2", "ANSWER-BEGIN", "the screen reads ANSWER-END in white text"].join("\n");
    expect(dailyAnswerState(output)).toBe("unfinished");
  });

  test("the word count comes back when the job made one, and not otherwise", () => {
    expect(parseDailyWords("SECONDS 90.2\nWORDS 2104\n")).toBe(2104);
    expect(parseDailyWords("SECONDS 90.2\n")).toBeNull();
  });

  test("the answer is what sits between the two markers", () => {
    const output = ["SECONDS 26.2", "ANSWER-BEGIN", "A man sits at a desk.", "ANSWER-END", ""].join("\n");
    expect(parseDailyAnswer(output)).toEqual(["A man sits at a desk."]);
  });

  test("a multi-line answer keeps its lines and its order", () => {
    const output = [
      "SECONDS 26.2",
      "ANSWER-BEGIN",
      "A man sits at a desk in front of a neon sign.",
      "At 12 s he picks up a mug.",
      "",
      "talking head",
      "ANSWER-END",
    ].join("\n");
    expect(parseDailyAnswer(output)).toEqual([
      "A man sits at a desk in front of a neon sign.",
      "At 12 s he picks up a mug.",
      "",
      "talking head",
    ]);
  });

  test("a job with nothing to say has no answer at all", () => {
    expect(parseDailyAnswer("SECONDS 90.2\n")).toBeNull();
    expect(parseDailyAnswer("")).toBeNull();
    // Opened and closed with nothing in between is nothing to print.
    expect(parseDailyAnswer("ANSWER-BEGIN\n\n  \nANSWER-END\n")).toBeNull();
  });

  test("blank lines around the answer are dropped, inside it are kept", () => {
    const output = ["ANSWER-BEGIN", "", "first", "", "second", "", "ANSWER-END"].join("\n");
    expect(parseDailyAnswer(output)).toEqual(["first", "", "second"]);
  });

  test("a block that was never closed is still handed back rather than lost", () => {
    // A job killed by the timeout half way through printing has still said
    // something worth reading.
    const output = ["SECONDS 26.2", "ANSWER-BEGIN", "A man sits at a desk and then"].join("\n");
    expect(parseDailyAnswer(output)).toEqual(["A man sits at a desk and then"]);
  });

  test("a model that writes the closing marker into a sentence cannot cut itself short", () => {
    // The markers only count as whole lines, which is why they are read line
    // by line rather than cut out of the string.
    const output = [
      "ANSWER-BEGIN",
      "The screen recording shows the words ANSWER-END in a terminal.",
      "talking head",
      "ANSWER-END",
    ].join("\n");
    expect(parseDailyAnswer(output)).toEqual([
      "The screen recording shows the words ANSWER-END in a terminal.",
      "talking head",
    ]);
  });

  test("carriage returns left by a progress bar do not survive into the answer", () => {
    expect(parseDailyAnswer("ANSWER-BEGIN\r\nA man sits at a desk.\r\nANSWER-END\r\n")).toEqual([
      "A man sits at a desk.",
    ]);
  });

  test("what a failed lane shows is the END of its output, where the reason is", () => {
    const noisy = [...Array(40).keys()].map((i) => `frame ${i}`).concat(["Error: no such file or directory"]);
    const detail = dailyFailureDetail(noisy.join("\n"));
    expect(detail).toContain("Error: no such file or directory");
    expect(detail).toContain("frame 29");
    expect(detail).not.toContain("frame 28");
    expect(detail.split("\n")).toHaveLength(12);
  });

  test("a machine that printed nothing says so rather than showing an empty block", () => {
    expect(dailyFailureDetail("\n  \n")).toBe("it printed nothing at all");
  });
});

// ------------------------------------------------------------------ verdict

describe("the line that compares them", () => {
  test("fastest against slowest, the ratio and the seconds to one decimal", () => {
    const line = verdictLine([
      result({ label: "M3 Ultra 512GB", seconds: 120.4 }),
      result({ label: "M5 Ultra 256GB", seconds: 90.2 }),
    ]);
    // 120.4 / 90.2 is 1.334…, which to one decimal is 1.3.
    expect(line).toBe("M5 Ultra 256GB did it 1.3x faster than M3 Ultra 512GB (90.2 s against 120.4 s).");
  });

  test("two machines that are level are not dressed up as a win", () => {
    const line = verdictLine([result({ label: "A", seconds: 90.2 }), result({ label: "B", seconds: 92.0 })]);
    expect(line).toBe("A and B did it in about the same time (90.2 s against 92.0 s).");
  });

  test("with more than two, it is the fastest against the slowest", () => {
    const line = verdictLine([
      result({ label: "A", seconds: 20 }),
      result({ label: "B", seconds: 10 }),
      result({ label: "C", seconds: 40 }),
    ]);
    expect(line).toBe("B did it 4.0x faster than C (10.0 s against 40.0 s).");
  });

  test("one number is nothing to compare, so there is no line at all", () => {
    expect(verdictLine([result()])).toBeNull();
    expect(verdictLine([result(), result({ ok: false, seconds: null, error: "it fell over" })])).toBeNull();
    expect(verdictLine([])).toBeNull();
  });

  test("a lane's block says the seconds and what they are seconds OF", () => {
    const lines = laneReport(result({ label: "M5 Ultra 256GB", seconds: 90.24 }), DAILY_TESTS.hevc);
    expect(lines[0]).toBe("  M5 Ultra 256GB");
    expect(lines[1]).toBe("    13.8-minute take, HEVC hardware transcode: 90.2 s");
  });

  test("the transcription also says how many words came out", () => {
    const lines = laneReport(result({ seconds: 61.5, words: 2104 }), DAILY_TESTS.transcribe);
    expect(lines.join("\n")).toContain("13.8 minutes of audio, Whisper large-v3 transcription: 61.5 s");
    expect(lines.join("\n")).toContain("2104 words transcribed");
  });

  test("what the machine said is printed under its time, indented one step further", () => {
    const lines = laneReport(
      result({ label: "M5 Ultra 256GB", seconds: 26.2, answer: ["A man sits at a desk.", "talking head"] }),
      DAILY_TESTS.footage,
    );
    expect(lines).toEqual([
      "  M5 Ultra 256GB",
      "    60 s of footage described with Qwen3-VL 32B, model load included: 26.2 s",
      "      A man sits at a desk.",
      "      talking head",
    ]);
  });

  test("the smaller vision model is named in the line, so nobody quotes the wrong number", () => {
    const lines = laneReport(result({ seconds: 7.0 }), footageTest(FOOTAGE_MODELS["8b"]));
    expect(lines[1]).toBe("    60 s of footage described with Qwen3-VL 8B, model load included: 7.0 s");
  });

  test("laya's scoreboard comes back under its time", () => {
    const lines = laneReport(
      result({ label: "M5 Ultra 256GB", seconds: 26.8, answer: ["spam n=200 fail=17 acc=0.915"] }),
      DAILY_TESTS.laya,
    );
    expect(lines[1]).toBe("    300 questions answered, model load included: 26.8 s");
    expect(lines[2]).toBe("      spam n=200 fail=17 acc=0.915");
  });

  test("a lane that failed says so in its own block", () => {
    const lines = laneReport(result({ ok: false, seconds: null, error: "it did not finish the job." }), DAILY_TESTS.hevc);
    expect(lines.join("\n")).toContain("it did not finish the job.");
    expect(lines.join("\n")).not.toContain(" s");
  });
});

// ------------------------------------------------------------------ exit code

describe("what the command exits with", () => {
  test("zero only when every lane finished the job", () => {
    expect(dailyExitCode([result(), result({ label: "B" })])).toBe(0);
  });

  test("non-zero when any lane failed, even though the others finished", () => {
    expect(dailyExitCode([result(), result({ label: "B", ok: false, error: "no such file" })])).toBe(1);
  });

  test("non-zero when nothing ran at all", () => {
    expect(dailyExitCode([])).toBe(1);
  });
});

// ------------------------------------------------------------------ a run

describe("a run against fake machines", () => {
  const base = {
    test: DAILY_TESTS.hevc,
    ping: async () => {},
    sleepFor: async () => {},
  };

  test("both lanes run it, and the faster one wins", async () => {
    const machine = new FakeMachine();
    machine.secondsByHost = { "one.local": 120.4, "two.local": 90.2 };

    const results = await runDaily({
      ...base,
      lanes: dailyLanes(config()),
      run: machine.run as never,
    });

    expect(results.map((r) => r.label)).toEqual(["M3 Ultra 512GB", "M5 Ultra 256GB"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]!.seconds).toBe(90.2);
    expect(machine.commands.filter((c) => c === DAILY_TESTS.hevc.command)).toHaveLength(2);
    expect(verdictLine(results)).toBe(
      "M5 Ultra 256GB did it 1.3x faster than M3 Ultra 512GB (90.2 s against 120.4 s).",
    );
    expect(dailyExitCode(results)).toBe(0);
  });

  test("the job that ran is the one that was named, and nothing else", async () => {
    const machine = new FakeMachine();
    await runDaily({
      ...base,
      test: DAILY_TESTS.transcribe,
      lanes: dailyLanes(config(), ["M5 Ultra 256GB"]),
      run: machine.run as never,
    });

    expect(machine.commands).toContain(DAILY_TESTS.transcribe.command);
    expect(machine.commands).not.toContain(DAILY_TESTS.hevc.command);
  });

  test("the transcription's word count comes back with its seconds", async () => {
    const machine = new FakeMachine();
    machine.words = 2104;

    const results = await runDaily({
      ...base,
      test: DAILY_TESTS.transcribe,
      lanes: dailyLanes(config(), ["M5 Ultra 256GB"]),
      run: machine.run as never,
    });

    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.words).toBe(2104);
  });

  test("what the vision model said comes back with its seconds", async () => {
    const machine = new FakeMachine();
    machine.secondsByHost = { "one.local": 76.3, "two.local": 26.2 };
    machine.answer = ["A man sits at a desk in front of a neon sign.", "talking head"];

    const results = await runDaily({
      ...base,
      test: DAILY_TESTS.footage,
      lanes: dailyLanes(config()),
      run: machine.run as never,
    });

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results[1]!.answer).toEqual(["A man sits at a desk in front of a neon sign.", "talking head"]);
    expect(machine.commands).toContain(DAILY_TESTS.footage.command);
    expect(verdictLine(results)).toBe(
      "M5 Ultra 256GB did it 2.9x faster than M3 Ultra 512GB (26.2 s against 76.3 s).",
    );
  });

  test("asking for the smaller vision model sends the smaller vision model", async () => {
    const machine = new FakeMachine();
    const test = parseDailyArgs(["footage", "--model", "8b"]).test!;

    await runDaily({ ...base, test, lanes: dailyLanes(config(), ["M5 Ultra 256GB"]), run: machine.run as never });

    expect(machine.commands).toContain(test.command);
    expect(machine.commands.join(" ")).toContain("Qwen3-VL-8B-Instruct-4bit");
    expect(machine.commands.join(" ")).not.toContain("Qwen3-VL-32B-Instruct-4bit");
  });

  test("laya's scoreboard comes back with its seconds", async () => {
    const machine = new FakeMachine();
    machine.answer = ["spam n=200 fail=17 acc=0.915", "banking n=100 fail=34 acc=0.66"];

    const results = await runDaily({
      ...base,
      test: DAILY_TESTS.laya,
      lanes: dailyLanes(config(), ["M5 Ultra 256GB"]),
      run: machine.run as never,
    });

    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.answer).toEqual(["spam n=200 fail=17 acc=0.915", "banking n=100 fail=34 acc=0.66"]);
  });

  test("a transcode reports no word count and nothing to read, because it makes neither", async () => {
    const machine = new FakeMachine();
    const results = await runDaily({
      ...base,
      lanes: dailyLanes(config(), ["M5 Ultra 256GB"]),
      run: machine.run as never,
    });

    expect(results[0]!.words).toBeNull();
    expect(results[0]!.answer).toBeNull();
  });

  test("every machine is asked at the same time, not one after the other", async () => {
    const machine = new FakeMachine();
    let working = 0;
    let atOnce = 0;
    const slowRun = async (target: { host: string }, command: string): Promise<RemoteResult> => {
      if (command === DAILY_TESTS.hevc.command) {
        working++;
        atOnce = Math.max(atOnce, working);
        await Bun.sleep(20);
        const answer = await machine.run(target, command);
        working--;
        return answer;
      }
      return await machine.run(target, command);
    };

    await runDaily({ ...base, lanes: dailyLanes(config()), run: slowRun as never });

    expect(atOnce).toBe(2);
  });

  test("one machine falling over costs that lane its number and nothing else", async () => {
    const machine = new FakeMachine();
    machine.failHosts = ["one.local"];

    const results = await runDaily({
      ...base,
      lanes: dailyLanes(config()),
      run: machine.run as never,
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    const fine = results.find((r) => r.label === "M5 Ultra 256GB")!;
    expect(broken.ok).toBe(false);
    expect(broken.seconds).toBeNull();
    expect(broken.error).toContain("did not finish the job");
    expect(broken.error).toContain("No such file or directory");
    expect(fine.ok).toBe(true);
    expect(fine.seconds).toBe(90.2);
    expect(dailyExitCode(results)).toBe(1);
  });

  /** A machine that wakes up and then says exactly this, and nothing else. */
  function machineSaying(over: Partial<RemoteResult>) {
    return async (_target: { host: string }, command: string): Promise<RemoteResult> => {
      if (command === "echo READY") return { ok: true, code: 0, stdout: "READY\n", stderr: "" };
      return { ok: true, code: 0, stdout: "", stderr: "", ...over };
    };
  }

  const oneLane = () => dailyLanes(config(), ["M5 Ultra 256GB"]);

  test("a job that printed a time and then exited non-zero is a failed lane", async () => {
    // The shell prints SECONDS part way along the chain, so a job can hand back
    // a number and still die on the next step. The exit status is what the
    // machine itself says about that, and it is read before the number is used.
    const results = await runDaily({
      ...base,
      lanes: oneLane(),
      run: machineSaying({
        ok: false,
        code: 1,
        stdout: "SECONDS 42.5\n",
        stderr: "out-hevc.mp4: Conversion failed\n",
      }) as never,
    });

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.seconds).toBeNull();
    expect(results[0]!.error).toContain("did not finish the job");
    expect(results[0]!.error).toContain("Conversion failed");
    expect(dailyExitCode(results)).toBe(1);
  });

  test("a job that is supposed to answer and came back with only a time is a failed lane", async () => {
    const results = await runDaily({
      ...base,
      test: DAILY_TESTS.footage,
      lanes: oneLane(),
      run: machineSaying({ stdout: "SECONDS 61.4\n" }) as never,
    });

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.seconds).toBeNull();
    expect(results[0]!.error).toContain("never said what it found");
  });

  test("an answer that began and never ended is a failed lane, not a fast one", async () => {
    const results = await runDaily({
      ...base,
      test: DAILY_TESTS.footage,
      lanes: oneLane(),
      run: machineSaying({
        stdout: ["SECONDS 61.4", "ANSWER-BEGIN", "A man sits at a desk in front of", ""].join("\n"),
      }) as never,
    });

    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.error).toContain("stopped in the middle of its answer");
  });

  test("a transcode with nothing but a time and a clean exit is still a good lane", async () => {
    const results = await runDaily({
      ...base,
      lanes: oneLane(),
      run: machineSaying({ stdout: "SECONDS 88.1\n" }) as never,
    });

    expect(results[0]!.ok).toBe(true);
    expect(results[0]!.seconds).toBe(88.1);
    expect(results[0]!.answer).toBeNull();
    expect(dailyExitCode(results)).toBe(0);
  });

  test("a machine that never wakes says so in words a person can act on", async () => {
    const machine = new FakeMachine();
    machine.unreachableHosts = ["one.local"];
    const lines: string[] = [];

    const results = await runDaily({
      ...base,
      lanes: dailyLanes(config()),
      run: machine.run as never,
      log: (label, message) => lines.push(`${label}: ${message}`),
    });

    const broken = results.find((r) => r.label === "M3 Ultra 512GB")!;
    expect(lines.join(" ")).toContain("it may be asleep; waking it");
    expect(broken.error).toContain("could not reach");
    expect(broken.error).toContain("press a key on it");
    expect(results.find((r) => r.label === "M5 Ultra 256GB")!.ok).toBe(true);
    expect(dailyExitCode(results)).toBe(1);
  });
});

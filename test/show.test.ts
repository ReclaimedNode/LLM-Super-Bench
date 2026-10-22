/**
 * `bun run show` -- the on-camera test page.
 *
 * The parts worth proving here are the ones that are wrong silently or wrong
 * expensively: a run that skips an event the page is waiting for, a lane that
 * falls over and takes the other one with it, a second START that puts two
 * jobs on the same Mac, a /media path that reaches outside the run folder, a
 * request that runs a different test from the one that was pressed, and a
 * verdict written here rather than by the command that owns the test.
 *
 * None of it needs a Mac. The one end-to-end shape is driven against a fake
 * machine, the same way draw.test.ts drives the picture race, because the two
 * Macs are needed for filming and a lane falling over cannot be arranged on
 * real hardware on demand.
 */

import { describe, expect, test } from "bun:test";
import { validateBenchConfig } from "../src/bench/config.ts";
import {
  AUDIO_FILES,
  DAILY_TESTS,
  DAILY_TEST_ORDER,
  FOOTAGE_MODELS,
  WHISPER_MODELS,
  footageTest,
  transcribeTest,
} from "../src/bench/daily.ts";
import { verdictLine as drawVerdictLine } from "../src/bench/draw.ts";
import type { DrawLaneResult } from "../src/bench/draw.ts";
import type { RemoteResult } from "../src/bench/ssh.ts";
import type { BenchLane, SshTarget } from "../src/bench/types.ts";
import { VIDEO_DISCLOSURE } from "../src/bench/video.ts";
import {
  BUSY_MESSAGE,
  CLIP_ABOUT_PICTURE,
  CLIP_ABOUT_SCRATCH,
  CLIP_FROM_PICTURE,
  CLIP_FROM_SCRATCH,
  DEFAULT_SHOW_PORT,
  RunLock,
  SHOW_RESULTS_ROOT,
  aboutFor,
  blankOutcome,
  dailyTestFor,
  clipFromPicture,
  laneEvent,
  laneRunnerFor,
  missingPictureMessage,
  parseRunRequest,
  picturesFrom,
  resolveShowMedia,
  runShow,
  showMediaPath,
  showMediaUrl,
  showPortFrom,
  showTests,
  splitFailure,
  verdictFor,
} from "../src/show/run.ts";
import type { ShowEvent, ShowLaneRef, ShowMachine, ShowOutcome, ShowTest } from "../src/show/run.ts";

// ------------------------------------------------------------------ fixtures

const STAMP = "20260920-183045";

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

/** The lanes as the page sees them, and as the runner looks them up. */
function machines(): { refs: ShowLaneRef[]; byId: Map<string, ShowMachine> } {
  const managed = config().lanes.filter((lane): lane is BenchLane & { ssh: SshTarget } => lane.ssh !== undefined);
  const all: ShowMachine[] = managed.map((lane, index) => ({
    laneId: `lane-${index}`,
    label: lane.label,
    lane,
    target: lane.ssh,
  }));
  return {
    refs: all.map((m) => ({ laneId: m.laneId, label: m.label })),
    byId: new Map(all.map((m) => [m.laneId, m])),
  };
}

function testNamed(id: string): ShowTest {
  const found = showTests().find((t) => t.id === id);
  if (!found) throw new Error(`the page has no test called ${id}`);
  return found;
}

function drawResult(over: Partial<DrawLaneResult> = {}): DrawLaneResult {
  return { label: "A", ok: true, loadSeconds: 12.8, drawSeconds: 2, localPath: null, error: null, ...over };
}

/** A machine that answers the way the timing shim answers. */
class FakeMachine {
  commands: string[] = [];
  written: string[] = [];
  /** Seconds per host, so one machine can be made faster than the other. */
  secondsByHost: Record<string, number> = {};
  /** Hosts that fall over instead of drawing. */
  failHosts: string[] = [];

  run = async (target: { host: string }, command: string): Promise<RemoteResult> => {
    this.commands.push(command);
    const ok = (stdout: string): RemoteResult => ({ ok: true, code: 0, stdout, stderr: "" });
    if (command === "echo READY") return ok("READY\n");

    if (command.includes("mflux_bench.py")) {
      if (this.failHosts.includes(target.host)) {
        return ok(JSON.stringify({ event: "error", message: "RuntimeError: out of memory" }) + "\n");
      }
      const seconds = this.secondsByHost[target.host] ?? 4;
      return ok(
        [
          JSON.stringify({ event: "loaded", seconds: 31.5 }),
          JSON.stringify({
            event: "image",
            index: 0,
            warmup: false,
            seconds,
            path: `~/bench-draw/${STAMP}/img_0.png`,
          }),
          JSON.stringify({ event: "done", peak_memory_gb: 41.2 }),
        ].join("\n") + "\n",
      );
    }

    if (command.includes("ltx-2-mlx generate")) {
      const seconds = this.secondsByHost[target.host] ?? 24.3;
      return ok(["Denoising: 100%|##########| 8/8", `Time: ${seconds}s`].join("\n") + "\n");
    }
    return ok("");
  };

  sendShim = async (): Promise<RemoteResult> => ({ ok: true, code: 0, stdout: "SHIM_WRITTEN\n", stderr: "" });

  /** Every picture copied OUT to a machine, with where it landed. */
  sent: { host: string; path: string; bytes: number }[] = [];

  sendFile = async (target: { host: string }, path: string, bytes: Uint8Array): Promise<RemoteResult> => {
    this.sent.push({ host: target.host, path, bytes: bytes.byteLength });
    return { ok: true, code: 0, stdout: "FILE_WRITTEN\n", stderr: "" };
  };

  /** Pictures this Mac is holding, by path, for a clip that starts from one. */
  onDisk = new Map<string, Uint8Array>();

  readMedia = async (path: string): Promise<Uint8Array> => {
    const bytes = this.onDisk.get(path);
    if (bytes === undefined) throw new Error(`no such file: ${path}`);
    return bytes;
  };

  fetchFile = async (): Promise<Uint8Array | null> => new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

  writeMedia = async (path: string): Promise<void> => {
    this.written.push(path);
  };
}

/** A promise this test finishes when it wants to, so a lane can be held open. */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

/** Collects the stream the page would receive. */
function recorder() {
  const events: ShowEvent[] = [];
  return { events, emit: (event: ShowEvent) => void events.push(event) };
}

// ------------------------------------------------------------------ the tests

describe("the tests on the page", () => {
  test("the two that make something to look at come first, then every everyday job", () => {
    const ids = showTests().map((t) => t.id);
    expect(ids.slice(0, 2)).toEqual(["draw", "clip"]);
    expect(ids.slice(2)).toEqual([...DAILY_TEST_ORDER]);
  });

  test("only draw and clip ask for words to be typed", () => {
    for (const test of showTests()) {
      expect(test.prompt === null).toBe(test.id !== "draw" && test.id !== "clip");
    }
  });

  test("the clip's size toggle carries both sizes, and the picture has none", () => {
    expect(testNamed("clip").sizes?.map((s) => s.id)).toEqual(["small", "big"]);
    expect(testNamed("draw").sizes).toBeNull();
  });

  test("the transcription offers six models and two recordings, in the table's order", () => {
    const transcribe = testNamed("transcribe");
    expect(transcribe.models?.map((m) => m.id)).toEqual(["large-v3", "turbo", "medium", "small", "base", "tiny"]);
    expect(transcribe.models?.map((m) => m.label)).toEqual([
      "LARGE-V3",
      "TURBO",
      "MEDIUM",
      "SMALL",
      "BASE",
      "TINY",
    ]);
    expect(transcribe.models?.map((m) => m.note)).toEqual([
      "Whisper large-v3",
      "Whisper large-v3 turbo",
      "Whisper medium",
      "Whisper small",
      "Whisper base",
      "Whisper tiny",
    ]);

    expect(transcribe.sizes?.map((s) => s.id)).toEqual(["take", "day"]);
    expect(transcribe.sizes?.map((s) => s.label)).toEqual(["13.8 MIN", "WHOLE DAY"]);
    expect(transcribe.sizes?.map((s) => s.note)).toEqual([
      "the 13.8-minute take",
      "the whole shoot day, 2 h 5 min",
    ]);
  });

  test("the transcription carries the table's own line for each model and recording", () => {
    const byChoice = testNamed("transcribe").aboutByModel!;
    expect(Object.keys(byChoice)).toHaveLength(12);
    expect(byChoice["turbo/day"]).toBe(transcribeTest(WHISPER_MODELS.turbo, AUDIO_FILES.day).description);
    expect(byChoice["turbo/day"]).toContain("Whisper large-v3 turbo");
    expect(byChoice["turbo/day"]).toContain("the whole shoot day");
    expect(byChoice["tiny/take"]).toContain("Whisper tiny");
    expect(byChoice["tiny/take"]).not.toContain("shoot day");
  });

  test("the footage toggle is untouched by the transcription having two of its own", () => {
    expect(testNamed("footage").models?.map((m) => m.id)).toEqual(["32b", "8b"]);
    expect(testNamed("footage").sizes).toBeNull();
  });

  test("what a button says about itself is what the everyday-jobs table says", () => {
    expect(testNamed("hevc").about).toBe(DAILY_TESTS.hevc.description);
  });

  test("the vision job carries the table's own line for each model it offers", () => {
    const footage = testNamed("footage");
    expect(footage.aboutByModel).toEqual({
      "32b": footageTest(FOOTAGE_MODELS["32b"]).description,
      "8b": footageTest(FOOTAGE_MODELS["8b"]).description,
    });
    expect(footage.aboutByModel!["8b"]).toContain("Qwen3-VL 8B");
    expect(footage.aboutByModel!["8b"]).not.toContain("32B");
  });

  test("a test with nothing to toggle has no second line to switch to", () => {
    expect(testNamed("hevc").aboutByModel).toBeNull();
    expect(testNamed("draw").aboutByModel).toBeNull();
  });

  test("the clip offers the two starting points, from scratch first", () => {
    const clip = testNamed("clip");
    expect(clip.models?.map((m) => m.id)).toEqual([CLIP_FROM_SCRATCH, CLIP_FROM_PICTURE]);
    expect(clip.models?.map((m) => m.label)).toEqual(["FROM SCRATCH", "FROM LAST PICTURE"]);
    // First in the row is what a request with nothing named falls on, so the
    // button that is pressed by default is the one that needs nothing drawn.
    expect(clip.models?.[0]!.id).toBe(CLIP_FROM_SCRATCH);
  });

  test("the clip's line says where the clip starts, for either size", () => {
    const clip = testNamed("clip");
    expect(clip.about).toBe(CLIP_ABOUT_SCRATCH);
    expect(clip.aboutByModel?.["scratch/small"]).toBe(CLIP_ABOUT_SCRATCH);
    expect(clip.aboutByModel?.["last/small"]).toBe(CLIP_ABOUT_PICTURE);
    expect(clip.aboutByModel?.["last/big"]).toBe(CLIP_ABOUT_PICTURE);
    expect(clip.aboutByModel?.["last/big"]).toContain("last picture");
    expect(clip.aboutByModel?.["scratch/big"]).not.toContain("last picture");
  });

  test("an everyday job carries the table's own command, never a retyped one", () => {
    const found = dailyTestFor("hevc", null);
    expect(found?.command).toBe(DAILY_TESTS.hevc.command);
  });

  test("a job this build of the table does not have is refused, not guessed at", () => {
    expect(dailyTestFor("nonsense", null)).toBeNull();
  });

  test("the job behind the two toggles is the table's own, built from both of them", () => {
    const chosen = dailyTestFor("transcribe", "turbo", "day")!;
    expect(chosen.command).toBe(transcribeTest(WHISPER_MODELS.turbo, AUDIO_FILES.day).command);
    expect(chosen.command).toContain("mlx-community/whisper-large-v3-turbo");
    expect(chosen.command).toContain('"day.wav"');
    // The label is what the number on camera sits under, so it has to say
    // which model read which recording.
    expect(chosen.label).toBe("2 h 5 min of audio, Whisper large-v3 turbo transcription");
  });

  test("the transcription with nothing toggled is the table's own default", () => {
    expect(dailyTestFor("transcribe", null)).toBe(DAILY_TESTS.transcribe);
  });
});

// ------------------------------------------------------------------ requests

describe("reading what the page asked for", () => {
  test("a test nobody has is refused, and the message says what there is", () => {
    const parsed = parseRunRequest({ test: "wordcount" }, showTests());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('I do not know the test "wordcount"');
      expect(parsed.message).toContain("draw, clip");
    }
  });

  test("draw without a prompt says what to type instead of drawing nothing", () => {
    const parsed = parseRunRequest({ test: "draw" }, showTests());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toBe("Type what you want drawn, then press START.");
  });

  test("a prompt of nothing but spaces counts as no prompt", () => {
    const parsed = parseRunRequest({ test: "clip", prompt: "   " }, showTests());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toBe("Type what you want filmed, then press START.");
  });

  test("the prompt arrives trimmed, and the first size is the one used by default", () => {
    const parsed = parseRunRequest({ test: "clip", prompt: "  a paper plane  " }, showTests());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.prompt).toBe("a paper plane");
      expect(parsed.request.sizeId).toBe("small");
    }
  });

  test("a size that is not one of the sizes is refused", () => {
    const parsed = parseRunRequest({ test: "clip", prompt: "a plane", size: "enormous" }, showTests());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("It is one of: small, big.");
  });

  test("an everyday job needs no prompt at all", () => {
    const parsed = parseRunRequest({ test: "hevc" }, showTests());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.request.prompt).toBe("");
  });

  test("a model toggle takes its own choices, and refuses anything else", () => {
    // Written out rather than taken from the page, so this holds whether or
    // not the vision job is in this build of the everyday-jobs table.
    const withModels: ShowTest = {
      id: "footage",
      label: "FOOTAGE",
      kind: "daily",
      about: "Describe a minute of footage.",
      prompt: null,
      sizes: null,
      models: [
        { id: "32b", label: "32B", note: "Qwen3-VL 32B" },
        { id: "8b", label: "8B", note: "Qwen3-VL 8B" },
      ],
      aboutByModel: {
        "32b": "Describe a minute of footage with Qwen3-VL 32B.",
        "8b": "Describe a minute of footage with Qwen3-VL 8B.",
      },
    };
    const chosen = parseRunRequest({ test: "footage", model: "8b" }, [withModels]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.request.modelId).toBe("8b");

    const fallback = parseRunRequest({ test: "footage" }, [withModels]);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) expect(fallback.request.modelId).toBe("32b");

    const wrong = parseRunRequest({ test: "footage", model: "70b" }, [withModels]);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.message).toContain("It is one of: 32b, 8b.");
  });

  test("the line about the run names the model that was picked, never the other one", () => {
    // Written out rather than taken from the page, for the same reason the
    // test above is: this holds whether or not the vision job is in this build.
    const withModels: ShowTest = {
      id: "footage",
      label: "FOOTAGE",
      kind: "daily",
      about: "Describe a minute of footage with Qwen3-VL 32B.",
      prompt: null,
      sizes: null,
      models: [
        { id: "32b", label: "32B", note: "Qwen3-VL 32B" },
        { id: "8b", label: "8B", note: "Qwen3-VL 8B" },
      ],
      aboutByModel: {
        "32b": "Describe a minute of footage with Qwen3-VL 32B.",
        "8b": "Describe a minute of footage with Qwen3-VL 8B.",
      },
    };

    const small = parseRunRequest({ test: "footage", model: "8b" }, [withModels]);
    if (!small.ok) throw new Error(small.message);
    expect(aboutFor(small.request)).toBe("Describe a minute of footage with Qwen3-VL 8B.");
    expect(aboutFor(small.request)).not.toContain("32B");

    const big = parseRunRequest({ test: "footage" }, [withModels]);
    if (!big.ok) throw new Error(big.message);
    expect(aboutFor(big.request)).toBe("Describe a minute of footage with Qwen3-VL 32B.");
  });

  test("the line about a transcription run names the model and the recording picked", () => {
    const parsed = parseRunRequest({ test: "transcribe", model: "tiny", size: "day" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.request.modelId).toBe("tiny");
    expect(parsed.request.sizeId).toBe("day");
    expect(aboutFor(parsed.request)).toBe(transcribeTest(WHISPER_MODELS.tiny, AUDIO_FILES.day).description);
    expect(aboutFor(parsed.request)).not.toContain("large-v3");
  });

  test("a transcription with neither toggle named falls on large-v3 over the take", () => {
    const parsed = parseRunRequest({ test: "transcribe" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.request.modelId).toBe("large-v3");
    expect(parsed.request.sizeId).toBe("take");
    expect(aboutFor(parsed.request)).toBe(DAILY_TESTS.transcribe.description);
  });

  test("a model or a recording this page never offered is refused, not run", () => {
    const wrongModel = parseRunRequest({ test: "transcribe", model: "huge" }, showTests());
    expect(wrongModel.ok).toBe(false);
    if (!wrongModel.ok) {
      expect(wrongModel.message).toContain("It is one of: large-v3, turbo, medium, small, base, tiny.");
    }

    const wrongFile = parseRunRequest({ test: "transcribe", size: "week" }, showTests());
    expect(wrongFile.ok).toBe(false);
    if (!wrongFile.ok) expect(wrongFile.message).toContain("It is one of: take, day.");
  });

  test("a test with no model to pick keeps the one line it has", () => {
    const parsed = parseRunRequest({ test: "hevc" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);
    expect(aboutFor(parsed.request)).toBe(DAILY_TESTS.hevc.description);
  });

  test("something that is not a request at all is refused rather than defaulted", () => {
    expect(parseRunRequest(null, showTests()).ok).toBe(false);
    expect(parseRunRequest("draw", showTests()).ok).toBe(false);
    expect(parseRunRequest([], showTests()).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ one at a time

describe("one run at a time", () => {
  test("a second START while a run is going is refused", () => {
    const lock = new RunLock();
    expect(lock.take()).toBe(true);
    expect(lock.take()).toBe(false);
    expect(lock.busy).toBe(true);
  });

  test("the next START works once the run has finished", () => {
    const lock = new RunLock();
    lock.take();
    lock.release();
    expect(lock.busy).toBe(false);
    expect(lock.take()).toBe(true);
  });

  test("the refusal is a sentence a person can act on", () => {
    expect(BUSY_MESSAGE).toContain("press START again");
  });

  test("a run still on the Macs keeps the lock, and only lets go once it settles", async () => {
    // The shape the server has: take the lock before the run, release it in
    // the finally after runShow has settled, and nowhere else. A page that
    // reloads in the middle drops the stream, not the run, so the next START
    // has to wait for the machines rather than start a second job on them.
    const lock = new RunLock();
    const { refs } = machines();
    const working = deferred();
    expect(lock.take()).toBe(true);

    const run = runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: refs,
      emit: () => {},
      schedule: () => () => {},
      runLane: async (lane) => {
        await working.promise;
        return blankOutcome("daily", lane, "never mind the number");
      },
    }).finally(() => lock.release());

    // Here is where the page went away. The Macs are still working.
    expect(lock.busy).toBe(true);
    expect(lock.take()).toBe(false);

    working.release();
    await run;
    expect(lock.busy).toBe(false);
    expect(lock.take()).toBe(true);
  });

  test("the stream being cancelled does not touch the lock", async () => {
    // The door itself cannot be imported: it loads the config and binds a port
    // the moment it is read. What is worth guarding is the one line that used
    // to be in cancel(), so the file is read and that line is looked for.
    const source = await Bun.file(new URL("../src/show/server.ts", import.meta.url)).text();
    // The run's own stream. The strip has a cancel() of its own further up,
    // which is allowed to do things; it is this one that must not free the
    // lock while the Macs are still working.
    const runRoute = source.indexOf('url.pathname === "/api/run"');
    expect(runRoute).toBeGreaterThan(-1);
    const at = source.indexOf("cancel() {", runRoute);
    expect(at).toBeGreaterThan(-1);
    // The run route is the last one in the file, so everything past its
    // cancel() is the cancel path and the boot message, neither of which owns
    // the lock.
    expect(source.slice(at)).not.toContain("lock.");
    expect(source).toContain("about: aboutFor(request)");
  });

  test("the strip's stream never touches the lock, so watching cannot block a run", async () => {
    const source = await Bun.file(new URL("../src/show/server.ts", import.meta.url)).text();
    const statsRoute = source.indexOf('url.pathname === "/api/stats"');
    const runRoute = source.indexOf('url.pathname === "/api/run"');
    expect(statsRoute).toBeGreaterThan(-1);
    expect(runRoute).toBeGreaterThan(statsRoute);
    expect(source.slice(statsRoute, runRoute)).not.toContain("lock");
  });
});

// ------------------------------------------------------------------ media

describe("which files may be served", () => {
  test("a picture this run made is served, as a picture", () => {
    const found = resolveShowMedia(`${STAMP}/m5-ultra-256gb.png`);
    expect(found?.path).toBe(showMediaPath(STAMP, "M5 Ultra 256GB", "png"));
    expect(found?.contentType).toBe("image/png");
  });

  test("a clip is served as a video", () => {
    expect(resolveShowMedia(`${STAMP}/lane.mp4`)?.contentType).toBe("video/mp4");
  });

  test("a path that climbs out of the run folder is refused", () => {
    expect(resolveShowMedia("../../etc/passwd")).toBeNull();
    expect(resolveShowMedia(`${STAMP}/../../../race.config.json`)).toBeNull();
  });

  test("a path written to climb out once it is decoded is refused", () => {
    expect(resolveShowMedia("%2e%2e%2f%2e%2e%2fbench.config.json")).toBeNull();
  });

  test("any other kind of file is refused even inside the folder", () => {
    expect(resolveShowMedia(`${STAMP}/notes.txt`)).toBeNull();
    expect(resolveShowMedia(`${STAMP}/lane`)).toBeNull();
    expect(resolveShowMedia("")).toBeNull();
  });

  test("the url the page is given and the file on disk are the same file", () => {
    const url = showMediaUrl(STAMP, "M3 Ultra 512GB", "png");
    expect(url).toBe(`/media/${STAMP}/m3-ultra-512gb.png`);
    expect(resolveShowMedia(url.slice("/media/".length))?.path).toBe(
      showMediaPath(STAMP, "M3 Ultra 512GB", "png"),
    );
    expect(showMediaPath(STAMP, "M3 Ultra 512GB", "png").startsWith(`${SHOW_RESULTS_ROOT}/`)).toBe(true);
  });
});

// ------------------------------------------------------------------ the port

describe("the port the page comes up on", () => {
  test("the config's showPort is used when it names one", () => {
    expect(showPortFrom({ showPort: 9900 })).toBe(9900);
  });

  test("anything that is not a port falls back rather than failing to start", () => {
    expect(showPortFrom({})).toBe(DEFAULT_SHOW_PORT);
    expect(showPortFrom({ showPort: "9900" })).toBe(DEFAULT_SHOW_PORT);
    expect(showPortFrom({ showPort: 0 })).toBe(DEFAULT_SHOW_PORT);
    expect(showPortFrom(null)).toBe(DEFAULT_SHOW_PORT);
  });
});

// ------------------------------------------------------------------ failures

describe("saying why a lane came back with nothing", () => {
  test("the sentence goes in the lane and the machine's own words go under it", () => {
    const split = splitFailure("it did not finish the job. This machine said:\nffmpeg: no such file\nexit 1");
    expect(split.reason).toBe("it did not finish the job. This machine said:");
    expect(split.lines).toEqual(["ffmpeg: no such file", "exit 1"]);
  });

  test("a one-line failure has no block under it", () => {
    expect(splitFailure("this machine is asleep and did not wake up.").lines).toEqual([]);
  });

  test("a failure with nothing in it still says something", () => {
    expect(splitFailure(null).reason).toBe("it did not say why.");
    expect(splitFailure("").reason).toBe("it did not say why.");
  });
});

// ------------------------------------------------------------------ verdicts

describe("the line under both lanes", () => {
  test("a picture run is worded by the picture race itself", () => {
    const outcomes: ShowOutcome[] = [
      { kind: "draw", laneId: "lane-0", mediaUrl: null, result: drawResult({ label: "A", drawSeconds: 2 }) },
      { kind: "draw", laneId: "lane-1", mediaUrl: null, result: drawResult({ label: "B", drawSeconds: 4 }) },
    ];
    expect(verdictFor(outcomes)).toBe(drawVerdictLine(outcomes.map((o) => (o as { result: DrawLaneResult }).result)));
    expect(verdictFor(outcomes)).toContain("A drew it 2.0x faster than B");
  });

  test("a clip run says made it, because that is the word clip.ts uses", () => {
    const outcomes: ShowOutcome[] = [
      { kind: "clip", laneId: "lane-0", mediaUrl: null, result: { label: "A", ok: true, seconds: 30, localPath: null, error: null } },
      { kind: "clip", laneId: "lane-1", mediaUrl: null, result: { label: "B", ok: true, seconds: 60, localPath: null, error: null } },
    ];
    expect(verdictFor(outcomes)).toContain("A made it 2.0x faster than B");
  });

  test("an everyday job says did it, because that is the word daily.ts uses", () => {
    const outcomes: ShowOutcome[] = [
      { kind: "daily", laneId: "lane-0", numberLabel: "x", result: { label: "A", ok: true, seconds: 10, words: null, answer: null, error: null } },
      { kind: "daily", laneId: "lane-1", numberLabel: "x", result: { label: "B", ok: true, seconds: 20, words: null, answer: null, error: null } },
    ];
    expect(verdictFor(outcomes)).toContain("A did it 2.0x faster than B");
  });

  test("one lane finishing is nothing to compare, so there is no line", () => {
    const outcomes: ShowOutcome[] = [
      { kind: "draw", laneId: "lane-0", mediaUrl: null, result: drawResult({ label: "A" }) },
      { kind: "draw", laneId: "lane-1", mediaUrl: null, result: drawResult({ label: "B", ok: false, drawSeconds: null, error: "asleep" }) },
    ];
    expect(verdictFor(outcomes)).toBeNull();
    expect(verdictFor([])).toBeNull();
  });
});

// ------------------------------------------------------------------ lane events

describe("what a finished lane puts on screen", () => {
  test("a picture shows the drawing seconds, the load beside them, and the picture", () => {
    const event = laneEvent({
      kind: "draw",
      laneId: "lane-0",
      mediaUrl: "/media/x/a.png",
      result: drawResult({ drawSeconds: 4.25, loadSeconds: 31.5 }),
    });
    expect(event.type).toBe("lane-done");
    if (event.type !== "lane-done") return;
    expect(event.seconds).toBe(4.25);
    expect(event.label).toBe("seconds to draw it");
    expect(event.extras).toEqual(["loaded the model in 31.5 s"]);
    expect(event.media).toEqual({ url: "/media/x/a.png", kind: "image", disclosure: null });
  });

  test("every clip carries the licence sentence, and no picture carries one", () => {
    // The camera frames one lane at a time, so the sentence the LTX-2 licence
    // requires travels with the clip rather than living in a page header that
    // may never be in shot.
    const clip = laneEvent({
      kind: "clip",
      laneId: "lane-0",
      mediaUrl: "/media/x/a.mp4",
      result: { label: "A", ok: true, seconds: 24.3, localPath: null, error: null },
    });
    if (clip.type !== "lane-done") throw new Error("expected a finished lane");
    expect(clip.media).toEqual({ url: "/media/x/a.mp4", kind: "video", disclosure: VIDEO_DISCLOSURE });

    const drawn = laneEvent({
      kind: "draw",
      laneId: "lane-0",
      mediaUrl: "/media/x/a.png",
      result: drawResult(),
    });
    if (drawn.type !== "lane-done") throw new Error("expected a finished lane");
    expect(drawn.media?.disclosure).toBeNull();
  });

  test("a clip says out loud that the load is inside the number", () => {
    const event = laneEvent({
      kind: "clip",
      laneId: "lane-0",
      mediaUrl: "/media/x/a.mp4",
      result: { label: "A", ok: true, seconds: 24.3, localPath: null, error: null },
    });
    if (event.type !== "lane-done") throw new Error("expected a finished lane");
    expect(event.label).toBe("seconds, load and generation together");
    expect(event.media?.kind).toBe("video");
  });

  test("an everyday job carries the job's own label, its word count and its answer", () => {
    const event = laneEvent({
      kind: "daily",
      laneId: "lane-0",
      numberLabel: DAILY_TESTS.transcribe.label,
      result: { label: "A", ok: true, seconds: 61.2, words: 2480, answer: ["talking head"], error: null },
    });
    if (event.type !== "lane-done") throw new Error("expected a finished lane");
    expect(event.label).toBe(DAILY_TESTS.transcribe.label);
    expect(event.extras).toEqual(["2,480 words transcribed"]);
    expect(event.answer).toEqual(["talking head"]);
  });

  test("a lane that failed says why, whatever kind of test it was", () => {
    const event = laneEvent(blankOutcome("draw", { laneId: "lane-1", label: "B" }, "this machine is asleep."));
    expect(event.type).toBe("lane-failed");
    if (event.type !== "lane-failed") return;
    expect(event.reason).toBe("this machine is asleep.");
  });
});

// ------------------------------------------------------------------ the run

describe("a run from START to the verdict", () => {
  test("the page is told what happened, in the order it needs to hear it", async () => {
    const { refs } = machines();
    const seen = recorder();

    await runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: async (lane) => ({
        kind: "daily",
        laneId: lane.laneId,
        numberLabel: DAILY_TESTS.hevc.label,
        result: {
          label: lane.label,
          ok: true,
          seconds: lane.laneId === "lane-0" ? 60 : 120,
          words: null,
          answer: null,
          error: null,
        },
      }),
    });

    const order = seen.events.map((e) => e.type);
    expect(order[0]).toBe("run-start");
    expect(order.filter((t) => t === "lane-start")).toHaveLength(2);
    expect(order.filter((t) => t === "lane-done")).toHaveLength(2);
    expect(order.at(-2)).toBe("verdict");
    expect(order.at(-1)).toBe("run-done");
    // Every lane starts before any of them finishes: they are working at once.
    expect(order.indexOf("lane-done")).toBeGreaterThan(order.lastIndexOf("lane-start"));

    const verdict = seen.events.find((e) => e.type === "verdict");
    expect(verdict && verdict.type === "verdict" ? verdict.line : null).toContain(
      "M3 Ultra 512GB did it 2.0x faster than M5 Ultra 256GB",
    );
  });

  test("the run-start line is the one the request picked, not the test's default", async () => {
    const { refs } = machines();
    const seen = recorder();
    const parsed = parseRunRequest({ test: "footage", model: "8b" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      about: aboutFor(parsed.request),
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: async (lane) => blankOutcome("daily", lane, "not run here"),
    });

    const start = seen.events[0];
    if (start?.type !== "run-start") throw new Error("expected the run to start");
    expect(start.about).toContain("Qwen3-VL 8B");
    expect(start.about).not.toContain("32B");
  });

  test("a test with nothing toggled is told about itself in its own words", async () => {
    const seen = recorder();
    await runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: machines().refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: async (lane) => blankOutcome("daily", lane, "not run here"),
    });

    const start = seen.events[0];
    if (start?.type !== "run-start") throw new Error("expected the run to start");
    expect(start.about).toBe(DAILY_TESTS.hevc.description);
  });

  test("one lane falling over never costs the other lane its number", async () => {
    const { refs } = machines();
    const seen = recorder();

    await runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: async (lane) =>
        lane.laneId === "lane-1"
          ? blankOutcome("daily", lane, "it did not finish the job. This machine said:\nffmpeg: not found")
          : {
              kind: "daily",
              laneId: lane.laneId,
              numberLabel: DAILY_TESTS.hevc.label,
              result: { label: lane.label, ok: true, seconds: 60, words: null, answer: null, error: null },
            },
    });

    const failed = seen.events.find((e) => e.type === "lane-failed");
    expect(failed && failed.type === "lane-failed" ? failed.laneId : null).toBe("lane-1");
    expect(failed && failed.type === "lane-failed" ? failed.lines : []).toEqual(["ffmpeg: not found"]);
    expect(seen.events.filter((e) => e.type === "lane-done")).toHaveLength(1);
    // One lane finished, so there is nothing to compare and no line is invented.
    const verdict = seen.events.find((e) => e.type === "verdict");
    expect(verdict && verdict.type === "verdict" ? verdict.line : "x").toBeNull();
    expect(seen.events.at(-1)?.type).toBe("run-done");
  });

  test("a runner that throws is one failed lane, not a run that stops", async () => {
    const { refs } = machines();
    const seen = recorder();

    await runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: async (lane) => {
        if (lane.laneId === "lane-0") throw new Error("ssh blew up");
        return {
          kind: "daily",
          laneId: lane.laneId,
          numberLabel: DAILY_TESTS.hevc.label,
          result: { label: lane.label, ok: true, seconds: 60, words: null, answer: null, error: null },
        };
      },
    });

    const failed = seen.events.find((e) => e.type === "lane-failed");
    expect(failed && failed.type === "lane-failed" ? failed.reason : "").toContain("ssh blew up");
    expect(seen.events.at(-1)?.type).toBe("run-done");
  });

  test("the clock ticks for a lane while it works and stops when it finishes", async () => {
    const { refs } = machines();
    const seen = recorder();
    /** The repeating job the run scheduled, fired by hand instead of by a timer. */
    const ticker: { fire: (() => void) | null } = { fire: null };
    let clock = 0;

    // Lane 0 finishes on the first release, lane 1 on the second.
    const first = deferred();
    const second = deferred();

    const run = runShow({
      runId: STAMP,
      test: testNamed("hevc"),
      lanes: refs,
      emit: seen.emit,
      now: () => clock,
      tickMs: 100,
      schedule: (fn) => {
        ticker.fire = fn;
        return () => {
          ticker.fire = null;
        };
      },
      runLane: async (lane) => {
        await (lane.laneId === "lane-0" ? first.promise : second.promise);
        return {
          kind: "daily",
          laneId: lane.laneId,
          numberLabel: DAILY_TESTS.hevc.label,
          result: { label: lane.label, ok: true, seconds: 1, words: null, answer: null, error: null },
        };
      },
    });

    await Promise.resolve();
    clock = 12_400;
    ticker.fire?.();
    const both = seen.events.find((e) => e.type === "tick");
    expect(both && both.type === "tick" ? both.lanes : []).toEqual([
      { laneId: "lane-0", elapsedSec: 12.4 },
      { laneId: "lane-1", elapsedSec: 12.4 },
    ]);

    first.release();
    await first.promise;
    await Promise.resolve();
    clock = 20_000;
    ticker.fire?.();
    const later = seen.events.filter((e) => e.type === "tick").at(-1);
    expect(later && later.type === "tick" ? later.lanes.map((l) => l.laneId) : []).toEqual(["lane-1"]);

    second.release();
    await run;
    // The ticker is stopped before the verdict, so no clock moves after the end.
    expect(ticker.fire).toBeNull();
  });
});

// ------------------------------------------------------------------ one lane

describe("how one lane does one test", () => {
  test("the picture test sends the picture race's own command and keeps the file with the run", async () => {
    const fake = new FakeMachine();
    fake.secondsByHost["one.local"] = 3;
    fake.secondsByHost["two.local"] = 6;
    const { refs, byId } = machines();
    const seen = recorder();

    const parsed = parseRunRequest({ test: "draw", prompt: "a fox reading in a library" }, showTests());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const outcomes = await runShow({
      runId: STAMP,
      test: parsed.request.test,
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "# shim",
        writeMedia: fake.writeMedia,
        run: fake.run,
        sendShim: fake.sendShim,
        fetchFile: fake.fetchFile,
      }),
    });

    const drawCommands = fake.commands.filter((c) => c.includes("mflux_bench.py"));
    expect(drawCommands).toHaveLength(2);
    expect(drawCommands[0]).toContain("'a fox reading in a library'");
    expect(drawCommands[0]).toContain("--seed '42'");

    // The picture lands with the rest of this run, under results/show.
    expect(fake.written.sort()).toEqual(
      [showMediaPath(STAMP, "M3 Ultra 512GB", "png"), showMediaPath(STAMP, "M5 Ultra 256GB", "png")].sort(),
    );

    const done = seen.events.filter((e) => e.type === "lane-done");
    expect(done).toHaveLength(2);
    const first = done[0];
    if (first?.type !== "lane-done") throw new Error("expected a finished lane");
    expect(first.media?.url).toBe(showMediaUrl(STAMP, "M3 Ultra 512GB", "png"));
    expect(first.seconds).toBe(3);

    const verdict = seen.events.find((e) => e.type === "verdict");
    expect(verdict && verdict.type === "verdict" ? verdict.line : null).toContain(
      "M3 Ultra 512GB drew it 2.0x faster than M5 Ultra 256GB",
    );
    expect(outcomes).toHaveLength(2);
  });

  test("a machine that falls over mid-draw loses its picture and nothing else", async () => {
    const fake = new FakeMachine();
    fake.failHosts.push("two.local");
    const { refs, byId } = machines();
    const seen = recorder();

    const parsed = parseRunRequest({ test: "draw", prompt: "a fox" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "# shim",
        writeMedia: fake.writeMedia,
        run: fake.run,
        sendShim: fake.sendShim,
        fetchFile: fake.fetchFile,
      }),
    });

    expect(fake.written).toEqual([showMediaPath(STAMP, "M3 Ultra 512GB", "png")]);
    const failed = seen.events.find((e) => e.type === "lane-failed");
    expect(failed && failed.type === "lane-failed" ? failed.reason : "").toContain("out of memory");
    expect(seen.events.filter((e) => e.type === "lane-done")).toHaveLength(1);
  });

  test("an everyday job sends the table's command, and never a picture's", async () => {
    const fake = new FakeMachine();
    const { refs, byId } = machines();
    const seen = recorder();

    const parsed = parseRunRequest({ test: "hevc" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "",
        writeMedia: fake.writeMedia,
        run: fake.run,
      }),
    });

    const sent = fake.commands.filter((c) => c !== "echo READY");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(DAILY_TESTS.hevc.command);
    expect(fake.written).toEqual([]);
  });

  test("a lane that has left the config is said plainly rather than crashing the run", async () => {
    const parsed = parseRunRequest({ test: "hevc" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    const runner = laneRunnerFor(parsed.request, STAMP, new Map(), {
      shimSource: "",
      writeMedia: async () => {},
      run: new FakeMachine().run,
    });
    const outcome = await runner({ laneId: "lane-9", label: "Gone" });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toContain("not in bench.config.json");
  });
});

// --------------------------------------------------- the clip's last picture

describe("a clip that starts on the picture the lane drew", () => {
  test("the toggle says which run this is, and from scratch is not one of them", () => {
    const fromPicture = parseRunRequest({ test: "clip", prompt: "a plane", model: CLIP_FROM_PICTURE }, showTests());
    if (!fromPicture.ok) throw new Error(fromPicture.message);
    expect(clipFromPicture(fromPicture.request)).toBe(true);
    expect(aboutFor(fromPicture.request)).toBe(CLIP_ABOUT_PICTURE);

    const scratch = parseRunRequest({ test: "clip", prompt: "a plane" }, showTests());
    if (!scratch.ok) throw new Error(scratch.message);
    expect(scratch.request.modelId).toBe(CLIP_FROM_SCRATCH);
    expect(clipFromPicture(scratch.request)).toBe(false);
    expect(aboutFor(scratch.request)).toBe(CLIP_ABOUT_SCRATCH);
  });

  test("a starting point nobody offered is refused, in the words of the row it came from", () => {
    const wrong = parseRunRequest({ test: "clip", prompt: "a plane", model: "yesterday" }, showTests());
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.message).toContain('I do not know the starting point "yesterday"');
      expect(wrong.message).toContain("It is one of: scratch, last.");
    }
  });

  test("only a finished picture run leaves a picture behind, and it is this run's file", () => {
    const pictures = picturesFrom(
      [
        {
          kind: "draw",
          laneId: "lane-0",
          mediaUrl: showMediaUrl(STAMP, "M3 Ultra 512GB", "png"),
          result: drawResult({ label: "M3 Ultra 512GB" }),
        },
        {
          kind: "draw",
          laneId: "lane-1",
          mediaUrl: null,
          result: drawResult({ label: "M5 Ultra 256GB", ok: false, drawSeconds: null, error: "asleep" }),
        },
      ],
      STAMP,
    );

    expect([...pictures.keys()]).toEqual(["lane-0"]);
    expect(pictures.get("lane-0")).toBe(showMediaPath(STAMP, "M3 Ultra 512GB", "png"));
  });

  test("a clip run leaves no picture behind, whatever it made", () => {
    const pictures = picturesFrom(
      [
        {
          kind: "clip",
          laneId: "lane-0",
          mediaUrl: showMediaUrl(STAMP, "M3 Ultra 512GB", "mp4"),
          result: { label: "M3 Ultra 512GB", ok: true, seconds: 24.3, localPath: null, error: null },
        },
      ],
      STAMP,
    );
    expect(pictures.size).toBe(0);
  });

  test("a lane with nothing drawn yet is named, before any machine is touched", () => {
    const { refs } = machines();
    const drawn = new Map([["lane-0", showMediaPath(STAMP, "M3 Ultra 512GB", "png")]]);

    expect(missingPictureMessage(refs, drawn)).toBe(
      "Draw a picture first; the M5 Ultra 256GB lane has none yet.",
    );
    expect(missingPictureMessage(refs, new Map())).toBe(
      "Draw a picture first; the M3 Ultra 512GB and M5 Ultra 256GB lanes have none yet.",
    );
    expect(
      missingPictureMessage(
        refs,
        new Map([
          ["lane-0", "a.png"],
          ["lane-1", "b.png"],
        ]),
      ),
    ).toBeNull();
  });

  test("each lane animates the picture IT drew, and the label says so", async () => {
    const fake = new FakeMachine();
    const { refs, byId } = machines();
    const seen = recorder();

    const first = showMediaPath(STAMP, "M3 Ultra 512GB", "png");
    const second = showMediaPath(STAMP, "M5 Ultra 256GB", "png");
    fake.onDisk.set(first, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]));
    fake.onDisk.set(second, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x02, 0x02]));

    const parsed = parseRunRequest(
      { test: "clip", prompt: "make it fly", model: CLIP_FROM_PICTURE },
      showTests(),
    );
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      about: aboutFor(parsed.request),
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "",
        writeMedia: fake.writeMedia,
        pictures: new Map([
          ["lane-0", first],
          ["lane-1", second],
        ]),
        run: fake.run,
        sendFile: fake.sendFile,
        readMedia: fake.readMedia,
        fetchFile: fake.fetchFile,
      }),
    });

    // Two different pictures, one per machine: the M3's own drawing went to
    // the M3 and the M5's to the M5.
    expect(fake.sent.map((s) => `${s.host}:${s.bytes}`).sort()).toEqual(["one.local:5", "two.local:6"]);
    expect(fake.sent.every((s) => s.path === `~/bench-clips/${STAMP}/start.png`)).toBe(true);

    const generate = fake.commands.filter((c) => c.includes("ltx-2-mlx generate"));
    expect(generate).toHaveLength(2);
    for (const command of generate) expect(command).toContain("--image");

    const done = seen.events.filter((e) => e.type === "lane-done");
    expect(done).toHaveLength(2);
    const one = done[0];
    if (one?.type !== "lane-done") throw new Error("expected a finished lane");
    expect(one.label).toBe("seconds, load and generation together, from the last picture");
    expect(one.media?.disclosure).toBe(VIDEO_DISCLOSURE);
  });

  test("a clip from scratch sends no picture and keeps the label it always had", async () => {
    const fake = new FakeMachine();
    const { refs, byId } = machines();
    const seen = recorder();

    const parsed = parseRunRequest({ test: "clip", prompt: "a paper plane" }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "",
        writeMedia: fake.writeMedia,
        run: fake.run,
        sendFile: fake.sendFile,
        fetchFile: fake.fetchFile,
      }),
    });

    expect(fake.sent).toEqual([]);
    expect(fake.commands.filter((c) => c.includes("--image"))).toEqual([]);
    const done = seen.events.find((e) => e.type === "lane-done");
    if (done?.type !== "lane-done") throw new Error("expected a finished lane");
    expect(done.label).toBe("seconds, load and generation together");
  });

  test("a lane whose picture has gone says so and costs the other lane nothing", async () => {
    const fake = new FakeMachine();
    const { refs, byId } = machines();
    const seen = recorder();
    const first = showMediaPath(STAMP, "M3 Ultra 512GB", "png");
    fake.onDisk.set(first, new Uint8Array([0x89, 0x50]));

    const parsed = parseRunRequest({ test: "clip", prompt: "fly", model: CLIP_FROM_PICTURE }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    await runShow({
      runId: STAMP,
      test: parsed.request.test,
      lanes: refs,
      emit: seen.emit,
      schedule: () => () => {},
      runLane: laneRunnerFor(parsed.request, STAMP, byId, {
        shimSource: "",
        writeMedia: fake.writeMedia,
        // The second lane's picture is named but no longer on the disk.
        pictures: new Map([
          ["lane-0", first],
          ["lane-1", showMediaPath(STAMP, "M5 Ultra 256GB", "png")],
        ]),
        run: fake.run,
        sendFile: fake.sendFile,
        readMedia: fake.readMedia,
        fetchFile: fake.fetchFile,
      }),
    });

    const failed = seen.events.find((e) => e.type === "lane-failed");
    if (failed?.type !== "lane-failed") throw new Error("expected a failed lane");
    expect(failed.laneId).toBe("lane-1");
    expect(failed.reason).toContain("could not be read");
    expect(seen.events.filter((e) => e.type === "lane-done")).toHaveLength(1);
    expect(fake.sent).toHaveLength(1);
  });

  test("a lane that has drawn nothing at all is refused in the same plain words", async () => {
    const { byId } = machines();
    const parsed = parseRunRequest({ test: "clip", prompt: "fly", model: CLIP_FROM_PICTURE }, showTests());
    if (!parsed.ok) throw new Error(parsed.message);

    const runner = laneRunnerFor(parsed.request, STAMP, byId, {
      shimSource: "",
      writeMedia: async () => {},
      run: new FakeMachine().run,
    });
    const outcome = await runner({ laneId: "lane-0", label: "M3 Ultra 512GB" });
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error).toBe("this lane has not drawn a picture yet.");
  });
});

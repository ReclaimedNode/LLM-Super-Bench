/**
 * `bun run daily <test>` -- the everyday-work version of the thing that happens
 * on camera.
 *
 * One ordinary job goes to every Mac at the same moment, each one does it, and
 * the seconds are printed side by side. This file does the talking and the
 * printing only: the parsing, the commands, the timings and the verdict all
 * live in daily.ts, where they can be tested without a Mac in the room.
 */

import { ConfigError, loadBenchConfig } from "./config.ts";
import {
  DailyError,
  dailyExitCode,
  dailyLanes,
  laneReport,
  parseDailyArgs,
  runDaily,
  testListLines,
  verdictLine,
} from "./daily.ts";

const HELP = `
  bun run daily <test> [options]

    --lane "<label>"      run on this lane only; repeat it for more than one
    --model <name>        footage: which vision model, 32b or 8b (default 32b)
                          transcribe: which Whisper model, one of large-v3,
                          turbo, medium, small, base, tiny (default large-v3)
    --file take|day       transcribe: which recording it reads -- the
                          13.8-minute take, or the whole shoot day at 2 h 5 min
                          (default take)
    --help                this

  The tests:

    hevc          Transcode a 13.8-minute 4K camera take to HEVC on the
                  hardware encoder.
    prores        Transcode the same take to ProRes 422 on the hardware
                  encoder.
    transcribe    Transcribe the take's audio (13.8 minutes) with Whisper
                  large-v3 on MLX. --model and --file move it to any of six
                  models and either recording.
    footage       Describe 60 seconds of raw, silent camera footage with a
                  local vision model (Qwen3-VL 32B, 4-bit, MLX) at 1 frame
                  per second, the way an automatic footage-ingest pass would.
    laya          Run Laya, an open decision model, on 300 labelled questions
                  (200 spam, 100 banking), and report accuracy and speed.

  These are everyday jobs -- a transcode, a transcription, a pass over some
  footage -- and the point is that they are the work that actually gets done
  here, not a benchmark nobody recognises. One job goes to every Mac in
  bench.config.json at the same moment, each machine times itself, and the
  seconds are printed with a line comparing them.

  footage and laya also print what the machine came back with, underneath its
  time: the description the vision model wrote, and Laya's own scoreboard. The
  seconds say which Mac was faster; those lines say whether it was right.

  Both Macs work at once, so these seconds are for the camera: each machine is
  working while the other one is.

  Nothing is copied first. Every machine already has the take at
  ~/bench-daily/take.mp4 with its audio beside it at ~/bench-daily/take.wav,
  the whole shoot day's audio at ~/bench-daily/day.wav, the minute of footage
  at ~/bench-daily/window60.mp4, and Laya's questions and script in
  ~/bench-daily/laya.

  Run bun run daily on its own to see the list of tests.
`;

async function main(): Promise<void> {
  const args = parseDailyArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  // Nobody named a job, so say what the jobs are rather than guessing at one.
  if (args.test === null) {
    console.log(`
  DAILY -- one everyday job, timed on every Mac at once.

  Tests:
`);
    for (const line of testListLines()) console.log(line);
    console.log(`
  Pick one: bun run daily hevc
`);
    return;
  }

  const loaded = await loadBenchConfig();
  const lanes = dailyLanes(loaded.config, args.lanes);

  console.log(`
  DAILY

    test       ${args.test.name}
    job        ${args.test.description}
    measuring  ${args.test.label}
    machines   ${lanes.map((l) => l.lane.label).join(", ")}

  All of them start now, so the seconds below are for the camera: each machine
  is working while the other one is.
`);

  const results = await runDaily({
    lanes,
    test: args.test,
    log: (label, message) => console.log(`  .. ${label}: ${message}`),
  });

  console.log("");
  for (const result of results) {
    for (const line of laneReport(result, args.test)) console.log(line);
    console.log("");
  }

  const verdict = verdictLine(results);
  if (verdict) console.log(`  ${verdict}\n`);

  const code = dailyExitCode(results);
  if (code !== 0) {
    const failed = results.filter((r) => !r.ok).map((r) => r.label);
    console.log(`  ${failed.join(" and ")} did not finish the job. The rest did.\n`);
    process.exit(code);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof DailyError || err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

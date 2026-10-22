/**
 * `bun run clip "<prompt>"` -- the moving-picture version of the thing that
 * happens on camera.
 *
 * One prompt goes to every Mac at the same moment, each one makes a single
 * short clip, the clips come back here and open on the screen, and the seconds
 * are printed side by side. This file does the talking and the printing only:
 * the parsing, the command, the names and the verdict all live in clip.ts,
 * where they can be tested without a Mac in the room.
 */

import { ConfigError, loadBenchConfig } from "./config.ts";
import {
  ClipError,
  clipExitCode,
  clipLanes,
  clipRunDir,
  clipSeconds,
  laneReport,
  loadStartImage,
  openArgs,
  parseClipArgs,
  runClip,
  verdictLine,
} from "./clip.ts";
import { defaultRunName } from "./store.ts";
import { VIDEO_DISCLOSURE } from "./video.ts";

const HELP = `
  bun run clip "<prompt>" [options]

    --size small|big      small is 512x256 for 2 seconds (default), big is
                          704x480 for 4 seconds and takes considerably longer
    --image <file>        start the clip from a picture on this Mac (.png or
                          .jpg): it is copied to every machine and becomes the
                          first frame
    --lane "<label>"      film on this lane only; repeat it for more than one
    --seed <number>       the seed every lane films with (default 42)
    --no-open             leave the clips on disk instead of opening them
    --help                this

  One prompt goes to every Mac in bench.config.json at the same moment. Each
  one makes a single clip with the LTX-2.5 weights it already has, the clips
  come back to results/clip and open here, and the seconds each machine took
  are printed with a line comparing them.

  With --image the same thing happens, except the picture goes out to every
  machine first and each clip starts on it. The picture can be any shape: the
  port resizes and centre crops it to the clip's own geometry.

  Both Macs render at once, so these seconds are a show, not a measurement:
  each machine is working while the other one is. The number also INCLUDES
  loading the model, because the port prints one time for the whole run and
  cannot split it. The honest number comes from \`bun run videobench\`, which
  uses one machine at a time and throws the first clip away.

  ${VIDEO_DISCLOSURE}
`;

async function main(): Promise<void> {
  const args = parseClipArgs(Bun.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  const loaded = await loadBenchConfig();
  const lanes = clipLanes(loaded.config, args.lanes);
  const stamp = defaultRunName();

  // Read before a single machine is touched, so a picture that is not there
  // costs nothing but the sentence saying so.
  const startImage = args.image === null ? null : await loadStartImage(args.image);

  console.log(`
  CLIP

    prompt     ${args.prompt}
    clip       ${args.size.width}x${args.size.height}, ${args.size.frames} frames, ${clipSeconds(args.size)} seconds at 24 fps
    seed       ${args.seed}${args.image === null ? "" : `
    picture    ${args.image}, which becomes the first frame`}
    machines   ${lanes.map((l) => l.lane.label).join(", ")}

  All of them start now, so the seconds below are for the camera, and they
  include loading the model. The honest one-at-a-time measurement is
  \`bun run videobench\`.
`);

  const results = await runClip({
    lanes,
    prompt: args.prompt,
    seed: args.seed,
    size: args.size,
    stamp,
    startImage,
    log: (label, message) => console.log(`  .. ${label}: ${message}`),
  });

  console.log("");
  for (const result of results) {
    for (const line of laneReport(result)) console.log(line);
    console.log("");
  }

  const verdict = verdictLine(results);
  if (verdict) console.log(`  ${verdict}\n`);

  console.log(`  ${VIDEO_DISCLOSURE}\n`);

  const clips = results.map((r) => r.localPath).filter((p): p is string => p !== null);
  if (args.open && clips.length > 0) {
    // Waited on, because the failure path below exits at once and `open` has
    // to have handed the clips to the window server before that happens.
    await Bun.spawn(openArgs(clips), { stdout: "ignore", stderr: "ignore" }).exited;
  }
  if (clips.length > 0) console.log(`  Clips in ${clipRunDir(stamp)}\n`);

  const code = clipExitCode(results);
  if (code !== 0) {
    const failed = results.filter((r) => !r.ok).map((r) => r.label);
    console.log(`  ${failed.join(" and ")} did not make a clip. The rest did.\n`);
    process.exit(code);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof ClipError || err instanceof ConfigError ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

/**
 * `bun run show` -- the one screen the tests are filmed on.
 *
 * Instead of watching a terminal scroll, the camera watches this: two lanes
 * side by side, a row of buttons for every test this repo can run, a START,
 * and a clock in each lane that moves while the Macs work. When a test
 * finishes, the seconds land in the lane along with whatever the machine made
 * -- the picture, the clip, the words it transcribed, what the vision model
 * saw -- and one sentence under both lanes says which Mac won.
 *
 * This file is the door and nothing else: routes, the event stream, and the
 * boot message. Everything worth proving -- which tests exist, what a request
 * is allowed to ask for, what a run does and in what order, which files may be
 * served -- lives in run.ts, where it is tested against a fake machine.
 *
 * Every asset is local: no CDN, no web font, no analytics. The only outbound
 * calls this process makes are ssh connections to the machines in
 * `bench.config.json`: the ones the tests make after somebody presses START,
 * and one per lane for the live strip, which runs for as long as a page is
 * open and is killed when the last one closes.
 */

import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { PROJECT_ROOT } from "../config.ts";
import { BENCH_CONFIG_PATH, BENCH_EXAMPLE_CONFIG_PATH, loadBenchConfig } from "../bench/config.ts";
import { defaultRunName } from "../bench/store.ts";
import type { BenchLane, SshTarget } from "../bench/types.ts";
import {
  BUSY_MESSAGE,
  RunLock,
  SHOW_RESULTS_ROOT,
  aboutFor,
  clipFromPicture,
  laneRunnerFor,
  missingPictureMessage,
  parseRunRequest,
  picturesFrom,
  resolveShowMedia,
  runShow,
  showPortFrom,
  showTests,
} from "./run.ts";
import type { ShowEvent, ShowMachine } from "./run.ts";
import { StatsHub, startMacmon } from "./stats.ts";
import type { StatsEvent } from "./stats.ts";

const PUBLIC_DIR = resolve(PROJECT_ROOT, "public/show");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/show.js": { file: "show.js", type: "text/javascript; charset=utf-8" },
  "/show.css": { file: "show.css", type: "text/css; charset=utf-8" },
};

/**
 * The lane colours, in lane order, the same four the race page uses: NC
 * Orange, Light Cyan, Olive Yellow, Gold. They are sent down with the lanes so
 * the page never has to guess which lane is which colour.
 */
const LANE_COLORS = ["#f1a21a", "#c0dcdf", "#c2ba51", "#ca9f43"];

const loaded = await loadBenchConfig();
const config = loaded.config;

// The port is read off the raw file, because the validated config only carries
// the keys the benchmark itself uses.
const rawConfig = await Bun.file(loaded.usedExample ? BENCH_EXAMPLE_CONFIG_PATH : BENCH_CONFIG_PATH)
  .json()
  .catch(() => null);
const port = showPortFrom(rawConfig);

/** Every lane there is a way in to. A lane with no `ssh` block cannot be driven. */
const machines: ShowMachine[] = config.lanes
  .filter((lane): lane is BenchLane & { ssh: SshTarget } => lane.ssh !== undefined)
  .map((lane, index) => ({
    laneId: `lane-${index}`,
    label: lane.label,
    lane,
    target: lane.ssh,
  }));

const machineById = new Map(machines.map((m) => [m.laneId, m]));
const tests = showTests();
const lock = new RunLock();

/**
 * The live strip under each lane. One macmon per machine while a page is
 * open, none when no page is. It is deliberately nothing to do with the run
 * lock: the strip keeps moving while a test runs, which is the whole reason
 * it is there.
 */
const stats = new StatsHub(
  machines.map((m) => ({ laneId: m.laneId, label: m.label })),
  (lane, handlers) => startMacmon(machineById.get(lane.laneId)!.target, handlers),
  (message) => console.log(`  ${message}`),
);

/**
 * The last picture each lane drew, for as long as this process is up.
 *
 * What the clip's FROM LAST PICTURE toggle animates. Kept in memory rather
 * than found on disk, because "the picture this lane drew today, in this
 * session" is the thing the run on camera is about, and a folder full of
 * older runs cannot say which of them that is.
 */
const lastPictures = new Map<string, string>();

const NO_LANES =
  "No lane in bench.config.json has an `ssh` block, so there is no machine to run this on.";

async function writeMedia(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await Bun.write(path, bytes);
}

function sse(event: ShowEvent | StatsEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
};

const server = Bun.serve({
  port,
  // Seconds. A transcode of a fourteen-minute take outlives the default many
  // times over, and the stream is what the page is watching.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    const stat = STATIC_FILES[url.pathname];
    if (stat && req.method === "GET") {
      const file = Bun.file(resolve(PUBLIC_DIR, stat.file));
      if (!(await file.exists())) return new Response("missing asset", { status: 500 });
      return new Response(file, {
        headers: { "Content-Type": stat.type, "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      return Response.json({
        // Hostnames are deliberately absent: this page gets filmed.
        lanes: machines.map((m, index) => ({
          laneId: m.laneId,
          label: m.label,
          color: LANE_COLORS[index % LANE_COLORS.length],
        })),
        tests,
        usingExampleConfig: loaded.usedExample,
        laneError: machines.length === 0 ? NO_LANES : null,
      });
    }

    // The pictures and clips the tests made, out of this run folder only. The
    // path is checked rather than trusted, so a crafted name cannot read
    // anything else on the disk.
    if (url.pathname.startsWith("/media/") && req.method === "GET") {
      const found = resolveShowMedia(url.pathname.slice("/media/".length));
      if (found === null) return new Response("not found", { status: 404 });
      const file = Bun.file(found.path);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, {
        headers: { "Content-Type": found.contentType, "Cache-Control": "no-store" },
      });
    }

    // The strip under every lane. A second stream, entirely separate from a
    // run: it takes no lock, and opening or closing it cannot touch one.
    if (url.pathname === "/api/stats" && req.method === "GET") {
      let leave: () => void = () => {};
      let open = true;

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          leave = stats.subscribe((event) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(sse(event)));
            } catch {
              open = false;
            }
          });
          // Belt and braces with cancel() below: whichever of the two fires
          // first lets the hub know, and leaving twice is harmless.
          req.signal.addEventListener("abort", () => {
            open = false;
            leave();
          });
        },
        cancel() {
          open = false;
          leave();
        },
      });

      return new Response(stream, { headers: STREAM_HEADERS });
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      // Taken before the body is read, so a second START that arrives while
      // the first one is still being parsed is refused rather than run.
      if (!lock.take()) return Response.json({ error: BUSY_MESSAGE }, { status: 409 });

      const body = await req.json().catch(() => null);
      const parsed = parseRunRequest(body, tests);
      if (!parsed.ok) {
        lock.release();
        return Response.json({ error: parsed.message }, { status: 400 });
      }
      if (machines.length === 0) {
        lock.release();
        return Response.json({ error: NO_LANES }, { status: 400 });
      }

      const request = parsed.request;

      // A clip that starts from a picture needs one on EVERY lane, and is
      // refused here rather than half-run: two lanes doing different tests is
      // the one thing this page must not put on camera.
      if (clipFromPicture(request)) {
        const missing = missingPictureMessage(
          machines.map((m) => ({ laneId: m.laneId, label: m.label })),
          lastPictures,
        );
        if (missing !== null) {
          lock.release();
          return Response.json({ error: missing }, { status: 400 });
        }
      }

      const stamp = defaultRunName();
      const shimSource =
        request.test.kind === "draw"
          ? await Bun.file(resolve(PROJECT_ROOT, "remote/mflux_bench.py")).text()
          : "";

      // Out here rather than inside start(), so cancel() can stop the stream
      // being written to without reaching into the run itself.
      let open = true;

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const emit = (event: ShowEvent) => {
            if (!open) return;
            try {
              controller.enqueue(encoder.encode(sse(event)));
            } catch {
              open = false;
            }
          };

          try {
            const outcomes = await runShow({
              runId: stamp,
              test: request.test,
              about: aboutFor(request),
              lanes: machines.map((m) => ({ laneId: m.laneId, label: m.label })),
              runLane: laneRunnerFor(request, stamp, machineById, {
                shimSource,
                writeMedia,
                pictures: lastPictures,
              }),
              emit,
            });
            // Whatever this run drew is what the next clip can start from.
            for (const [laneId, picture] of picturesFrom(outcomes, stamp)) lastPictures.set(laneId, picture);
          } catch (err) {
            emit({
              type: "lane-failed",
              laneId: "run",
              reason: `the run stopped: ${err instanceof Error ? err.message : String(err)}`,
              lines: [],
            });
            emit({ type: "run-done", runId: stamp });
          } finally {
            // The one place the lock is let go, and only once runShow has
            // settled -- which is the moment the Macs are actually free.
            lock.release();
            open = false;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        },
        cancel() {
          // The page went away mid-run: a reload, a closed tab. Nothing more
          // is written to a stream nobody is reading, but the machines are
          // still working, so the lock stays held. Releasing it here was how a
          // reload could start a second run on top of the first one, and the
          // first run's own release would then free the lock underneath it.
          // The reloaded page gets the busy message until the Macs are done,
          // which is the truth.
          open = false;
        },
      });

      return new Response(stream, { headers: STREAM_HEADERS });
    }

    return new Response("not found", { status: 404 });
  },
});

/**
 * Nothing of ours outlives this process.
 *
 * The strip's macmon runs inside an ssh child of this process, and a page left
 * open holds one per lane. Killing the server without killing those would
 * leave a reader running on both Macs with nothing reading it.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stats.stop();
    server.stop(true);
    process.exit(0);
  });
}

const laneLines =
  machines.length === 0 ? `    none -- ${NO_LANES}` : machines.map((m) => `    ${m.label}`).join("\n");

console.log(`
  TESTS

    http://localhost:${server.port}

  Lanes (${machines.length}):
${laneLines}

  Tests:  ${tests.map((t) => t.id).join(", ")}
  Strip:  macmon on every lane, while a page is open
  Config: ${loaded.path}${loaded.usedExample ? "  (no bench.config.json yet -- using the example, which has no machines in it)" : ""}
  Media:  ${SHOW_RESULTS_ROOT}
`);

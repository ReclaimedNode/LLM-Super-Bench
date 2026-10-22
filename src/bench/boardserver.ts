/**
 * `bun run board [run-name]` -- serve the results board for a finished run.
 *
 *   bun run board              # the newest run
 *   bun run board my-run   # a named one
 *   bun run board --list
 *
 * Reads only. It never touches a result, so it can be left running while a
 * grid is still going and refreshed to watch the board fill in.
 */

import { resolve } from "node:path";
import { PROJECT_ROOT } from "../config.ts";
import { buildBoard } from "./board.ts";
import { loadBenchConfig } from "./config.ts";
import type { ImageCellStat } from "./image.ts";
import { IMAGE_CELLS_FILE, readImageRuns } from "./imagerunner.ts";
import type { VideoCellStat } from "./video.ts";
import { VIDEO_CELLS_FILE, readVideoRuns } from "./videocli.ts";
import { latestRun, listRuns, readCells, readEngine, readManifest, readPower, runDir } from "./store.ts";

const PUBLIC_DIR = resolve(PROJECT_ROOT, "public/bench");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "board.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "board.html", type: "text/html; charset=utf-8" },
  "/board.js": { file: "board.js", type: "text/javascript; charset=utf-8" },
  "/labels.js": { file: "labels.js", type: "text/javascript; charset=utf-8" },
  "/board.css": { file: "board.css", type: "text/css; charset=utf-8" },
  "/bench.css": { file: "bench.css", type: "text/css; charset=utf-8" },
};

async function readImageCells(runName: string): Promise<ImageCellStat[]> {
  const file = Bun.file(resolve(runDir(runName), IMAGE_CELLS_FILE));
  if (!(await file.exists())) return [];
  try {
    return (await file.json()) as ImageCellStat[];
  } catch {
    return [];
  }
}

/** The settings the images were made with, read off the first run's record. */
async function readImageSettings(runName: string) {
  const runs = await readImageRuns(runName);
  const first = runs[0];
  if (!first) return null;
  return { prompt: first.prompt, seed: first.seed, width: first.width, height: first.height, steps: first.steps };
}

async function boardFor(runName: string) {
  const manifest = await readManifest(runName);
  if (manifest === null) return null;
  return buildBoard({
    manifest,
    cells: (await readCells(runName)) ?? [],
    engine: (await readEngine(runName)) ?? [],
    power: (await readPower(runName)) ?? [],
    images: await readImageCells(runName),
    imageSettings: await readImageSettings(runName),
    video: await readVideoCells(runName),
    videoSettings: await readVideoSettings(runName),
  });
}

async function readVideoCells(runName: string): Promise<VideoCellStat[]> {
  const file = Bun.file(resolve(runDir(runName), VIDEO_CELLS_FILE));
  if (!(await file.exists())) return [];
  try {
    return (await file.json()) as VideoCellStat[];
  } catch {
    return [];
  }
}

async function readVideoSettings(runName: string) {
  const first = (await readVideoRuns(runName))[0];
  if (!first) return null;
  return { width: first.width, height: first.height, frames: first.frames, seed: first.seed };
}

const argv = Bun.argv.slice(2);

if (argv.includes("--list")) {
  const runs = await listRuns();
  console.log(runs.length === 0 ? "\n  No runs yet. Run `bun run bench`.\n" : `\n  ${runs.join("\n  ")}\n`);
  process.exit(0);
}

const named = argv.find((a) => !a.startsWith("--")) ?? null;
const runName = named ?? (await latestRun());

if (runName === null) {
  console.error("\n  No runs in results/bench yet. Run `bun run bench` first.\n");
  process.exit(1);
}
if ((await readManifest(runName)) === null) {
  const runs = await listRuns();
  console.error(
    `\n  No run called "${runName}" in results/bench.` +
      (runs.length > 0 ? `\n  There is: ${runs.slice(0, 10).join(", ")}\n` : "\n"),
  );
  process.exit(1);
}

const { config } = await loadBenchConfig().catch(() => ({ config: { boardPort: 9700 } }));

const server = Bun.serve({
  port: config.boardPort,
  async fetch(req) {
    const url = new URL(req.url);

    const stat = STATIC_FILES[url.pathname];
    if (stat && req.method === "GET") {
      return new Response(Bun.file(resolve(PUBLIC_DIR, stat.file)), {
        headers: { "Content-Type": stat.type, "Cache-Control": "no-store" },
      });
    }

    // Re-read on every request, so refreshing the page during a grid shows the
    // cells that have landed since.
    if (url.pathname === "/api/board" && req.method === "GET") {
      const data = await boardFor(runName);
      if (data === null) return Response.json({ error: `run "${runName}" has no manifest` }, { status: 404 });
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    }

    // The pictures and clips this run made, served out of its own folder. The
    // path is checked against that folder rather than trusted, so a crafted
    // name cannot read anything else on the disk.
    for (const [prefix, folder, type] of [
      ["/run-image/", "images", "image/png"],
      ["/run-clip/", "clips", "video/mp4"],
    ] as const) {
      if (!url.pathname.startsWith(prefix) || req.method !== "GET") continue;
      const wanted = resolve(runDir(runName), decodeURIComponent(url.pathname.slice(prefix.length)));
      const root = resolve(runDir(runName), folder);
      if (!wanted.startsWith(root + "/")) return new Response("not found", { status: 404 });
      const file = Bun.file(wanted);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`
  RESULTS BOARD

    http://localhost:${server.port}

  Run:     ${runName}
  Results: ${runDir(runName)}
`);

/**
 * The one local server. Serves the page from disk and streams a race to it.
 *
 * Every asset is local: no CDN, no web font, no analytics, no telemetry. The
 * only outbound calls this process ever makes are to the lane URLs in the
 * config.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CONFIG_PATH, EXAMPLE_CONFIG_PATH, PROJECT_ROOT, loadConfig, loadPromptSource } from "./config.ts";
import { readLanesState, withServedModels } from "./lanes.ts";
import { PRESETS, PRESET_IDS, targetCharsFor } from "./prompt.ts";
import { passwordOk } from "./auth.ts";
import { MAX_REQUEST_BYTES, makeThrottle, sameOriginOk, withSecurityHeaders } from "./guard.ts";
import { applyEdit, checkMachine, parseEditedLanes } from "./editor.ts";
import { differences, probeDetails, setupOf } from "./details.ts";
import type { MachineSetup } from "./details.ts";
import { UNKNOWN_CAPACITY, presetFit, probeCapacity, streamLimit } from "./capacity.ts";
import type { LaneCapacity } from "./capacity.ts";
import { runRace } from "./race.ts";
import { parseRaceRequest } from "./request.ts";
import { concurrencyOptions } from "./streams.ts";
import { REPLY_LENGTHS, applySettings, parseSettings } from "./settings.ts";
import { buildRunFile, hasFinishedRun, raceRows } from "./runfile.ts";
import type { RunFile } from "./runfile.ts";
import { parseSweepRequest, runSweep } from "./sweep.ts";
import type { SweepEvent } from "./sweep.ts";
import type { RaceEvent } from "./types.ts";

const PUBLIC_DIR = resolve(PROJECT_ROOT, "public");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/results.html": { file: "results.html", type: "text/html; charset=utf-8" },
  "/results.js": { file: "results.js", type: "text/javascript; charset=utf-8" },
  "/charts.js": { file: "charts.js", type: "text/javascript; charset=utf-8" },
  "/results.css": { file: "results.css", type: "text/css; charset=utf-8" },
};

const loaded = await loadConfig();
// The machines can be changed from the page, so these are read at each request
// and never captured: `config` and `laneIds` are replaced when a change is saved.
let config = loaded.config;
let usedExample = loaded.usedExample;
const maxConcurrency = config.maxConcurrency ?? 16;
let laneIds = config.lanes.map((_, i) => `lane-${i}`);

// Read the prompt source once at boot so a race never waits on disk.
let sourceText = "";
let sourceError: string | null = null;
try {
  sourceText = await loadPromptSource(config);
} catch (err) {
  sourceError = err instanceof Error ? err.message : String(err);
}

function sse(event: RaceEvent | SweepEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

let raceInFlight = false;
/** Aborted by STOP. Only set while a race or sweep is running. */
let currentRun: AbortController | null = null;

/**
 * Optional password for the whole page, from RACE_PASSWORD (or `password` in the
 * config). The page has no accounts: with this set the browser asks once, for any
 * user name and this password. It is a lock on a shared LAN, not a substitute
 * for keeping the port off the internet.
 */
const password = (process.env.RACE_PASSWORD ?? config.password ?? "").trim();

/**
 * Runs one job that talks to the page over an event stream, and holds the one
 * race lock for as long as it runs. `isOpen` turns false when the page goes away.
 */
function eventStream(
  job: (emit: (e: RaceEvent | SweepEvent) => void, isOpen: () => boolean, signal: AbortSignal) => Promise<void>,
): Response {
  raceInFlight = true;
  // Named apart from the stream's own `controller` below, which would shadow it.
  const stopper = new AbortController();
  currentRun = stopper;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let open = true;
      const emit = (event: RaceEvent | SweepEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sse(event)));
        } catch {
          open = false;
        }
      };
      try {
        await job(emit, () => open, stopper.signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: "lane-error", laneId: "race", message, elapsedSec: 0 });
      } finally {
        raceInFlight = false;
        if (currentRun === stopper) currentRun = null;
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      // The page went away. The job notices through isOpen and stops between races.
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
  });
}

/** Each machine's slots and reported setup, asked now, for the lanes that will run. */
async function setupFor(
  raceConfig: typeof config,
  ids: string[],
): Promise<{ slots: Record<string, number | null>; setups: Record<string, MachineSetup> }> {
  const picked = raceConfig.lanes
    .map((lane, i) => ({ laneId: `lane-${i}`, lane }))
    .filter(({ laneId }) => ids.includes(laneId));
  const found = await Promise.all(picked.map(({ lane, laneId }) => probeDetails(lane, laneId)));
  const slots: Record<string, number | null> = {};
  const setups: Record<string, MachineSetup> = {};
  found.forEach((d) => {
    slots[d.laneId] = d.slots;
    setups[d.laneId] = setupOf(d);
  });
  return { slots, setups };
}

/** The latest finished race or sweep, for the results page. Also saved to results/ as it finishes. */
let lastRun: RunFile | null = null;

async function keepRun(file: RunFile): Promise<void> {
  if (!hasFinishedRun(file)) return;
  lastRun = file;
  try {
    const stamp = file.createdAt.replace(/[:.]/g, "-");
    await mkdir(resolve(PROJECT_ROOT, "results"), { recursive: true });
    await writeFile(resolve(PROJECT_ROOT, `results/run-${file.kind}-${stamp}.json`), JSON.stringify(file, null, 2) + "\n");
  } catch {
    /* the page still has it in memory */
  }
}

const throttle = makeThrottle();

const server = Bun.serve({
  port: config.port,
  idleTimeout: 255, // seconds; a 32K race on slow hardware outlives the default
  maxRequestBodySize: MAX_REQUEST_BYTES,
  async fetch(req, srv) {
    return withSecurityHeaders(await handle(req, srv.requestIP(req)?.address ?? "unknown"));
  },
});

async function handle(req: Request, client: string): Promise<Response> {
  {
    const url = new URL(req.url);

    // Another website must not be able to act through the visitor's saved password.
    if (!sameOriginOk(req.method, req.headers)) {
      return Response.json({ error: "This request came from another site, so it was refused." }, { status: 403 });
    }

    const wait = throttle.waitSec(client);
    if (wait > 0) {
      return new Response(`Too many wrong passwords. Try again in ${wait} seconds.`, { status: 429, headers: { "Retry-After": String(wait) } });
    }
    if (!passwordOk(req.headers.get("authorization"), password)) {
      // Asking for the password (no header yet) is normal; only a wrong one counts.
      if (req.headers.get("authorization")) throttle.failed(client);
      return new Response("This page needs the password.", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="LLM-Super-Bench", charset="UTF-8"' },
      });
    }
    if (password !== "") throttle.passed(client);

    const stat = STATIC_FILES[url.pathname];
    if (stat && req.method === "GET") {
      const file = Bun.file(resolve(PUBLIC_DIR, stat.file));
      if (!(await file.exists())) return new Response("missing asset", { status: 500 });
      return new Response(file, {
        headers: { "Content-Type": stat.type, "Cache-Control": "no-store" },
      });
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      // Read on every load rather than once at boot, because that is what makes
      // `lanes down`, `lanes up --model 14b`, reload change the lane headers
      // with this server left running the whole time.
      const served = withServedModels(config, await readLanesState());
      return Response.json({
        // Base URLs are deliberately absent: they are hostnames, and this page
        // gets filmed.
        lanes: served.lanes.map((l, i) => ({
          laneId: `lane-${i}`,
          label: l.label,
          displayModel: l.displayModel ?? l.model,
        })),
        presets: PRESET_IDS.map((id) => ({
          id,
          label: PRESETS[id].label,
          targetTokens: PRESETS[id].targetTokens,
          targetChars: targetCharsFor(id, config.charsPerToken),
        })),
        // The streams-per-machine buttons. 1 is an ordinary race.
        concurrencyOptions: concurrencyOptions(maxConcurrency),
        maxTokens: config.maxTokens,
        thinking: config.thinking ?? "auto",
        replyLengths: REPLY_LENGTHS,
        charsPerToken: config.charsPerToken,
        promptFile: config.promptFile,
        usingExampleConfig: usedExample,
        // Changing machines from the page needs the password, because it lets the
        // page make this server ask any address on the network.
        editable: password !== "",
        sourceError,
      });
    }

    // Asked of the machines themselves, every time, because the server on the
    // other end can be restarted with a different slot count between races.
    // `?lanes=lane-0,lane-1` is the set that would race together.
    if (url.pathname === "/api/capacity" && req.method === "GET") {
      const asked = url.searchParams.get("lanes");
      const wanted = asked === null || asked === "" ? laneIds : asked.split(",").map((s) => s.trim());
      const unknown = wanted.filter((id) => !laneIds.includes(id));
      if (unknown.length > 0) {
        return Response.json({ error: `Unknown machine: ${unknown.map((u) => JSON.stringify(u)).join(", ")}.` }, { status: 400 });
      }
      const picked = config.lanes
        .map((lane, i) => ({ laneId: `lane-${i}`, lane }))
        .filter(({ laneId }) => wanted.includes(laneId));
      const found = await Promise.all(picked.map(({ lane }) => probeCapacity(lane)));
      return Response.json({
        // Base URLs stay out of it, like everywhere else the browser looks.
        lanes: picked.map(({ laneId, lane }, i) => ({
          laneId,
          label: lane.label,
          slots: found[i]!.slots,
          contextTokens: found[i]!.contextTokens,
          source: found[i]!.source,
        })),
        selection: streamLimit(found, maxConcurrency),
        // Prompt sizes a machine's reported context looks too small for.
        presetFit: presetFit(
          picked.map(({ lane }, i) => ({ label: lane.label, contextTokens: found[i]!.contextTokens })),
          PRESET_IDS.map((id) => ({ id, targetTokens: PRESETS[id].targetTokens })),
          config.maxTokens,
        ),
      });
    }

    // STOP: cuts off every request in the race or sweep that is running. The
    // machines see their connections close and stop generating.
    if (url.pathname === "/api/stop" && req.method === "POST") {
      if (!currentRun || currentRun.signal.aborted) {
        return Response.json({ error: "Nothing is running." }, { status: 409 });
      }
      currentRun.abort();
      return Response.json({ ok: true });
    }

    // ---- reply length and thinking, for every machine (needs the password)
    if (url.pathname === "/api/settings" && req.method === "POST") {
      if (password === "") {
        return Response.json(
          { error: "Changing settings from the page needs a password. Start the server with RACE_PASSWORD=... and reload." },
          { status: 403 },
        );
      }
      if (raceInFlight) {
        return Response.json({ error: "A race is running. Change this after it finishes." }, { status: 409 });
      }
      const parsed = parseSettings(await req.json().catch(() => ({})));
      if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
      // On the built-in example config nothing is written, so a settings click cannot create a config of mock machines.
      const result = await applySettings({ config, change: parsed.change, writePath: usedExample ? undefined : CONFIG_PATH });
      if (!result.ok) return Response.json({ error: result.error }, { status: 400 });
      config = result.config;
      return Response.json({ ok: true, maxTokens: config.maxTokens, thinking: config.thinking ?? "auto", saved: !usedExample });
    }

    // ---- changing which machines are tested (needs the password)
    if (url.pathname.startsWith("/api/lanes")) {
      if (password === "") {
        return Response.json(
          { error: "Changing machines from the page needs a password, because it lets the page make this server ask any address. Start the server with RACE_PASSWORD=... and reload." },
          { status: 403 },
        );
      }

      if (url.pathname === "/api/lanes-config" && req.method === "GET") {
        return Response.json({
          lanes: config.lanes.map((l) => ({ label: l.label, baseUrl: l.baseUrl, notes: l.notes ?? "", engine: l.engine ?? "", slots: l.slots ?? null })),
          minMachines: 1,
          maxMachines: 4,
        });
      }

      if (url.pathname === "/api/lanes/check" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { baseUrl?: unknown };
        return Response.json(await checkMachine(body.baseUrl));
      }

      if (url.pathname === "/api/lanes/save" && req.method === "POST") {
        if (raceInFlight) {
          return Response.json({ error: "A race is running. Save after it finishes." }, { status: 409 });
        }
        const parsed = parseEditedLanes(await req.json().catch(() => ({})));
        if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

        // Held while the machines are asked, so a race cannot start on half a change.
        raceInFlight = true;
        try {
          const result = await applyEdit({ config, edited: parsed.lanes, writePath: CONFIG_PATH });
          if (!result.ok) return Response.json({ error: result.problems.join(" ") , problems: result.problems }, { status: 400 });
          config = result.config;
          laneIds = config.lanes.map((_, i) => `lane-${i}`);
          usedExample = false;
          return Response.json({ ok: true, lanes: config.lanes.length });
        } finally {
          raceInFlight = false;
        }
      }
    }

    // The latest finished race or sweep, as the file the results page draws and people can share.
    if (url.pathname === "/api/last-run" && req.method === "GET") {
      if (!lastRun) return Response.json({ error: "Nothing has finished yet. Run a race or a sweep first." }, { status: 404 });
      return Response.json(lastRun, { headers: { "Cache-Control": "no-store" } });
    }

    // What each machine says about itself, and where two machines are set up differently.
    if (url.pathname === "/api/machines" && req.method === "GET") {
      const asked = url.searchParams.get("lanes");
      const wanted = asked === null || asked === "" ? laneIds : asked.split(",").map((s) => s.trim());
      const unknown = wanted.filter((id) => !laneIds.includes(id));
      if (unknown.length > 0) {
        return Response.json({ error: `Unknown machine: ${unknown.map((u) => JSON.stringify(u)).join(", ")}.` }, { status: 400 });
      }
      const served = withServedModels(config, await readLanesState());
      const picked = served.lanes
        .map((lane, i) => ({ laneId: `lane-${i}`, lane }))
        .filter(({ laneId }) => wanted.includes(laneId));
      const machines = await Promise.all(picked.map(({ lane, laneId }) => probeDetails(lane, laneId)));
      return Response.json({ machines, differences: differences(machines) });
    }

    if (url.pathname === "/api/race" && req.method === "POST") {
      if (raceInFlight) {
        return Response.json({ error: "A race is already running." }, { status: 409 });
      }
      const parsed = parseRaceRequest(await req.json().catch(() => ({})), { laneIds, maxConcurrency });
      if (!parsed.ok) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }
      const { preset, laneIds: racingLaneIds, concurrency } = parsed.request;
      if (preset !== "short" && sourceError) {
        return Response.json({ error: sourceError }, { status: 400 });
      }

      // Taken before the first await below, so two clicks cannot both get past
      // the check above while this one is still asking the machines.
      raceInFlight = true;
      let raceConfig: typeof config;
      let asked: Awaited<ReturnType<typeof setupFor>>;
      try {
        // The same record the page read, so the name in the lane header, the id
        // preflight checks for, and the model the request asks for are one fact.
        raceConfig = withServedModels(config, await readLanesState());
        // Asked again now, not trusted from when the page loaded.
        asked = await setupFor(raceConfig, racingLaneIds);
      } catch (err) {
        raceInFlight = false;
        throw err;
      }

      return eventStream(async (emit, _isOpen, signal) => {
        await runRace({
          signal,
          config: raceConfig,
          preset,
          sourceText,
          emit: (event) => {
            if (event.type === "race-done") {
              void keepRun(
                buildRunFile({
                  kind: "race",
                  rows: raceRows(preset, concurrency, event.results),
                  lanes: raceConfig.lanes.map((l, i) => ({ laneId: `lane-${i}`, label: l.label, displayModel: l.displayModel, model: l.model })),
                  setups: asked.setups,
                  maxTokens: raceConfig.maxTokens,
                  thinking: raceConfig.thinking,
                }),
              );
            }
            emit(event);
          },
          laneIds: racingLaneIds,
          concurrency,
          laneSlots: concurrency > 1 ? asked.slots : {},
          laneSetups: asked.setups,
        });
      });
    }

    if (url.pathname === "/api/sweep" && req.method === "POST") {
      if (raceInFlight) {
        return Response.json({ error: "A race is already running." }, { status: 409 });
      }
      const parsed = parseSweepRequest(await req.json().catch(() => ({})), { laneIds, maxConcurrency });
      if (!parsed.ok) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }
      const request = parsed.request;
      if (request.presets.some((p) => p !== "short") && sourceError) {
        return Response.json({ error: sourceError }, { status: 400 });
      }

      raceInFlight = true;
      let raceConfig: typeof config;
      let asked: Awaited<ReturnType<typeof setupFor>>;
      try {
        raceConfig = withServedModels(config, await readLanesState());
        asked = await setupFor(raceConfig, request.laneIds);
      } catch (err) {
        raceInFlight = false;
        throw err;
      }

      return eventStream(async (emit, isOpen, signal) => {
        const done = await runSweep({
          signal,
          config: raceConfig,
          sourceText,
          request,
          laneSlots: Math.max(...request.concurrencies) > 1 ? asked.slots : {},
          laneSetups: asked.setups,
          shouldStop: () => !isOpen(),
          // The table also goes to disk, so a sweep left running overnight is still there in the morning.
          emit: (event) => {
            if (event.type !== "sweep-done") return emit(event);
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            const savedAs = `results/sweep-${stamp}.csv`;
            mkdir(resolve(PROJECT_ROOT, "results"), { recursive: true })
              .then(() => writeFile(resolve(PROJECT_ROOT, savedAs), event.csv))
              .catch(() => {});
            void keepRun(
              buildRunFile({
                kind: "sweep",
                rows: event.rows,
                lanes: raceConfig.lanes.map((l, i) => ({ laneId: `lane-${i}`, label: l.label, displayModel: l.displayModel, model: l.model })),
                setups: asked.setups,
                maxTokens: raceConfig.maxTokens,
                thinking: raceConfig.thinking,
                complete: event.complete,
              }),
            );
            emit({ ...event, savedAs } as SweepEvent);
          },
        });
        void done;
      });
    }

    return new Response("not found", { status: 404 });
  }
}

const laneLines = config.lanes
  .map((l) => `    ${l.label.padEnd(10)} ${l.displayModel ?? l.model}`)
  .join("\n");

console.log(`
  LLM-SUPER-BENCH

    http://localhost:${server.port}

  Lanes (${config.lanes.length}):
${laneLines}

  Config: ${usedExample ? `${EXAMPLE_CONFIG_PATH}  (no race.config.json yet -- using the example, which points at the mock lanes)` : CONFIG_PATH}
  Prompt: ${config.promptFile}${sourceError ? `  [${sourceError}]` : ""}
`);

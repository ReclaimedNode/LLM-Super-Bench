/**
 * `bun run power` -- the pass a human runs with a wall meter in their hand.
 *
 *   bun run power
 *   bun run power --run my-run --hold 90
 *
 * Nothing here reads a sensor. A plug-in wall meter is the only honest way to
 * measure what a whole machine draws, and a person has to look at it, so the
 * job of this mode is to put each machine under steady, repeatable load and
 * then ask. Every number it stores is labelled as read by hand, everywhere it
 * is later shown.
 *
 * Lanes go one at a time, not together: a person holding one meter can only be
 * at one machine.
 */

import { resolve } from "node:path";
import type { Server } from "bun";
import { PROJECT_ROOT } from "../config.ts";
import { newLaneState, runLane } from "../lane.ts";
import { extractModelIds } from "../preflight.ts";
import type { LaneConfig } from "../types.ts";
import { refreshReport } from "./report.ts";
import { loadBenchConfig, modelsForLane } from "./config.ts";
import { buildBenchPrompt, makeBenchRunId } from "./prompt.ts";
import { THINKING_OFF_ARGS, parsePid, runRemote, startServerCommand, stopServerCommand } from "./ssh.ts";
import type { RemoteRunner } from "./ssh.ts";
import { checkSleep, holdAwake } from "./awake.ts";
import { reachLane } from "./reach.ts";
import type { AwakeHold } from "./awake.ts";
import { latestRun, readPower, runDir, writePower } from "./store.ts";
import type { BenchConfig, BenchLane, BenchModel, PowerReading } from "./types.ts";

const PUBLIC_DIR = resolve(PROJECT_ROOT, "public/bench");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "power.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "power.html", type: "text/html; charset=utf-8" },
  "/power.js": { file: "power.js", type: "text/javascript; charset=utf-8" },
  "/power.css": { file: "power.css", type: "text/css; charset=utf-8" },
  "/bench.css": { file: "bench.css", type: "text/css; charset=utf-8" },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ state

export interface PowerStep {
  /** Where in the list of readings this is. */
  index: number;
  total: number;
  laneLabel: string;
  modelName: string | null;
  kind: "idle" | "load";
  /** What the person should be doing right now. */
  phase: "settling" | "reading" | "working" | "done";
  /** What to do, in plain words. */
  action: string;
  secondsLeft: number;
  holdSeconds: number;
  /** Readings already taken. */
  taken: PowerReading[];
}

interface Pending {
  resolve: (watts: number | "skip") => void;
}

// ------------------------------------------------------------------ server

function startPowerServer(port: number, getState: () => PowerStep, submit: (watts: number | "skip") => boolean): Server {
  const clients = new Set<(chunk: string) => void>();
  const encoder = new TextEncoder();

  const broadcast = () => {
    const chunk = `data: ${JSON.stringify(getState())}\n\n`;
    for (const send of clients) send(chunk);
  };
  // The countdown is the point of the page, so it pushes every half second.
  setInterval(broadcast, 500).unref?.();

  return Bun.serve({
    port,
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);

      const stat = STATIC_FILES[url.pathname];
      if (stat && req.method === "GET") {
        return new Response(Bun.file(resolve(PUBLIC_DIR, stat.file)), {
          headers: { "Content-Type": stat.type, "Cache-Control": "no-store" },
        });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let open = true;
            const send = (chunk: string) => {
              if (!open) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                open = false;
                clients.delete(send);
              }
            };
            send(`data: ${JSON.stringify(getState())}\n\n`);
            clients.add(send);
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
        });
      }

      if (url.pathname === "/reading" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { watts?: unknown; skip?: unknown };
        if (body.skip === true) return Response.json({ ok: submit("skip") });
        const watts = Number(body.watts);
        if (!Number.isFinite(watts) || watts <= 0) {
          return Response.json({ error: "watts must be a positive number" }, { status: 400 });
        }
        return Response.json({ ok: submit(watts) });
      }

      return new Response("not found", { status: 404 });
    },
  });
}

// ------------------------------------------------------------------ load

function laneConfigFor(lane: BenchLane, modelId: string): LaneConfig {
  const out: LaneConfig = { label: lane.label, baseUrl: lane.baseUrl, model: modelId, displayModel: modelId };
  if (lane.apiKey) out.apiKey = lane.apiKey;
  return out;
}

/**
 * Keeps one machine generating until told to stop.
 *
 * Back-to-back requests rather than one long one: a single very long
 * generation would also work, but a request that dies halfway leaves the
 * machine idle behind a person still staring at a meter. This way a failure
 * costs one request.
 */
function startLoad(opts: {
  lane: BenchLane;
  modelId: string;
  config: BenchConfig;
  sourceText: string;
}): { stop: () => Promise<void>; errors: () => string[] } {
  let running = true;
  const errors: string[] = [];

  const loop = (async () => {
    let n = 0;
    while (running) {
      const prompt = buildBenchPrompt({
        runId: makeBenchRunId(n++),
        targetTokens: Math.min(4096, Math.max(...opts.config.promptLengths.map((p) => p.tokens))),
        charsPerToken: opts.config.charsPerToken,
        sourceText: opts.sourceText,
      });
      const result = await runLane(
        {
          laneId: opts.lane.label,
          lane: laneConfigFor(opts.lane, opts.modelId),
          prompt: prompt.text,
          // A bigger cap than the grid uses: the point is steady load, not a
          // comparable number, and a longer generation means fewer gaps.
          maxTokens: Math.max(512, opts.config.outputCap),
          temperature: opts.config.temperature,
          timeoutMs: opts.config.requestTimeoutMs,
          emit: () => {},
        },
        newLaneState(opts.lane.label, opts.lane.label),
      );
      if (result.error && running) {
        errors.push(result.error);
        if (errors.length > 3) running = false;
        await sleep(1000);
      }
    }
  })();

  return {
    stop: async () => {
      running = false;
      await loop;
    },
    errors: () => [...errors],
  };
}

async function listModels(baseUrl: string, apiKey: string | undefined): Promise<string[] | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
    return res.ok ? extractModelIds(await res.json()) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ driver

interface Job {
  lane: BenchLane;
  model: BenchModel | null;
  kind: "idle" | "load";
}

function plan(config: BenchConfig): Job[] {
  const jobs: Job[] = [];
  for (const lane of config.lanes) {
    // Idle first, while the machine has nothing to do and before any server
    // this pass starts is running on it.
    jobs.push({ lane, model: null, kind: "idle" });
    for (const model of modelsForLane(config, lane)) jobs.push({ lane, model, kind: "load" });
  }
  return jobs;
}

/**
 * Holds every managed lane in the pass awake, once each, for the whole pass.
 *
 * The pass is paced by a person reading a wall meter, so it can sit idle for
 * minutes between readings -- which is exactly what puts a machine to sleep.
 * The hold is per lane rather than per job, and it deliberately holds the
 * DISPLAY on as well: a display that slept between the idle reading and the
 * load reading would make the two readings incomparable at the wall, which is
 * the one thing this pass exists to compare.
 */
export async function holdPassAwake(
  jobs: Job[],
  opts: { run?: RemoteRunner; log?: (message: string) => void; seconds?: number } = {},
): Promise<{ holds: AwakeHold[]; release: () => Promise<void> }> {
  const holds: AwakeHold[] = [];
  const done = new Set<string>();

  for (const job of jobs) {
    if (!job.lane.ssh || done.has(job.lane.label)) continue;
    done.add(job.lane.label);

    const reached = await reachLane(job.lane.ssh, {
      run: opts.run,
      log: (message) => opts.log?.(`${job.lane.label}: ${message}`),
    });
    if (!reached.ok) {
      opts.log?.(`! ${job.lane.label}: ${reached.detail}`);
      continue;
    }

    const { warning } = await checkSleep(job.lane.ssh, opts.run);
    if (warning) opts.log?.(`! ${job.lane.label}: ${warning}`);

    const hold = await holdAwake({
      target: job.lane.ssh,
      seconds: opts.seconds ?? 4 * 60 * 60,
      run: opts.run,
    });
    if (hold.note) {
      opts.log?.(`${job.lane.label}: ${hold.note} The display stays on for the whole pass, so every reading is taken in the same state.`);
    }
    holds.push(hold);
  }

  return {
    holds,
    release: async () => {
      for (const hold of holds) await hold.release();
    },
  };
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1]! : null;
  };

  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
  bun run power [options]

    --run <name>    which run folder to store the readings in (default: the newest)
    --hold <sec>    seconds of load before asking for the reading (default: from the config)
    --port <n>      the page's port (default: the config's progressPort + 1)

  Plug the wall meter in, open the page, and it will tell you what to do.
`);
    return;
  }

  const { config } = await loadBenchConfig();
  const runName = value("--run") ?? (await latestRun());
  if (runName === null) {
    console.error("\n  No runs in results/bench yet. Run `bun run bench` first.\n");
    process.exit(1);
  }

  const holdSeconds = Number(value("--hold") ?? config.powerHoldSeconds) || config.powerHoldSeconds;
  const port = Number(value("--port") ?? config.progressPort + 1);

  const sourceText = await Bun.file(resolve(PROJECT_ROOT, config.promptFile)).text();
  const taken: PowerReading[] = (await readPower(runName)) ?? [];
  const jobs = plan(config);

  let pending: Pending | null = null;
  let state: PowerStep = {
    index: 0,
    total: jobs.length,
    laneLabel: jobs[0]?.lane.label ?? "",
    modelName: null,
    kind: "idle",
    phase: "working",
    action: "Starting up.",
    secondsLeft: 0,
    holdSeconds,
    taken,
  };

  const server = startPowerServer(
    port,
    () => state,
    (watts) => {
      if (!pending) return false;
      pending.resolve(watts);
      pending = null;
      return true;
    },
  );

  const ask = (): Promise<number | "skip"> => new Promise((resolve2) => (pending = { resolve: resolve2 }));
  const set = (patch: Partial<PowerStep>) => {
    state = { ...state, ...patch, taken };
  };

  console.log(`
  POWER PASS

    page     http://localhost:${server.port}
    run      ${runDir(runName)}
    hold     ${holdSeconds}s of load before each reading

  Lanes go one at a time: one meter, one machine.
`);

  const held = await holdPassAwake(jobs, { log: (m) => console.log(`  ${m}`) });
  process.once("SIGINT", held.release);
  process.once("SIGTERM", held.release);

  try {
  for (const [index, job] of jobs.entries()) {
    set({
      index,
      laneLabel: job.lane.label,
      modelName: job.model?.name ?? null,
      kind: job.kind,
      phase: "working",
      secondsLeft: 0,
    });

    if (job.kind === "idle") {
      set({
        phase: "reading",
        action:
          `Leave ${job.lane.label} completely idle. When the meter settles, read it and type the watts below.`,
      });
      const watts = await ask();
      if (watts !== "skip") {
        taken.push({
          laneLabel: job.lane.label,
          modelId: null,
          modelName: null,
          kind: "idle",
          watts,
          holdSeconds: 0,
          ts: new Date().toISOString(),
        });
        await writePower(runName, taken);
      }
      continue;
    }

    const model = job.model!;
    let pid: number | null = null;

    try {
      if (job.lane.ssh) {
        set({ action: `Starting ${model.name} on ${job.lane.label}.` });
        const started = await runRemote(
          job.lane.ssh,
          startServerCommand({
            target: job.lane.ssh,
            modelId: model.id,
            promptCacheSize: 0,
            chatTemplateArgs: config.disableThinking ? THINKING_OFF_ARGS : null,
          }),
          { timeoutMs: 60_000 },
        );
        pid = parsePid(started.stdout);
        if (pid === null) {
          set({ action: `Could not start ${model.name} on ${job.lane.label}. Skipping it.` });
          await sleep(4000);
          continue;
        }
      }

      set({ phase: "working", action: `Waiting for ${model.name} on ${job.lane.label} to load.` });
      const deadline = Date.now() + config.serverStartTimeoutMs;
      let requestModelId: string | null = null;
      while (Date.now() < deadline && requestModelId === null) {
        const ids = await listModels(job.lane.baseUrl, job.lane.apiKey);
        if (ids && ids.includes(model.id)) requestModelId = model.id;
        else if (ids && ids.length === 1 && job.lane.ssh) requestModelId = ids[0]!;
        else {
          set({
            phase: "working",
            action: `Load ${model.name} on ${job.lane.label}, then leave it running. Waiting for it.`,
          });
          await sleep(3000);
        }
      }
      if (requestModelId === null) {
        set({ action: `${model.name} never appeared on ${job.lane.label}. Skipping it.` });
        await sleep(4000);
        continue;
      }

      const load = startLoad({ lane: job.lane, modelId: requestModelId, config, sourceText });
      try {
        const endsAt = Date.now() + holdSeconds * 1000;
        while (Date.now() < endsAt) {
          set({
            phase: "settling",
            action: `${job.lane.label} is generating flat out on ${model.name}. Let the meter settle.`,
            secondsLeft: Math.ceil((endsAt - Date.now()) / 1000),
          });
          await sleep(500);
        }
        // The load keeps running while the question is on screen: the meter
        // has to be showing load when it is read.
        set({
          phase: "reading",
          secondsLeft: 0,
          action: `READ THE METER NOW — ${job.lane.label} is under full load on ${model.name}. Type the watts below.`,
        });
        const watts = await ask();
        if (watts !== "skip") {
          taken.push({
            laneLabel: job.lane.label,
            modelId: model.id,
            modelName: model.name,
            kind: "load",
            watts,
            holdSeconds,
            ts: new Date().toISOString(),
          });
          await writePower(runName, taken);
        }
        const errors = load.errors();
        if (errors.length > 0) console.log(`  ${job.lane.label}: ${errors.length} request(s) failed while holding load.`);
      } finally {
        await load.stop();
      }
    } finally {
      if (pid !== null && job.lane.ssh) {
        set({ phase: "working", action: `Stopping the server this pass started on ${job.lane.label}.` });
        await runRemote(job.lane.ssh, stopServerCommand(pid), { timeoutMs: 60_000 });
      }
    }
  }

  } finally {
    process.off("SIGINT", held.release);
    process.off("SIGTERM", held.release);
    await held.release();
  }

  set({
    index: jobs.length,
    phase: "done",
    action: `Done. ${taken.length} reading(s) stored. Open the board to see watts and tokens per watt.`,
    secondsLeft: 0,
  });

  // The report already in the folder was written before these readings
  // existed, so it is rewritten now with the power section in it.
  await refreshReport(runName);

  console.log(`
  ${taken.length} reading(s) written to ${runDir(runName)}/power.json
  report.md rewritten with the power section.

    bun run board ${runName}
`);
  await sleep(8000);
  server.stop(true);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

export { plan as planPowerJobs };

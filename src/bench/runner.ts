/**
 * The grid engine.
 *
 * Lanes are separate machines, so they run at the same time. Cells inside one
 * lane run strictly one after another: two cells on one machine would be
 * measuring each other.
 *
 * Every finished run is on disk before the next one starts. Killing this
 * process at any moment loses at most the run in flight, and re-running the
 * same grid picks up where it stopped.
 */

import { newLaneState, runLane } from "../lane.ts";
import { extractModelIds } from "../preflight.ts";
import type { LaneConfig, RaceEvent } from "../types.ts";
import { knownIdsFor, modelKeyIndex, modelsForLane, resolveModelId } from "./config.ts";
import { runEngineBenchmark } from "./engine.ts";
import { buildGrid, cellName, estimateGridSeconds, keyOfCell, resumePlan } from "./plan.ts";
import type { ResumeDecision } from "./plan.ts";
import { buildBenchPrompt, charsPerTokenFromProbe, correctedCharsPerToken, makeBenchRunId } from "./prompt.ts";
import { appendRun, readRuns, writeCells, writeEngine, writeManifest } from "./store.ts";
import { markRun, summariseCells } from "./stats.ts";
import { THINKING_OFF_ARGS, parsePid, runRemote, startServerCommand, stopServerCommand } from "./ssh.ts";
import { checkSleep, whileAwake } from "./awake.ts";
import { reachLane } from "./reach.ts";
import type { RemoteRunner } from "./ssh.ts";
import type {
  BenchConfig,
  BenchLane,
  BenchModel,
  BenchRunRecord,
  Cell,
  CellStat,
  EngineCell,
  RunManifest,
} from "./types.ts";

// ------------------------------------------------------------------ events

export type LanePhase =
  | "waiting"
  | "starting-server"
  | "awaiting-human"
  | "calibrating"
  | "warming"
  | "running"
  | "resting"
  | "engine"
  | "stopping-server"
  | "done"
  | "failed";

export interface LaneProgress {
  laneLabel: string;
  managed: boolean;
  phase: LanePhase;
  /** What a human has to do right now, if anything. */
  action: string | null;
  currentCell: string | null;
  currentModel: string | null;
  runsDone: number;
  runsInCell: number;
  cellsDone: number;
  cellsTotal: number;
  /** Seconds left of a rest, when resting. */
  restLeftSec: number;
  recent: { text: string; kind: "good" | "warn" | "bad" }[];
}

export type BenchEvent =
  | {
      type: "bench-start";
      runName: string;
      startedAt: number;
      lanes: LaneProgress[];
      cellsTotal: number;
      runsPlanned: number;
      cellsSkipped: number;
      estimateSec: number;
    }
  | { type: "lane", lane: LaneProgress }
  | { type: "run"; record: BenchRunRecord }
  | { type: "cell"; stat: CellStat }
  | { type: "note"; laneLabel: string | null; message: string; kind: "info" | "warn" | "error" }
  | { type: "bench-done"; runName: string; cells: CellStat[]; elapsedSec: number };

export type Emit = (event: BenchEvent) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ helpers

/** The server's usage frame is the only source of a true token count. */
async function listModels(baseUrl: string, apiKey: string | undefined, timeoutMs: number): Promise<string[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return extractModelIds(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function laneConfigFor(lane: BenchLane, modelId: string): LaneConfig {
  const out: LaneConfig = { label: lane.label, baseUrl: lane.baseUrl, model: modelId, displayModel: modelId };
  if (lane.apiKey) out.apiKey = lane.apiKey;
  return out;
}

const swallow: (event: RaceEvent) => void = () => {};

// ------------------------------------------------------------------ runner

export interface RunGridOptions {
  config: BenchConfig;
  runName: string;
  sourceText: string;
  emit: Emit;
  force?: boolean;
  /** Test seam: shortens rests without changing the recorded settings. */
  restScale?: number;
  signal?: { aborted: boolean };
  /** Test seam: the ssh layer, so the managed path can be proven off hardware. */
  run?: RemoteRunner;
}

export class GridRunner {
  private readonly opts: RunGridOptions;
  private readonly progress = new Map<string, LaneProgress>();
  private readonly startedAt = performance.now();
  private readonly engineCells: EngineCell[] = [];
  private readonly allCells: Cell[] = [];

  constructor(opts: RunGridOptions) {
    this.opts = opts;
  }

  // Not called `run`: the class already has a run() method, and a getter of
  // the same name would quietly replace it.
  private get remote(): RemoteRunner {
    return this.opts.run ?? runRemote;
  }

  private get config(): BenchConfig {
    return this.opts.config;
  }

  private note(laneLabel: string | null, message: string, kind: "info" | "warn" | "error" = "info"): void {
    this.opts.emit({ type: "note", laneLabel, message, kind });
    const lane = laneLabel ? this.progress.get(laneLabel) : null;
    if (lane) {
      lane.recent.unshift({ text: message, kind: kind === "error" ? "bad" : kind === "warn" ? "warn" : "good" });
      lane.recent.length = Math.min(lane.recent.length, 6);
      this.push(lane);
    }
  }

  private push(lane: LaneProgress): void {
    this.opts.emit({ type: "lane", lane: { ...lane, recent: [...lane.recent] } });
  }

  private set(lane: LaneProgress, patch: Partial<LaneProgress>): void {
    Object.assign(lane, patch);
    this.push(lane);
  }

  /** Rest between cells, counted down on screen so the pause looks deliberate. */
  private async rest(lane: LaneProgress, seconds: number): Promise<void> {
    const scaled = seconds * (this.opts.restScale ?? 1);
    if (scaled <= 0) return;
    this.set(lane, { phase: "resting", restLeftSec: Math.round(scaled) });
    const endsAt = performance.now() + scaled * 1000;
    while (performance.now() < endsAt) {
      if (this.opts.signal?.aborted) return;
      await sleep(Math.min(500, Math.max(0, endsAt - performance.now())));
      this.set(lane, { restLeftSec: Math.max(0, Math.round((endsAt - performance.now()) / 1000)) });
    }
    this.set(lane, { restLeftSec: 0 });
  }

  /**
   * One request, measured, recorded, on disk before it returns.
   *
   * The measurement is the existing lane client's: same monotonic clock, same
   * first-response / first-word split, same speed window. The benchmark adds
   * the true token counts and the server's version string to it.
   */
  private async runOnce(args: {
    lane: BenchLane;
    cell: Cell;
    /** What the endpoint lists. The record keeps the config's id instead. */
    requestModelId: string;
    runIndex: number;
    warmup: boolean;
    charsPerToken: number;
  }): Promise<BenchRunRecord> {
    const { lane, cell, runIndex, warmup } = args;
    const runId = makeBenchRunId(runIndex);
    const prompt = buildBenchPrompt({
      runId,
      targetTokens: cell.nominalTokens,
      charsPerToken: args.charsPerToken,
      sourceText: this.opts.sourceText,
    });

    const extraBody: Record<string, unknown> = {};
    if (this.config.disableThinking) {
      // Belt and braces with the server's own --chat-template-args flag: some
      // builds read it per request under this key, some only at startup. The
      // one that is actually in force is recorded either way, because the run
      // also records which field carried the first word.
      extraBody.chat_template_kwargs = { enable_thinking: false };
    }

    const result = await runLane(
      {
        laneId: lane.label,
        lane: laneConfigFor(lane, args.requestModelId),
        prompt: prompt.text,
        maxTokens: this.config.outputCap,
        temperature: this.config.temperature,
        timeoutMs: this.config.requestTimeoutMs,
        emit: swallow,
        extraBody,
      },
      newLaneState(lane.label, lane.label),
    );

    const record = markRun(
      {
        ts: new Date().toISOString(),
        runName: this.opts.runName,
        runId,
        laneLabel: cell.laneLabel,
        modelId: cell.modelId,
        modelKey: cell.modelKey,
        modelName: cell.modelName,
        nominalLabel: cell.nominalLabel,
        nominalTokens: cell.nominalTokens,
        outputCap: this.config.outputCap,
        runIndex,
        warmup,
        torture: cell.torture,
        firstResponseSec: result.firstResponseSec,
        firstWordSec: result.firstWordSec,
        firstWordField: result.firstWordField,
        lastWordSec: result.lastWordSec,
        totalSec: result.totalSec,
        promptTokens: result.promptTokens,
        outputTokens: result.tokens,
        cachedTokens: result.cachedTokens,
        chunks: result.chunks,
        promptChars: prompt.chars,
        systemFingerprint: result.systemFingerprint,
        thinkingDisabled: this.config.disableThinking,
        error: result.error,
        invalidReason: null,
        flags: [],
      },
      this.config.outputCap,
    );

    // On disk NOW. Everything after this line is allowed to be interrupted.
    await appendRun(this.opts.runName, record);
    this.opts.emit({ type: "run", record });
    return record;
  }

  /**
   * One probe per model to learn its characters-per-token, so a cell labelled
   * "4K" holds about four thousand tokens. Never a binary search: at 100,000
   * tokens a single wrong guess costs minutes.
   */
  private async calibrate(args: {
    lane: BenchLane;
    model: BenchModel;
    requestModelId: string;
    p: LaneProgress;
  }): Promise<number> {
    const { lane, model, requestModelId, p } = args;
    this.set(p, { phase: "calibrating", currentModel: model.name, currentCell: null });

    const smallest = Math.min(...this.config.promptLengths.map((l) => l.tokens));
    const guess = this.config.charsPerToken;
    const probe = buildBenchPrompt({
      runId: makeBenchRunId(0),
      targetTokens: smallest,
      charsPerToken: guess,
      sourceText: this.opts.sourceText,
    });

    const result = await runLane(
      {
        laneId: lane.label,
        lane: laneConfigFor(lane, requestModelId),
        prompt: probe.text,
        maxTokens: 4,
        temperature: this.config.temperature,
        timeoutMs: this.config.requestTimeoutMs,
        emit: swallow,
      },
      newLaneState(lane.label, lane.label),
    );

    const measured = charsPerTokenFromProbe(probe.chars, result.promptTokens ?? 0);
    if (measured === null) {
      this.note(
        lane.label,
        `${model.name}: the probe reported no prompt token count, so prompt sizes use the configured ${guess} characters per token.`,
        "warn",
      );
      return guess;
    }
    this.note(lane.label, `${model.name}: ${measured.toFixed(2)} characters per token, measured with one probe.`);
    return measured;
  }

  /** Brings a managed lane's server up, or says why it did not come up. */
  private async startServer(lane: BenchLane, model: BenchModel, p: LaneProgress): Promise<number | null> {
    if (!lane.ssh) return null;
    this.set(p, { phase: "starting-server", currentModel: model.name, action: null });

    const command = startServerCommand({
      target: lane.ssh,
      modelId: model.id,
      promptCacheSize: 0,
      chatTemplateArgs: this.config.disableThinking ? THINKING_OFF_ARGS : null,
    });
    const started = await this.remote(lane.ssh, command, { timeoutMs: 60_000 });
    const pid = parsePid(started.stdout);
    if (pid === null) {
      this.note(
        lane.label,
        `Could not start a server for ${model.name}: ${(started.stderr || started.stdout).trim().slice(0, 300) || "no pid printed"}`,
        "error",
      );
      return null;
    }
    this.note(lane.label, `Started ${model.name} on this lane's machine, pid ${pid}.`);
    return pid;
  }

  /**
   * Waits for the endpoint to list the model, whoever started it.
   *
   * Managed: the server we just launched is loading weights. Manual: a human
   * has to switch the model over, and the page says so in plain words rather
   * than failing the lane behind their back.
   */
  private async awaitModel(lane: BenchLane, model: BenchModel, p: LaneProgress, managed: boolean): Promise<string | null> {
    this.set(p, {
      phase: managed ? "starting-server" : "awaiting-human",
      currentModel: model.name,
      action: managed ? null : `Load ${model.name} on ${lane.label}, then leave it running. Waiting for it.`,
    });

    const deadline = performance.now() + this.config.serverStartTimeoutMs;
    let lastSeen: string[] = [];
    while (performance.now() < deadline) {
      if (this.opts.signal?.aborted) return null;
      const ids = await listModels(lane.baseUrl, lane.apiKey, 10_000);
      if (ids && ids.length > 0) {
        lastSeen = ids;
        // The request's `model` field must be EXACTLY what the endpoint lists:
        // mlx_lm.server treats an unknown name as a model to go and DOWNLOAD,
        // which means a call out to the internet and a 404. A config id
        // written with `~/` matches the absolute path the server lists it as.
        const resolved = resolveModelId(knownIdsFor(this.config, model), ids);
        if (resolved !== null) {
          if (resolved !== model.id) {
            this.note(lane.label, `The endpoint lists this model as "${resolved}"; using that exact id.`);
          }
          this.set(p, { action: null });
          return resolved;
        }
        this.set(p, {
          phase: "awaiting-human",
          action: `${lane.label} is serving ${ids.slice(0, 2).join(", ")}. Switch it to ${model.name}.`,
        });
      }
      await sleep(3000);
    }

    this.note(
      lane.label,
      `Gave up waiting for ${model.name} on ${lane.label} after ${Math.round(this.config.serverStartTimeoutMs / 1000)}s.` +
        (lastSeen.length > 0 ? ` The endpoint was up and listing: ${lastSeen.join(", ")}.` : " The endpoint never answered."),
      "error",
    );
    return null;
  }

  private async stopServer(lane: BenchLane, pid: number, p: LaneProgress): Promise<void> {
    if (!lane.ssh) return;
    this.set(p, { phase: "stopping-server" });
    const result = await this.remote(lane.ssh, stopServerCommand(pid), { timeoutMs: 60_000 });
    const stopped = result.stdout.includes("STOPPED");
    this.note(
      lane.label,
      stopped ? `Stopped pid ${pid}, the server this run started.` : `Could not confirm pid ${pid} stopped.`,
      stopped ? "info" : "warn",
    );
  }

  /** Runs every cell of one model on one lane. */
  private async runModel(args: {
    lane: BenchLane;
    model: BenchModel;
    cells: Cell[];
    decisions: Map<string, ResumeDecision>;
    p: LaneProgress;
    charsPerTokenOut: Record<string, number>;
  }): Promise<void> {
    const { lane, model, cells, decisions, p } = args;
    const owed = cells.filter((c) => !(decisions.get(keyOfCell(c))?.skip ?? false));
    if (owed.length === 0) return;

    let pid: number | null = null;
    if (lane.ssh) {
      pid = await this.startServer(lane, model, p);
      if (pid === null) {
        await this.failCells(owed, p, "the server would not start");
        return;
      }
    }

    try {
      const listedId = await this.awaitModel(lane, model, p, lane.ssh !== undefined);
      if (listedId === null) {
        await this.failCells(owed, p, "the endpoint never listed the model");
        return;
      }
      // The request's `model` field is the id the endpoint actually lists, not
      // whatever the config called it. The RECORD keeps the config's id, so
      // resume and the board still line up across runs.
      const requestModelId = listedId;

      let charsPerToken = await this.calibrate({ lane, model, requestModelId, p });
      args.charsPerTokenOut[model.id] = charsPerToken;

      for (const [index, cell] of owed.entries()) {
        if (this.opts.signal?.aborted) return;
        const decision = decisions.get(keyOfCell(cell))!;
        const owedRuns = decision.remaining;

        this.set(p, {
          phase: "warming",
          currentCell: cellName(cell),
          currentModel: model.name,
          runsDone: 0,
          runsInCell: owedRuns,
        });

        // --- Warm-up: discarded, and used to correct the prompt size for free.
        for (let w = 0; w < this.config.warmupRuns; w++) {
          const warm = await this.runOnce({ lane, cell, requestModelId, runIndex: 0, warmup: true, charsPerToken });
          const corrected =
            warm.promptTokens === null
              ? null
              : correctedCharsPerToken({
                  charsPerToken,
                  targetTokens: cell.nominalTokens,
                  actualTokens: warm.promptTokens,
                });
          if (corrected !== null) {
            this.note(
              lane.label,
              `${cell.nominalLabel}: the warm-up landed at ${warm.promptTokens} tokens against a ${cell.nominalTokens} target, so the measured runs are rescaled.`,
            );
            charsPerToken = corrected;
            args.charsPerTokenOut[model.id] = corrected;
          }
        }

        // --- Measured runs.
        this.set(p, { phase: "running" });
        for (let i = 1; i <= owedRuns; i++) {
          if (this.opts.signal?.aborted) return;
          const record = await this.runOnce({
            lane,
            cell,
            requestModelId,
            runIndex: decision.done + i,
            warmup: false,
            charsPerToken,
          });
          this.set(p, { runsDone: i });

          if (record.error) {
            this.note(lane.label, `${cell.nominalLabel} run ${i} failed: ${record.error}`, "error");
          } else if (record.invalidReason) {
            this.note(lane.label, `${cell.nominalLabel} run ${i} excluded: ${record.invalidReason}`, "warn");
          } else {
            const read = record.promptTokens !== null && record.firstWordSec ? record.promptTokens / record.firstWordSec : null;
            this.note(
              lane.label,
              `${cell.nominalLabel} run ${i}: first word ${record.firstWordSec?.toFixed(2) ?? "-"}s, ` +
                `${record.promptTokens} in / ${record.outputTokens} out` +
                (read ? `, reads ${read.toFixed(0)} tok/s` : ""),
            );
          }
        }

        this.set(p, { cellsDone: p.cellsDone + 1, currentCell: null });
        await this.emitCellStat(cell);

        const isLast = index === owed.length - 1;
        if (!isLast) await this.rest(p, this.config.restSeconds);
      }

      // --- The engine's own benchmark, on managed lanes only: it needs a shell
      //     on the machine, and it must not fight the API server for the GPU,
      //     so it runs after that model's API cells and before the next model.
      if (lane.ssh && this.config.engineBenchmark) {
        if (pid !== null) await this.stopServer(lane, pid, p);
        pid = null;
        this.set(p, { phase: "engine", currentCell: `${model.name} · engine benchmark` });
        for (const length of this.config.promptLengths) {
          if (this.opts.signal?.aborted) return;
          const cellOut = await runEngineBenchmark({
            laneLabel: lane.label,
            target: lane.ssh,
            modelId: model.id,
            nominalLabel: length.label,
            nominalTokens: length.tokens,
            generationTokens: this.config.outputCap,
            trials: this.config.engineTrials,
            timeoutMs: this.config.requestTimeoutMs,
          });
          this.engineCells.push(cellOut);
          await writeEngine(this.opts.runName, this.engineCells);
          this.note(
            lane.label,
            cellOut.unavailable
              ? `Engine benchmark at ${length.label}: not available (${cellOut.unavailable}).`
              : `Engine benchmark at ${length.label}: reads ${cellOut.promptTps?.median.toFixed(0)} tok/s, writes ${cellOut.generationTps?.median.toFixed(1)} tok/s, peak memory ${cellOut.peakMemoryGb?.toFixed(2)} GB.`,
            cellOut.unavailable ? "warn" : "info",
          );
        }
      }
    } finally {
      if (pid !== null) await this.stopServer(lane, pid, p);
    }
  }

  /**
   * Records a cell that never got to run, with the reason, on disk.
   *
   * Writing nothing would leave it as "not-run" in cells.json, which reads the
   * same as "we never asked for it" -- and the first time this happened for
   * real, working out why cost an ssh session. A cell the grid tried and could
   * not do is a result, and it belongs in the log like any other.
   */
  private async failCells(cells: Cell[], p: LaneProgress, why: string): Promise<void> {
    for (const cell of cells) {
      this.note(p.laneLabel, `${cellName(cell)} could not run: ${why}.`, "error");
      const decisionRuns = cell.measuredRuns;
      for (let i = 1; i <= decisionRuns; i++) {
        await appendRun(
          this.opts.runName,
          markRun(
            {
              ts: new Date().toISOString(),
              runName: this.opts.runName,
              runId: makeBenchRunId(i),
              laneLabel: cell.laneLabel,
              modelId: cell.modelId,
              modelKey: cell.modelKey,
              modelName: cell.modelName,
              nominalLabel: cell.nominalLabel,
              nominalTokens: cell.nominalTokens,
              outputCap: this.config.outputCap,
              runIndex: i,
              warmup: false,
              torture: cell.torture,
              firstResponseSec: null,
              firstWordSec: null,
              firstWordField: null,
              lastWordSec: null,
              totalSec: null,
              promptTokens: null,
              outputTokens: null,
              cachedTokens: null,
              chunks: 0,
              promptChars: 0,
              systemFingerprint: null,
              thinkingDisabled: this.config.disableThinking,
              error: why,
              invalidReason: null,
              flags: [],
            },
            this.config.outputCap,
          ),
        );
      }
      p.cellsDone += 1;
      await this.emitCellStat(cell);
    }
    this.push(p);
  }

  private async emitCellStat(cell: Cell): Promise<void> {
    const records = await readRuns(this.opts.runName);
    const stats = summariseCells(this.allCells, records, this.config.outputCap, modelKeyIndex(this.config));
    await writeCells(this.opts.runName, stats);
    const mine = stats.find(
      (s) => s.laneLabel === cell.laneLabel && s.modelKey === cell.modelKey && s.nominalLabel === cell.nominalLabel,
    );
    if (mine) this.opts.emit({ type: "cell", stat: mine });
  }

  async run(): Promise<CellStat[]> {
    const config = this.config;
    const grid = buildGrid(config);
    const existing = await readRuns(this.opts.runName);

    const decisionsByLane = new Map<string, ResumeDecision[]>();
    for (const lane of grid.lanes) {
      decisionsByLane.set(
        lane.laneLabel,
        resumePlan(lane.cells, existing, this.opts.force ?? false, modelKeyIndex(config)),
      );
      this.allCells.push(...lane.cells);
    }

    const skipped = [...decisionsByLane.values()].flat().filter((d) => d.skip).length;
    const runsPlanned = [...decisionsByLane.values()].flat().reduce((n, d) => n + d.remaining, 0);

    for (const lane of grid.lanes) {
      const decisions = decisionsByLane.get(lane.laneLabel)!;
      this.progress.set(lane.laneLabel, {
        laneLabel: lane.laneLabel,
        managed: lane.managed,
        phase: "waiting",
        action: null,
        currentCell: null,
        currentModel: null,
        runsDone: 0,
        runsInCell: 0,
        cellsDone: decisions.filter((d) => d.skip).length,
        cellsTotal: lane.cells.length,
        restLeftSec: 0,
        recent: [],
      });
    }

    const manifest: RunManifest = {
      runName: this.opts.runName,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      outputCap: config.outputCap,
      measuredRuns: config.measuredRuns,
      warmupRuns: config.warmupRuns,
      restSeconds: config.restSeconds,
      temperature: config.temperature,
      promptFile: config.promptFile,
      disableThinking: config.disableThinking,
      models: config.models,
      lanes: grid.lanes.map((l) => ({ label: l.laneLabel, managed: l.managed })),
      promptLengths: config.promptLengths,
      fingerprints: [],
      charsPerToken: {},
    };
    await writeManifest(this.opts.runName, manifest);

    this.opts.emit({
      type: "bench-start",
      runName: this.opts.runName,
      startedAt: Date.now(),
      lanes: [...this.progress.values()].map((l) => ({ ...l })),
      cellsTotal: grid.totalCells,
      runsPlanned,
      cellsSkipped: skipped,
      estimateSec: estimateGridSeconds(grid, decisionsByLane, config),
    });

    // Lanes are separate machines, so they run at the same time. One lane
    // failing never stops another: that is what allSettled buys here.
    await Promise.allSettled(
      config.lanes.map(async (lane) => {
        const p = this.progress.get(lane.label)!;
        const decisions = new Map(
          (decisionsByLane.get(lane.label) ?? []).map((d) => [keyOfCell(d.cell), d] as const),
        );
        const laneCells = grid.lanes.find((l) => l.laneLabel === lane.label)?.cells ?? [];

        try {
          // A grid can run for hours; a machine set to sleep in a minute would
          // drop off the network partway through and look like a network fault.
          if (lane.ssh) {
            // A lane that is merely asleep is woken and tried again: a grid
            // that dies on its first ssh looks like a broken tool.
            const reached = await reachLane(lane.ssh, {
              run: this.remote,
              log: (message) => this.note(lane.label, message, "warn"),
            });
            if (!reached.ok) throw new Error(reached.detail);

            const { warning } = await checkSleep(lane.ssh, this.remote);
            if (warning) this.note(lane.label, warning, "warn");
          }

          const work = async () => {
            for (const model of modelsForLane(config, lane)) {
              if (this.opts.signal?.aborted) break;
              await this.runModel({
                lane,
                model,
                cells: laneCells.filter((c) => c.modelId === model.id),
                decisions,
                p,
                charsPerTokenOut: manifest.charsPerToken,
              });
            }
          };

          if (lane.ssh) {
            await whileAwake(
              {
                target: lane.ssh,
                seconds: 6 * 60 * 60,
                run: this.remote,
                log: (m) => this.note(lane.label, m),
              },
              work,
            );
          } else {
            await work();
          }
          this.set(p, { phase: "done", currentCell: null, action: null });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.note(lane.label, `Lane stopped: ${message}`, "error");
          this.set(p, { phase: "failed", action: null });
        }
      }),
    );

    const records = await readRuns(this.opts.runName);
    const cells = summariseCells(this.allCells, records, config.outputCap, modelKeyIndex(config));
    await writeCells(this.opts.runName, cells);

    manifest.finishedAt = new Date().toISOString();
    manifest.fingerprints = [...new Set(records.map((r) => r.systemFingerprint).filter((f): f is string => !!f))];
    await writeManifest(this.opts.runName, manifest);

    const elapsedSec = (performance.now() - this.startedAt) / 1000;
    this.opts.emit({ type: "bench-done", runName: this.opts.runName, cells, elapsedSec });
    return cells;
  }
}

export async function runGrid(opts: RunGridOptions): Promise<CellStat[]> {
  return new GridRunner(opts).run();
}

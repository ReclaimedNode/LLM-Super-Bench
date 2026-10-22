/**
 * `bun run report` -- the median of the last N runs per lane and preset, read
 * back out of results/runs.jsonl.
 *
 *   bun run report
 *   bun run report --last 20
 */

import { DEFAULT_LOG_PATH, readRecords } from "./log.ts";
import { PRESET_IDS } from "./prompt.ts";
import { computeRate, laneSpeed, laneThroughput, median, promptSpeed } from "./timing.ts";
import type { MachineSetup } from "./details.ts";
import type { RunLogRecord } from "./types.ts";

export interface ReportRow {
  lane: string;
  preset: string;
  /** Simultaneous streams on the machine. Runs at different counts are never pooled. */
  concurrency: number;
  runs: number;
  errors: number;
  medianFirstResponseSec: number | null;
  medianFirstWordSec: number | null;
  medianTotalSec: number | null;
  /** With one stream, its speed. With several, the median speed of ONE stream. */
  medianRate: number | null;
  /** Every stream together. Null with one stream, where it would only repeat the speed. */
  medianThroughput: number | null;
  rateUnit: "tokens/sec" | "chunks/sec";
  /** Prompt tokens per second to the first word, one-stream runs only. Null where it would be a guess. */
  medianPromptSpeed: number | null;
  /** True when the runs in this row were made against differently set-up servers. */
  setupChanged: boolean;
}

/**
 * Groups by lane, preset and streams per machine, keeps the LAST `last` records
 * of each group in file order, and takes medians over those. A run with four
 * streams is a different measurement from a run with one, so they are never
 * pooled. Errored runs count toward the
 * error column and are excluded from the medians.
 */
export function buildReport(records: RunLogRecord[], last: number): ReportRow[] {
  const groups = new Map<string, RunLogRecord[]>();
  for (const r of records) {
    const key = `${r.lane}\u0000${r.preset}\u0000${r.concurrency ?? 1}`;
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }

  const rows: ReportRow[] = [];
  for (const [key, all] of groups) {
    const [lane = "", preset = "", streamsText = "1"] = key.split("\u0000");
    const concurrency = Number(streamsText);
    const window = all.slice(-last);
    const good = window.filter((r) => !r.error && r.totalSec !== null);
    const tokensEverywhere = good.length > 0 && good.every((r) => r.tokens !== null);
    const rateUnit: "tokens/sec" | "chunks/sec" = tokensEverywhere ? "tokens/sec" : "chunks/sec";

    // Same formula the live race used. Records written before lastWordSec
    // existed simply have no rate rather than a wrong one.
    const unit = tokensEverywhere ? ("tokens/sec" as const) : ("chunks/sec" as const);
    const rates = good
      .map((r) =>
        concurrency > 1
          ? laneSpeed({ ...r, lastWordSec: r.lastWordSec ?? null }, unit)
          : computeRate(tokensEverywhere ? (r.tokens as number) : r.chunks, r.firstWordSec, r.lastWordSec ?? null),
      )
      .filter((v): v is number => v !== null);
    const throughputs = good
      .map((r) => laneThroughput(r, unit))
      .filter((v): v is number => v !== null);

    rows.push({
      lane,
      preset,
      concurrency,
      runs: window.length,
      errors: window.length - good.length,
      medianFirstResponseSec: median(
        good.map((r) => r.firstResponseSec ?? null).filter((v): v is number => v !== null),
      ),
      medianFirstWordSec: median(good.map((r) => r.firstWordSec).filter((v): v is number => v !== null)),
      medianTotalSec: median(good.map((r) => r.totalSec).filter((v): v is number => v !== null)),
      medianRate: median(rates),
      medianThroughput: concurrency > 1 ? median(throughputs) : null,
      rateUnit,
      medianPromptSpeed: median(
        good
          .map((r) =>
            promptSpeed({
              promptTokens: r.promptTokens ?? null,
              firstWordSec: r.firstWordSec,
              firstWordField: r.firstWordField,
              cachedTokens: r.cachedTokens ?? 0,
              concurrency: r.concurrency ?? 1,
              error: null,
              blocked: null,
            }),
          )
          .filter((v): v is number => v !== null),
      ),
      // Only records that carry a setup can disagree about it.
      setupChanged: new Set(window.filter((r) => r.setup).map((r) => JSON.stringify(r.setup))).size > 1,
    });
  }

  const presetOrder = PRESET_IDS as string[];
  rows.sort((a, b) => {
    const pa = presetOrder.indexOf(a.preset);
    const pb = presetOrder.indexOf(b.preset);
    if (pa !== pb) return (pa === -1 ? 99 : pa) - (pb === -1 ? 99 : pb);
    if (a.lane !== b.lane) return a.lane.localeCompare(b.lane);
    return a.concurrency - b.concurrency;
  });
  return rows;
}

function cell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** The newest reported setup of each lane, from the log. */
export function latestSetups(records: RunLogRecord[]): { lane: string; setup: MachineSetup }[] {
  const byLane = new Map<string, MachineSetup>();
  for (const r of records) if (r.setup) byLane.set(r.lane, r.setup);
  return [...byLane].map(([lane, setup]) => ({ lane, setup }));
}

export function describeSetup(s: MachineSetup): string {
  const parts = [
    s.modelFile ?? "model not reported",
    s.quant,
    s.build ? `build ${s.build}` : null,
    s.slots !== null ? `${s.slots} slot${s.slots === 1 ? "" : "s"}` : null,
    s.contextPerSlot !== null ? `${s.contextPerSlot.toLocaleString("en-US")} ctx/slot` : null,
    s.notes ? `notes: ${s.notes}` : null,
  ];
  return parts.filter((p): p is string => !!p).join(", ");
}

export function formatReport(rows: ReportRow[], last: number, setups: { lane: string; setup: MachineSetup }[] = []): string {
  if (rows.length === 0) {
    return `No runs logged yet. Race something, then run this again.\n(looked in ${DEFAULT_LOG_PATH})`;
  }

  const header = ["LANE", "PRESET", "STREAMS", "RUNS", "ERR", "FIRST RESP", "FIRST WORD", "TOTAL", "SPEED", "UNIT", "ALL STREAMS", "PROMPT TOK/S"];
  const body = rows.map((r) => [
    r.lane,
    r.preset,
    String(r.concurrency),
    String(r.runs),
    String(r.errors),
    r.medianFirstResponseSec === null ? "-" : `${r.medianFirstResponseSec.toFixed(3)}s`,
    r.medianFirstWordSec === null ? "-" : `${r.medianFirstWordSec.toFixed(3)}s`,
    r.medianTotalSec === null ? "-" : `${r.medianTotalSec.toFixed(2)}s`,
    r.medianRate === null ? "-" : r.medianRate.toFixed(1),
    r.rateUnit,
    r.medianThroughput === null ? "-" : r.medianThroughput.toFixed(1),
    r.medianPromptSpeed === null ? "-" : Math.round(r.medianPromptSpeed).toLocaleString("en-US"),
  ]);

  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => cell(c, widths[i]!)).join("  ").trimEnd();

  const out = [
    `Median of the last ${last} run(s) per lane, preset and streams per machine.`,
    ...(rows.some((r) => r.concurrency > 1)
      ? [
          "With several streams, SPEED is one stream's median and ALL STREAMS is every stream together,",
          "in the same unit. FIRST WORD is the median of the streams; TOTAL is until the last one finished.",
        ]
      : []),
    "",
    line(header),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
    "",
    "PROMPT TOK/S is prompt tokens over seconds to the first word; '-' where that would be a guess",
    "(several streams, a thinking model, a cache hit, no usage report, or a prompt under 500 tokens).",
    ...(rows.some((r) => r.setupChanged)
      ? [
          "",
          `Setup changed within the window for: ${rows.filter((r) => r.setupChanged).map((r) => `${r.lane} ${r.preset} x${r.concurrency}`).join("; ")}.`,
          "Those medians mix runs from differently set-up servers; use --last to look at only the newest.",
        ]
      : []),
    ...(setups.length > 0 ? ["", "Setup, as last reported:", ...setups.map((s) => `  ${s.lane}: ${describeSetup(s.setup)}`)] : []),
  ];
  return out.join("\n");
}

if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  const i = argv.indexOf("--last");
  const last = i !== -1 && argv[i + 1] ? Math.max(1, Number(argv[i + 1])) : 10;
  const records = await readRecords();
  console.log("\n" + formatReport(buildReport(records, last), last, latestSetups(records)) + "\n");
}

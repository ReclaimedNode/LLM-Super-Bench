/**
 * report.md -- plain Markdown tables a human can paste in public.
 *
 * The rule for this file is the rule for the whole benchmark: a number appears
 * with what it is a median of, and anything excluded is named rather than
 * quietly missing. The settings and software versions sit at the bottom,
 * because a speed without them cannot be reproduced and so cannot be checked.
 */

import type { CellStat, EngineCell, PowerReading, RunManifest, Stat3 } from "./types.ts";
import { compareSentence } from "./stats.ts";
import { readCells, readEngine, readManifest, readPower, writeReport } from "./store.ts";

function n(value: number, places = 1): string {
  return value.toFixed(places);
}

/** "312 (298-330)" -- the median, then the range it came from. */
function stat(s: Stat3 | null, places = 1): string {
  if (s === null) return "-";
  if (s.n === 1) return `${n(s.median, places)} (1 run)`;
  return `${n(s.median, places)} (${n(s.low, places)}–${n(s.high, places)})`;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function table(header: string[], rows: string[][]): string {
  const head = `| ${header.join(" | ")} |`;
  const rule = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(escapePipes).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

function statusMark(cell: CellStat): string {
  switch (cell.status) {
    case "ok":
      return "";
    case "partial":
      return ` ⚠ ${cell.runsUsed}/${cell.runsRecorded} runs used`;
    case "failed":
      return " ✖ all runs failed";
    case "no-valid-runs":
      return " ✖ no valid runs";
    case "not-run":
      return " — not run";
  }
}

export interface ReportInput {
  manifest: RunManifest;
  cells: CellStat[];
  engine: EngineCell[];
  power: PowerReading[];
}

/**
 * Grouped by the model's KEY, not its id: the same model measured on two
 * machines can carry two different per-machine paths as its id, and those
 * belong under one heading. Cells written before keys existed fall back to the
 * id, which is what they were grouped by then.
 */
function byModel(cells: CellStat[]): Map<string, CellStat[]> {
  const out = new Map<string, CellStat[]>();
  for (const cell of cells) {
    const key = cell.modelKey ?? cell.modelId;
    const arr = out.get(key);
    if (arr) arr.push(cell);
    else out.set(key, [cell]);
  }
  return out;
}

function laneOrder(cells: CellStat[]): string[] {
  return [...new Set(cells.map((c) => c.laneLabel))];
}

function lengthOrder(cells: CellStat[]): { label: string; tokens: number }[] {
  const map = new Map<string, number>();
  for (const c of cells) if (!map.has(c.nominalLabel)) map.set(c.nominalLabel, c.nominalTokens);
  return [...map].map(([label, tokens]) => ({ label, tokens })).sort((a, b) => a.tokens - b.tokens);
}

function find(cells: CellStat[], lane: string, label: string): CellStat | undefined {
  return cells.find((c) => c.laneLabel === lane && c.nominalLabel === label);
}

function headline(cells: CellStat[], lanes: string[]): string | null {
  if (lanes.length < 2) return null;
  // The headline compares the two lanes on the biggest prompt they both
  // finished: the small cells are where the machines look most alike.
  const lengths = lengthOrder(cells).reverse();
  for (const { label } of lengths) {
    const a = find(cells, lanes[0]!, label);
    const b = find(cells, lanes[1]!, label);
    if (!a || !b) continue;
    const sentence = compareSentence(
      { label: a.laneLabel, read: a.readSpeed?.median ?? null, write: a.writeSpeed?.median ?? null },
      { label: b.laneLabel, read: b.readSpeed?.median ?? null, write: b.writeSpeed?.median ?? null },
    );
    if (sentence) return `At a ${label} prompt: ${sentence}`;
  }
  return null;
}

function modelSection(model: { id: string; name: string }, cells: CellStat[]): string {
  const lanes = laneOrder(cells);
  const lengths = lengthOrder(cells);
  const out: string[] = [`## ${model.name}`, ""];

  const line = headline(cells, lanes);
  if (line) out.push(`**${line}**`, "");

  out.push("### Reading speed — true prompt tokens per second of wait", "");
  out.push(
    table(
      ["Prompt", ...lanes],
      lengths.map(({ label }) => [
        label,
        ...lanes.map((lane) => {
          const cell = find(cells, lane, label);
          return cell ? stat(cell.readSpeed, 0) + statusMark(cell) : "-";
        }),
      ]),
    ),
    "",
  );

  out.push("### Writing speed — output tokens per second", "");
  out.push(
    table(
      ["Prompt", ...lanes],
      lengths.map(({ label }) => [
        label,
        ...lanes.map((lane) => {
          const cell = find(cells, lane, label);
          return cell ? stat(cell.writeSpeed, 1) + statusMark(cell) : "-";
        }),
      ]),
    ),
    "",
  );

  out.push("### Wait for the first word — seconds", "");
  out.push(
    table(
      ["Prompt", ...lanes],
      lengths.map(({ label }) => [
        label,
        ...lanes.map((lane) => {
          const cell = find(cells, lane, label);
          return cell ? stat(cell.firstWordSec, 2) + statusMark(cell) : "-";
        }),
      ]),
    ),
    "",
  );

  out.push("### True token counts the speeds were divided by", "");
  out.push(
    table(
      ["Lane", "Prompt (label)", "True prompt tokens", "True output tokens", "Runs used"],
      cells.map((c) => [
        c.laneLabel,
        c.nominalLabel + (c.torture ? " (torture)" : ""),
        stat(c.truePromptTokens, 0),
        stat(c.trueOutputTokens, 0),
        `${c.runsUsed} of ${c.runsRecorded}`,
      ]),
    ),
    "",
  );

  const notes = cells.flatMap((c) => c.notes.map((note) => `- **${c.laneLabel} ${c.nominalLabel}:** ${note}`));
  if (notes.length > 0) out.push("### Excluded, failed and flagged", "", ...notes, "");

  return out.join("\n");
}

/**
 * The name an engine row is printed under.
 *
 * An engine cell carries only the model id it ran, and in a merged run each
 * machine can have recorded a different per-machine path for the same weights.
 * So: the exact id or a recorded alias first, then the same folder name (also
 * the `org--name` form some caches use), and the id itself only when nothing in
 * the manifest claims it -- a row with no name would be a row nobody can read.
 */
export function engineModelName(manifest: RunManifest, modelId: string): string {
  const exact = manifest.models.find((m) => m.id === modelId || (m.aliases ?? []).includes(modelId));
  if (exact) return exact.name;
  const tail = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;
  const want = tail(modelId);
  const byFolder = manifest.models.find((m) => {
    const have = m.dir ?? tail(m.id);
    return want === have || want.endsWith(`--${have}`);
  });
  return byFolder ? byFolder.name : modelId;
}

function engineSection(engine: EngineCell[], manifest: RunManifest): string {
  if (engine.length === 0) return "";
  const out = [
    "## The engine's own benchmark",
    "",
    "`mlx_lm.benchmark` on the machine itself: no HTTP server, no chat template, no network.",
    "The tool prints a mean; the median, lowest and highest below are computed here from its per-trial lines,",
    "so they are the same statistic as the API numbers above. Peak memory is the highest any trial reached.",
    "",
    table(
      ["Lane", "Model", "Prompt", "Reads (tok/s)", "Writes (tok/s)", "Peak memory (GB)", "Trials"],
      engine.map((e) => [
        e.laneLabel,
        engineModelName(manifest, e.modelId),
        e.nominalLabel,
        e.unavailable ? `not available — ${e.unavailable}` : stat(e.promptTps, 0),
        e.unavailable ? "-" : stat(e.generationTps, 1),
        e.peakMemoryGb === null ? "-" : n(e.peakMemoryGb, 2),
        String(e.trials),
      ]),
    ),
    "",
  ];
  return out.join("\n");
}

function powerSection(power: PowerReading[]): string {
  if (power.length === 0) return "";
  const out = [
    "## Power",
    "",
    "Read by hand off a wall meter while the machine was under steady generation load. Not a sensor reading.",
    "",
    table(
      ["Lane", "Model", "Reading", "Watts", "Held for"],
      power.map((p) => [
        p.laneLabel,
        p.modelName ?? "—",
        p.kind === "idle" ? "idle" : "under load",
        n(p.watts, 0),
        `${p.holdSeconds}s`,
      ]),
    ),
    "",
  ];
  return out.join("\n");
}

function settingsSection(manifest: RunManifest, cells: CellStat[]): string {
  const fingerprints = manifest.fingerprints.length > 0
    ? manifest.fingerprints
    : [...new Set(cells.flatMap((c) => c.fingerprints))];

  const modelRows = manifest.models.map((m) => [
    m.name,
    m.quantization ?? "—",
    m.fileSize ?? "—",
    m.activeParams ?? "—",
    manifest.charsPerToken[m.id] === undefined ? "—" : n(manifest.charsPerToken[m.id]!, 2),
  ]);

  return [
    "## Settings and versions",
    "",
    table(["Model", "Quantization", "File size", "Active parameters", "Measured chars/token"], modelRows),
    "",
    `- **Output cap:** ${manifest.outputCap} tokens on every request.`,
    `- **Measured runs per cell:** ${manifest.measuredRuns}, after ${manifest.warmupRuns} discarded warm-up run(s).`,
    `- **Rest between cells:** ${manifest.restSeconds}s.`,
    `- **Temperature:** ${manifest.temperature}.`,
    `- **Thinking:** ${manifest.disableThinking ? "asked to be off" : "left on"}.`,
    `- **Prompt source:** ${manifest.promptFile}. Every prompt opened with a unique run id, so no prompt cache could match it.`,
    `- **Headline statistic:** median, with the lowest and highest of the run in brackets. Never a mean.`,
    `- **Software:** ${fingerprints.length > 0 ? fingerprints.join(", ") : "not reported by the server"}.`,
    `- **Started:** ${manifest.startedAt}${manifest.finishedAt ? `  ·  **Finished:** ${manifest.finishedAt}` : ""}.`,
    ...(manifest.mergedFrom
      ? [
          `- **Merged from:** ${manifest.mergedFrom
            .map((m) => `${m.runName} (${m.lanes.join(", ")})`)
            .join(" and ")}. Each machine ran its own invocation; the settings above were identical in both, ` +
            `which is checked before a merge is allowed.`,
        ]
      : []),
    "",
  ].join("\n");
}

export function buildReport(input: ReportInput): string {
  const { manifest, cells } = input;
  const out: string[] = [
    `# Benchmark: ${manifest.runName}`,
    "",
    "Reading speed is the true prompt token count from the server's usage frame, divided by the seconds spent",
    "waiting for the first word. Writing speed is `(tokens − 1) ÷ (last piece − first piece)`, so the wait before",
    "the first word is not counted twice. Every figure is a median over the measured runs, with the range beside it.",
    "",
  ];

  const grouped = byModel(cells);
  for (const model of manifest.models) {
    const mine = grouped.get(model.dir ?? model.id) ?? grouped.get(model.id);
    if (!mine || mine.length === 0) continue;
    out.push(modelSection(model, mine), "");
  }

  const engine = engineSection(input.engine, manifest);
  if (engine) out.push(engine, "");
  const power = powerSection(input.power);
  if (power) out.push(power, "");
  out.push(settingsSection(manifest, cells));

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * Rewrites report.md from whatever the run folder currently holds. Safe to call
 * again: the power pass calls it after adding readings the grid never saw.
 */
export async function refreshReport(runName: string): Promise<string | null> {
  const manifest = await readManifest(runName);
  if (manifest === null) return null;
  const markdown = buildReport({
    manifest,
    cells: (await readCells(runName)) ?? [],
    engine: (await readEngine(runName)) ?? [],
    power: (await readPower(runName)) ?? [],
  });
  await writeReport(runName, markdown);
  return markdown;
}

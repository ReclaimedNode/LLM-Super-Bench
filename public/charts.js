// Pure chart and file helpers for the results page. No DOM, so they can be tested as plain functions.
// Every string that comes from a run file is escaped before it goes into SVG: a file from someone else
// is data, never markup.

export const FORMAT = "llm-super-bench-run";
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2000;

export const COLORS = {
  bg: "#1e1f21",
  edge: "#34363a",
  ink: "#f1efe4",
  ink2: "#beb9a9",
  muted: "#9a9588",
  grid: "#303236",
  base: "#5e6066",
};

// Six marks that stay apart for most colour-vision types, and each series also gets its own shape.
export const PALETTE = ["#f1a21a", "#2ca1ac", "#d8648f", "#8fb4ff", "#9bcf5a", "#c9b1ff"];
export const SHAPES = ["circle", "square", "diamond", "triangle", "circle", "square"];

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const PRESET_ORDER = ["short", "4k", "8k", "16k", "32k", "64k", "128k"];
/** How a run's machines were asked to sample, for a table cell. Older files did not record it. */
export function samplingText(settings) {
  if (!settings || settings.temperature === null || settings.temperature === undefined) return "not recorded";
  const parts = [`temp ${settings.temperature}`];
  if (settings.topP !== null && settings.topP !== undefined) parts.push(`top_p ${settings.topP}`);
  if (settings.topK !== null && settings.topK !== undefined) parts.push(`top_k ${settings.topK}`);
  return parts.join(", ");
}

export function presetLabel(id) {
  return id === "short" ? "Short" : String(id).toUpperCase();
}
export function presetRank(id) {
  const i = PRESET_ORDER.indexOf(id);
  return i === -1 ? 99 : i;
}

// ---------------------------------------------------------------- what is measured

export const METRICS = [
  { key: "firstWordSec", label: "First word", unit: () => "seconds", lowerBetter: true, digits: 2, note: "Seconds until the first word of the reply. Lower is better." },
  { key: "speed", label: "Speed", unit: (r) => `${r?.speedUnit ?? "tokens/sec"}`, lowerBetter: false, digits: 1, note: "How fast one stream writes. Higher is better." },
  { key: "throughput", label: "Throughput", unit: (r) => `${r?.speedUnit ?? "tokens/sec"}`, lowerBetter: false, digits: 1, note: "Every stream together. Higher is better.", needsStreams: true },
  { key: "promptSpeed", label: "Prompt speed", unit: () => "prompt tokens/sec", lowerBetter: false, digits: 0, note: "Prompt tokens divided by seconds to the first word. Higher is better. Blank when it would be a guess." },
  { key: "efficiency", label: "Efficiency", unit: () => "tokens/sec per watt", lowerBetter: false, digits: 2, note: "Speed divided by the watts you entered. Higher is better." },
  { key: "totalSec", label: "Total time", unit: () => "seconds", lowerBetter: true, digits: 2, note: "Seconds from sending the request to the last word. Lower is better." },
];

// ---------------------------------------------------------------- run files

function text(v, max = 120) {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
}
function finite(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function cleanSpread(s) {
  if (!s || typeof s !== "object") return null;
  const median = finite(s.median);
  if (median === null) return null;
  return { median, min: finite(s.min) ?? median, max: finite(s.max) ?? median };
}

/** Checks a parsed file and keeps only the fields the page uses. Never throws. */
export function readRunFile(raw) {
  if (!raw || typeof raw !== "object" || raw.format !== FORMAT) {
    return { ok: false, error: "This is not an LLM-Super-Bench run file." };
  }
  if (raw.version !== 1) return { ok: false, error: "This file is from a newer version than this page understands." };
  if (!Array.isArray(raw.rows) || raw.rows.length === 0) return { ok: false, error: "This file has no results in it." };
  if (raw.rows.length > MAX_ROWS) return { ok: false, error: "This file has too many rows to be a run file." };

  const rows = [];
  for (const r of raw.rows) {
    if (!r || typeof r !== "object") continue;
    const label = text(r.label, 60);
    const preset = text(r.preset, 12);
    const concurrency = finite(r.concurrency);
    if (label === "" || preset === "" || concurrency === null || concurrency < 1) continue;
    rows.push({
      preset,
      concurrency: Math.floor(concurrency),
      laneId: text(r.laneId, 20),
      label,
      repeats: finite(r.repeats) ?? 1,
      finished: finite(r.finished) ?? 0,
      speedUnit: r.speedUnit === "chunks/sec" ? "chunks/sec" : "tokens/sec",
      firstWordSec: cleanSpread(r.firstWordSec),
      speed: cleanSpread(r.speed),
      throughput: cleanSpread(r.throughput),
      promptSpeed: cleanSpread(r.promptSpeed),
      totalSec: cleanSpread(r.totalSec),
      promptTokens: finite(r.promptTokens),
    });
  }
  if (rows.length === 0) return { ok: false, error: "No usable results were found in this file." };

  const machines = (Array.isArray(raw.machines) ? raw.machines : []).slice(0, 8).map((m) => {
    const s = m && typeof m.setup === "object" && m.setup ? m.setup : {};
    return {
      id: text(m?.id, 20),
      label: text(m?.label, 60),
      model: text(m?.model, 120),
      watts: finite(m?.watts) !== null && m.watts >= 1 && m.watts <= 5000 ? m.watts : null,
      setup: {
        engine: text(s.engine, 40) || null,
        modelFile: text(s.modelFile, 120) || null,
        quant: text(s.quant, 30) || null,
        build: text(s.build, 80) || null,
        slots: finite(s.slots),
        contextPerSlot: finite(s.contextPerSlot),
        notes: text(s.notes, 300) || null,
      },
    };
  });
  const settings = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  return {
    ok: true,
    file: {
      kind: raw.kind === "sweep" ? "sweep" : "race",
      createdAt: text(raw.createdAt, 40),
      complete: raw.complete !== false,
      tool: raw.tool && typeof raw.tool === "object" ? { version: text(raw.tool.version, 20), commit: /^[0-9a-f]{7,40}$/i.test(text(raw.tool.commit, 40)) ? text(raw.tool.commit, 40).toLowerCase() : null } : null,
      settings: {
        maxTokens: finite(settings.maxTokens),
        thinking: ["auto", "low", "off"].includes(settings.thinking) ? settings.thinking : "auto",
        // Older files did not record sampling: null here, shown as "not recorded".
        temperature: finite(settings.temperature),
        topP: finite(settings.topP),
        topK: finite(settings.topK),
      },
      machines,
      rows,
    },
  };
}

/** Speed per watt, from the watts the person entered. One stream uses its speed; several use every stream together. */
function withEfficiency(row, watts) {
  if (watts === null || row.speedUnit !== "tokens/sec") return row;
  const basis = row.concurrency > 1 && row.throughput ? row.throughput : row.speed;
  if (!basis) return row;
  const per = (v) => v / watts;
  return { ...row, efficiency: { median: per(basis.median), min: per(basis.min), max: per(basis.max) } };
}

/**
 * One series per machine per source. A machine that appears in two files stays two series, named
 * apart, so a friend's "Mac Studio" never overwrites yours.
 */
export function buildSeries(sources) {
  const series = [];
  for (const source of sources) {
    const labels = [...new Set(source.file.rows.map((r) => r.label))];
    for (const label of labels) {
      const machine = source.file.machines.find((m) => m.label === label) ?? null;
      series.push({
        key: `${source.name}::${label}`,
        label,
        source: source.name,
        file: source.file,
        machine,
        rows: source.file.rows.filter((r) => r.label === label).map((r) => withEfficiency(r, machine?.watts ?? null)),
      });
    }
  }
  // Names that clash get the source added.
  const count = new Map();
  for (const s of series) count.set(s.label, (count.get(s.label) ?? 0) + 1);
  series.forEach((s, i) => {
    s.display = (count.get(s.label) ?? 0) > 1 ? `${s.label} (${s.source})` : s.label;
    s.color = PALETTE[i % PALETTE.length];
    s.shape = SHAPES[i % SHAPES.length];
  });
  return series;
}

export function cells(series) {
  const sizes = new Set();
  const streams = new Set();
  for (const s of series) for (const r of s.rows) {
    sizes.add(r.preset);
    streams.add(r.concurrency);
  }
  return {
    sizes: [...sizes].sort((a, b) => presetRank(a) - presetRank(b)),
    streams: [...streams].sort((a, b) => a - b),
  };
}

export function rowAt(series, preset, concurrency) {
  return series.rows.find((r) => r.preset === preset && r.concurrency === concurrency && r.finished > 0) ?? null;
}

// ---------------------------------------------------------------- CSV

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
// A leading = + - @ can make a spreadsheet run a cell as a formula, so text from a file gets a quote in front.
const safeText = (v) => (typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

export function rowsToCsv(series) {
  const head = [
    "source", "machine", "prompt_size", "prompt_tokens", "streams", "repeats", "finished", "speed_unit",
    "first_word_median", "first_word_min", "first_word_max",
    "speed_median", "speed_min", "speed_max",
    "throughput_median", "throughput_min", "throughput_max",
    "prompt_speed_median", "prompt_speed_min", "prompt_speed_max",
    "total_median", "total_min", "total_max",
    "engine", "model_file", "quant", "build", "slots", "context_per_slot", "notes", "max_tokens", "thinking", "temperature", "top_p", "top_k", "watts", "speed_per_watt_median", "tool_version", "tool_commit",
  ];
  const out = [head.join(",")];
  const trio = (s) => (s ? [s.median, s.min, s.max] : ["", "", ""]);
  for (const s of series) {
    const setup = s.machine?.setup ?? {};
    for (const r of s.rows) {
      out.push([
        safeText(s.source), safeText(s.label), r.preset, r.promptTokens, r.concurrency, r.repeats, r.finished, r.speedUnit,
        ...trio(r.firstWordSec), ...trio(r.speed), ...trio(r.throughput), ...trio(r.promptSpeed), ...trio(r.totalSec),
        safeText(setup.engine), safeText(setup.modelFile), setup.quant, safeText(setup.build), setup.slots, setup.contextPerSlot, safeText(setup.notes),
        s.file.settings.maxTokens, s.file.settings.thinking,
        s.file.settings.temperature ?? "", s.file.settings.topP ?? "", s.file.settings.topK ?? "",
        s.machine?.watts ?? "", r.efficiency ? r.efficiency.median : "", safeText(s.file.tool?.version ?? ""), s.file.tool?.commit ?? "",
      ].map(csvCell).join(","));
    }
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- scales

function niceMax(v) {
  if (!(v > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function fmt(v, digits) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "no data";
  return v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function shapeMark(shape, x, y, r, color) {
  if (shape === "square") return `<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" fill="${color}"/>`;
  if (shape === "diamond") return `<polygon points="${x},${(y - r * 1.3).toFixed(1)} ${(x + r * 1.3).toFixed(1)},${y} ${x},${(y + r * 1.3).toFixed(1)} ${(x - r * 1.3).toFixed(1)},${y}" fill="${color}"/>`;
  if (shape === "triangle") return `<polygon points="${x},${(y - r * 1.3).toFixed(1)} ${(x + r * 1.2).toFixed(1)},${(y + r).toFixed(1)} ${(x - r * 1.2).toFixed(1)},${(y + r).toFixed(1)}" fill="${color}"/>`;
  return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;
}

function frame(width, height, title, note, body, footer = "") {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(title)}" font-family="${FONT}">` +
    `<rect width="${width}" height="${height}" rx="10" fill="${COLORS.bg}" stroke="${COLORS.edge}"/>` +
    `<text x="20" y="30" font-size="16" font-weight="700" fill="${COLORS.ink}">${esc(title)}</text>` +
    `<text x="20" y="50" font-size="12" fill="${COLORS.muted}">${esc(note)}</text>` +
    body + footer + `</svg>`
  );
}

/** Enough decimals that every tick label is exact: a 10 axis steps by 2.5, so it must not print "3". */
function tickDigits(step) {
  for (let d = 0; d <= 3; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-9) return d;
  return 2;
}

function axis(left, top, right, bottom, max, unit, digits) {
  const parts = [];
  const steps = 4;
  const tickD = tickDigits(max / steps);
  for (let i = 0; i <= steps; i++) {
    const v = (max * i) / steps;
    const y = bottom - ((bottom - top) * i) / steps;
    parts.push(`<line x1="${left}" x2="${right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${i === 0 ? COLORS.base : COLORS.grid}"/>`);
    parts.push(`<text x="${left - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="${COLORS.muted}">${esc(fmt(v, tickD))}</text>`);
  }
  parts.push(`<text x="14" y="${((top + bottom) / 2).toFixed(1)}" font-size="11" fill="${COLORS.muted}" text-anchor="middle" transform="rotate(-90 14 ${((top + bottom) / 2).toFixed(1)})">${esc(unit)}</text>`);
  return parts.join("");
}

// ---------------------------------------------------------------- bar chart: machines side by side

/** bars: [{label, color, value, min, max}] with value null when there is nothing to show. */
export function barChartSvg({ title, note, unit, digits = 1, bars }) {
  const W = 640, H = 340, left = 64, right = 20, top = 70, bottom = 276;
  const peak = Math.max(0, ...bars.map((b) => (b.max ?? b.value ?? 0)));
  const max = niceMax(peak * 1.12);
  const slot = (W - left - right) / Math.max(1, bars.length);
  const barW = Math.min(110, slot * 0.6);
  const y = (v) => bottom - ((bottom - top) * v) / max;
  let body = axis(left, top, W - right, bottom, max, unit, digits);
  bars.forEach((b, i) => {
    const cx = left + slot * i + slot / 2;
    body += `<text x="${cx.toFixed(1)}" y="${bottom + 20}" font-size="12" font-weight="600" text-anchor="middle" fill="${COLORS.ink}">${esc(b.label.length > 22 ? b.label.slice(0, 21) + "…" : b.label)}</text>`;
    if (b.value === null || b.value === undefined) {
      body += `<text x="${cx.toFixed(1)}" y="${bottom - 8}" font-size="12" text-anchor="middle" fill="${COLORS.muted}">no data</text>`;
      return;
    }
    body += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y(b.value).toFixed(1)}" width="${barW.toFixed(1)}" height="${(bottom - y(b.value)).toFixed(1)}" fill="${b.color}"/>`;
    if (b.max !== undefined && b.max !== null && b.min !== undefined && b.min !== null && b.max > b.min) {
      body += `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(b.max).toFixed(1)}" y2="${y(b.min).toFixed(1)}" stroke="${COLORS.ink}" stroke-width="2"/>` +
        `<line x1="${(cx - 7).toFixed(1)}" x2="${(cx + 7).toFixed(1)}" y1="${y(b.max).toFixed(1)}" y2="${y(b.max).toFixed(1)}" stroke="${COLORS.ink}" stroke-width="2"/>` +
        `<line x1="${(cx - 7).toFixed(1)}" x2="${(cx + 7).toFixed(1)}" y1="${y(b.min).toFixed(1)}" y2="${y(b.min).toFixed(1)}" stroke="${COLORS.ink}" stroke-width="2"/>`;
    }
    body += `<text x="${cx.toFixed(1)}" y="${(y(b.max ?? b.value) - 8).toFixed(1)}" font-size="13" font-weight="700" text-anchor="middle" fill="${COLORS.ink}">${esc(fmt(b.value, digits))}</text>`;
  });
  return frame(W, H, title, note, body, `<text x="20" y="${H - 14}" font-size="11" fill="${COLORS.muted}">LLM-Super-Bench · line shows the lowest and highest run</text>`);
}

// ---------------------------------------------------------------- line chart: how a number moves

/** lines: [{label, color, shape, points: [{value,min,max}|null]}]; xLabels names each position. */
export function lineChartSvg({ title, note, unit, digits = 1, xTitle, xLabels, lines }) {
  const legendRows = Math.max(1, Math.ceil(lines.length / 3));
  const W = 640, H = 340 + (legendRows - 1) * 20, left = 64, right = 28, top = 70, bottom = 250;
  const peak = Math.max(0, ...lines.flatMap((l) => l.points.map((p) => (p ? (p.max ?? p.value) : 0))));
  const max = niceMax(peak * 1.12);
  const step = xLabels.length > 1 ? (W - left - right - 20) / (xLabels.length - 1) : 0;
  const x = (i) => (xLabels.length > 1 ? left + 10 + step * i : (left + W - right) / 2);
  const y = (v) => bottom - ((bottom - top) * v) / max;
  let body = axis(left, top, W - right, bottom, max, unit, digits);
  xLabels.forEach((label, i) => {
    body += `<text x="${x(i).toFixed(1)}" y="${bottom + 18}" font-size="12" text-anchor="middle" fill="${COLORS.ink}">${esc(label)}</text>`;
  });
  body += `<text x="${((left + W - right) / 2).toFixed(1)}" y="${bottom + 38}" font-size="11" text-anchor="middle" fill="${COLORS.muted}">${esc(xTitle)}</text>`;
  for (const l of lines) {
    let path = "";
    let pen = false;
    l.points.forEach((p, i) => {
      if (!p) { pen = false; return; }
      path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)} `;
      pen = true;
    });
    if (path) body += `<path d="${path.trim()}" fill="none" stroke="${l.color}" stroke-width="2.5"/>`;
    l.points.forEach((p, i) => {
      if (!p) return;
      if (p.max !== undefined && p.min !== undefined && p.max > p.min) {
        body += `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(p.max).toFixed(1)}" y2="${y(p.min).toFixed(1)}" stroke="${l.color}" stroke-width="1.5" opacity="0.7"/>`;
      }
      body += shapeMark(l.shape, Number(x(i).toFixed(1)), Number(y(p.value).toFixed(1)), 4.5, l.color);
      body += `<text x="${x(i).toFixed(1)}" y="${(y(p.value) - 10).toFixed(1)}" font-size="10" text-anchor="middle" fill="${COLORS.ink2}">${esc(fmt(p.value, digits))}</text>`;
    });
  }
  lines.forEach((l, i) => {
    const lx = 20 + (i % 3) * 205;
    const ly = bottom + 60 + Math.floor(i / 3) * 20;
    body += shapeMark(l.shape, lx + 6, ly - 4, 4.5, l.color);
    body += `<text x="${lx + 18}" y="${ly}" font-size="12" fill="${COLORS.ink}">${esc(l.label.length > 24 ? l.label.slice(0, 23) + "…" : l.label)}</text>`;
  });
  return frame(W, H, title, note, body);
}

import {
  METRICS, barChartSvg, esc, buildSeries, cells, lineChartSvg, memoryText, presetLabel, readRunFile, rowAt, rowsToCsv, samplingText, MAX_FILE_BYTES,
} from "/charts.js";

const $ = (id) => document.getElementById(id);
const el = {
  sources: $("sources"), sourcesNote: $("sources-note"), problem: $("problem"),
  addFile: $("add-file"), fileInput: $("file-input"), json: $("download-json"), csv: $("download-csv"),
  picker: $("picker"), size: $("size"), streams: $("streams"), charts: $("charts"),
  setupsPanel: $("setups-panel"), setups: $("setups"),
  sustainedPanel: $("sustained-panel"), sustained: $("sustained"),
  report: $("download-report"), pageSub: $("page-sub"), modeNote: $("mode-note"), savedRow: $("saved-row"), saved: $("saved-runs"), addSaved: $("add-saved"), versionNote: $("version-note"),
};

let collected = [];
let currentGroup = "";

const sources = []; // { name, file, raw?, removable }
let series = [];
let size = null;
let streams = null;
let serverRaw = null;

// results.html?compare starts empty: only the files you add are drawn, never this server's latest run.
const compareMode = new URLSearchParams(location.search).has("compare");

function download(name, type, data) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "chart";
const day = () => new Date().toISOString().slice(0, 10);

function svgToPng(svgText, name) {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => blob && download(name, "image/png", blob), "image/png");
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function figure(title, svgText) {
  collected.push({ group: currentGroup, title, svg: svgText });
  const fig = document.createElement("figure");
  fig.innerHTML = svgText; // built by charts.js, which escapes every string
  const actions = document.createElement("div");
  actions.className = "fig-actions";
  for (const [label, run] of [
    ["SAVE SVG", () => download(`${slug(title)}.svg`, "image/svg+xml", svgText)],
    ["SAVE PNG", () => svgToPng(svgText, `${slug(title)}.png`)],
  ]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = label;
    b.addEventListener("click", run);
    actions.append(b);
  }
  fig.append(actions);
  return fig;
}

function choiceRow(parent, items, current, onPick) {
  parent.textContent = "";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = item.label;
    b.setAttribute("aria-pressed", String(item.value === current));
    b.addEventListener("click", () => onPick(item.value));
    parent.append(b);
  }
}

function valueOf(row, key) {
  const s = row?.[key];
  return s ? { value: s.median, min: s.min, max: s.max } : null;
}

function group(title, note) {
  currentGroup = title;
  const wrap = document.createElement("div");
  wrap.className = "group";
  const h = document.createElement("h2");
  h.textContent = title;
  wrap.append(h);
  if (note) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = note;
    wrap.append(p);
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  wrap.append(grid);
  return { wrap, grid };
}

function render() {
  series = buildSeries(sources);
  collected = [];
  el.json.disabled = serverRaw === null;
  el.json.hidden = compareMode;
  el.report.disabled = series.length === 0;

  // Files made by different versions of the tool may have been timed by different rules.
  const made = [...new Set(sources.map((s) => s.file.tool?.commit?.slice(0, 7) ?? s.file.tool?.version ?? "").filter(Boolean))];
  const versionText = made.length > 1
    ? `These files were made by different versions of the tool (${made.join(", ")}). Timing rules can differ between versions, so compare with care.`
    : "";
  // Sampling changes speculative-decoding acceptance and so speed: say when the files were sampled differently.
  const sampled = [...new Set(sources.map((s) => samplingText(s.file.settings)))];
  const samplingNote = sampled.length > 1
    ? `These files were sampled differently (${sampled.join("; ")}). Sampling can change speed, so compare with care.`
    : "";
  el.versionNote.textContent = [versionText, samplingNote].filter(Boolean).join(" ");
  el.csv.disabled = series.length === 0;

  el.sources.textContent = "";
  for (const s of sources) {
    const li = document.createElement("li");
    li.append(document.createTextNode(`${s.name} · ${s.file.kind} · ${s.file.createdAt.slice(0, 16).replace("T", " ")}`));
    if (s.removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.title = "Remove this file";
      x.setAttribute("aria-label", `Remove ${s.name}`);
      x.textContent = "×";
      x.addEventListener("click", () => {
        sources.splice(sources.indexOf(s), 1);
        render();
      });
      li.append(x);
    }
    el.sources.append(li);
  }

  el.charts.textContent = "";
  el.picker.hidden = series.length === 0;
  el.setupsPanel.hidden = series.length === 0;
  el.sustainedPanel.hidden = true;
  if (series.length === 0) {
    el.sourcesNote.textContent = compareMode
      ? "Nothing to show yet. Press ADD A RUN FILE and pick the file someone sent you. Add more files to draw them side by side."
      : "Nothing to show yet. Run a race or a sweep on the main page, or add a run file from someone else.";
    return;
  }
  el.sourcesNote.textContent = "";

  const { sizes, streams: streamCounts } = cells(series);
  if (!sizes.includes(size)) size = sizes[0];
  if (!streamCounts.includes(streams)) streams = streamCounts[0];
  choiceRow(el.size, sizes.map((v) => ({ value: v, label: presetLabel(v) })), size, (v) => { size = v; render(); });
  choiceRow(el.streams, streamCounts.map((v) => ({ value: v, label: String(v) })), streams, (v) => { streams = v; render(); });

  // 1. Machines side by side at the picked size and stream count.
  const side = group(
    `SIDE BY SIDE · ${presetLabel(size)} prompt · ${streams} stream${streams === 1 ? "" : "s"} per machine`,
    "The line on a bar is the lowest and highest run, so a spread is never hidden. A machine with no bar had no finished run here.",
  );
  for (const m of METRICS) {
    if (m.needsStreams && streams < 2) continue;
    const rows = series.map((s) => rowAt(s, size, streams));
    if (rows.every((r) => !r?.[m.key])) continue;
    const unit = m.unit(rows.find((r) => r?.[m.key]));
    const title = `${m.label} · ${presetLabel(size)} · ${streams} stream${streams === 1 ? "" : "s"}`;
    side.grid.append(figure(title, barChartSvg({
      title: `${m.label} (${unit})`,
      note: m.note,
      unit,
      digits: m.digits,
      bars: series.map((s, i) => {
        const v = valueOf(rows[i], m.key);
        return { label: s.display, color: s.color, value: v ? v.value : null, min: v?.min, max: v?.max };
      }),
    })));
  }
  if (side.grid.children.length > 0) el.charts.append(side.wrap);

  // 2. How a number changes with prompt size.
  if (sizes.length > 1) {
    const g = group(`BY PROMPT SIZE · ${streams} stream${streams === 1 ? "" : "s"} per machine`, "Each line is one machine. A gap means that size did not finish.");
    for (const m of METRICS) {
      if (m.needsStreams && streams < 2) continue;
      const lines = series.map((s) => ({ label: s.display, color: s.color, shape: s.shape, points: sizes.map((p) => valueOf(rowAt(s, p, streams), m.key)) }));
      if (lines.every((l) => l.points.every((p) => !p))) continue;
      const sample = series.map((s) => rowAt(s, sizes.find((p) => rowAt(s, p, streams)), streams)).find(Boolean);
      const unit = m.unit(sample);
      g.grid.append(figure(`${m.label} by prompt size · ${streams} streams`, lineChartSvg({
        title: `${m.label} by prompt size (${unit})`, note: m.note, unit, digits: m.digits,
        xTitle: "prompt size", xLabels: sizes.map(presetLabel), lines,
      })));
    }
    if (g.grid.children.length > 0) el.charts.append(g.wrap);
  }

  // 3. How a number changes with streams.
  if (streamCounts.length > 1) {
    const g = group(`BY STREAMS · ${presetLabel(size)} prompt`, "How each machine copes as more requests arrive at once.");
    for (const m of METRICS) {
      const lines = series.map((s) => ({ label: s.display, color: s.color, shape: s.shape, points: streamCounts.map((c) => valueOf(rowAt(s, size, c), m.key)) }));
      if (lines.every((l) => l.points.every((p) => !p))) continue;
      const sample = series.map((s) => rowAt(s, size, streamCounts.find((c) => rowAt(s, size, c)))).find(Boolean);
      const unit = m.unit(sample);
      g.grid.append(figure(`${m.label} by streams · ${presetLabel(size)}`, lineChartSvg({
        title: `${m.label} by streams (${unit})`, note: m.note, unit, digits: m.digits,
        xTitle: "streams per machine", xLabels: streamCounts.map(String), lines,
      })));
    }
    if (g.grid.children.length > 0) el.charts.append(g.wrap);
  }

  // Watts were entered but no speed is in tokens: say why there is no efficiency chart.
  const hasWatts = series.some((s) => s.machine?.watts);
  const hasEfficiency = series.some((s) => s.rows.some((r) => r.efficiency));
  if (hasWatts && !hasEfficiency) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "Watts were entered, but speed per watt needs real token counts and these servers only reported streamed chunks, so that chart is left out.";
    el.charts.append(p);
  }

  // Sustained streams, for the sweeps that ran more than one stream count.
  const sustained = sustainedRows();
  el.sustained.textContent = "";
  el.sustainedPanel.hidden = sustained.length === 0;
  if (sustained.length > 0) {
    const top = document.createElement("tr");
    for (const h of SUSTAINED_HEAD) {
      const th = document.createElement("th");
      th.textContent = h;
      top.append(th);
    }
    el.sustained.append(top);
    for (const cells of sustained) {
      const tr = document.createElement("tr");
      for (const v of cells) {
        const td = document.createElement("td");
        td.textContent = String(v);
        tr.append(td);
      }
      el.sustained.append(tr);
    }
  }

  // Setups.
  el.setups.textContent = "";
  const head = document.createElement("tr");
  for (const h of ["MACHINE", "FROM", "ENGINE", "MODEL FILE", "QUANT", "BUILD", "SLOTS", "REPLY LENGTH", "THINKING", "SAMPLING", "WATTS", "NOTES"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  el.setups.append(head);
  for (const s of series) {
    const st = s.machine?.setup ?? {};
    const tr = document.createElement("tr");
    for (const v of [s.display, s.source, st.engine ?? "", st.modelFile ?? s.machine?.model ?? "", st.quant ?? "", st.build ?? "", st.slots ?? "", s.file.settings.maxTokens ?? "", s.file.settings.thinking, samplingText(s.file.settings), s.machine?.watts ?? "", st.notes ?? ""]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.append(td);
    }
    el.setups.append(tr);
  }
}

const SUSTAINED_HEAD = ["MACHINE", "FROM", "PROMPT", "SUSTAINED STREAMS", "WHAT HAPPENED", "PEAK MEMORY AT THAT COUNT"];

/** One line per machine, source and prompt size that a sweep climbed. Shared by the page and the report. */
function sustainedRows() {
  const out = [];
  for (const s of series) {
    for (const u of s.file.sustained ?? []) {
      if (u.label !== s.label) continue;
      // "at least" when nothing failed: the sweep stopped climbing, the machine did not.
      const figure = u.sustained === null ? "none" : u.stoppedAt === null ? `at least ${u.sustained}` : String(u.sustained);
      const at = u.sustained === null ? null : rowAt(s, u.preset, u.sustained);
      out.push([s.display, s.source, presetLabel(u.preset), figure, u.sentence, memoryText(at?.memory ?? null)]);
    }
  }
  return out;
}

/** One self-contained page: charts, setup table, no scripts, nothing fetched. Every string is escaped. */
function buildReport() {
  const when = new Date().toISOString().slice(0, 16).replace("T", " ");
  const groups = [];
  for (const f of collected) {
    let g = groups.find((x) => x.name === f.group);
    if (!g) groups.push((g = { name: f.group, items: [] }));
    g.items.push(f);
  }
  const rows = series.map((s) => {
    const st = s.machine?.setup ?? {};
    const cells = [s.display, s.source, st.engine, st.modelFile ?? s.machine?.model, st.quant, st.build, st.slots, s.file.settings.maxTokens, s.file.settings.thinking, samplingText(s.file.settings), s.machine?.watts ? `${s.machine.watts} W` : "", st.notes];
    return `<tr>${cells.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`;
  }).join("");
  const head = ["MACHINE", "FROM", "ENGINE", "MODEL", "QUANT", "BUILD", "SLOTS", "REPLY LENGTH", "THINKING", "SAMPLING", "WATTS", "NOTES"].map((h) => `<th>${h}</th>`).join("");
  const sustained = sustainedRows();
  const sustainedHtml = sustained.length === 0 ? "" : `<h2>SUSTAINED STREAMS</h2><p class="note">The most streams each machine carried with every run finished and no stream failed. It says nothing about speed.</p><div class="t"><table><tr>${SUSTAINED_HEAD.map((h) => `<th>${h}</th>`).join("")}</tr>${sustained.map((cells) => `<tr>${cells.map((c) => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`).join("")}</table></div>`;
  const body = groups.map((g) => `<h2>${esc(g.name)}</h2><div class="grid">${g.items.map((i) => `<figure>${i.svg}</figure>`).join("")}</div>`).join("");
  const tools = [...new Set(sources.map((s) => (s.file.tool ? `${s.file.tool.version}${s.file.tool.commit ? ` (${s.file.tool.commit.slice(0, 7)})` : ""}` : "")).filter(Boolean))];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>LLM-Super-Bench report</title><style>
body{margin:0;background:#121315;color:#f1efe4;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:1300px;margin:0 auto;padding:20px}h1{margin:0 0 4px}h2{margin:28px 0 6px;font-size:.95rem;letter-spacing:.08em}
.note{color:#a9a79d;font-size:.85rem}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,600px),1fr));gap:14px}
figure{margin:0}svg{max-width:100%;height:auto}.t{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #34363a;vertical-align:top}th{color:#a9a79d;font-size:.72rem;letter-spacing:.08em}
</style></head><body><main><h1>LLM-Super-Bench report</h1>
<p class="note">Made ${esc(when)} from: ${esc(sources.map((s) => s.name).join(", "))}${tools.length ? ` · tool ${esc(tools.join(", "))}` : ""}. Speed per watt uses watts the person entered; it is not measured.</p>
${body}${sustainedHtml}<h2>HOW EACH MACHINE WAS SET UP</h2><div class="t"><table><tr>${head}</tr>${rows}</table></div>
<p class="note">Made with LLM-Super-Bench, based on NetworkChuck's harness (MIT): github.com/reclaimednode/LLM-Super-Bench</p></main></body></html>`;
}

async function loadSaved() {
  try {
    const response = await fetch("/api/runs");
    if (!response.ok) return;
    const { runs } = await response.json();
    if (!Array.isArray(runs) || runs.length === 0) return;
    el.saved.textContent = "";
    for (const r of runs) {
      if (typeof r?.name !== "string") continue;
      const o = document.createElement("option");
      o.value = r.name;
      o.textContent = `${String(r.createdAt).slice(0, 16).replace("T", " ")} · ${r.kind}${r.complete === false ? " (stopped early)" : ""}`;
      el.saved.append(o);
    }
    el.savedRow.hidden = el.saved.options.length === 0;
  } catch {
    /* no saved runs to offer */
  }
}

async function addSavedRun() {
  const name = el.saved.value;
  if (!name || sources.some((s) => s.savedName === name)) return;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(name)}`);
    const result = readRunFile(await response.json());
    if (!result.ok) { el.problem.textContent = `${name}: ${result.error}`; return; }
    addSource(name.replace(/^run-|\.json$/g, ""), result.file, { savedName: name });
    el.problem.textContent = "";
    render();
  } catch {
    el.problem.textContent = "That saved run could not be read.";
  }
}

function addSource(name, file, extra = {}) {
  let unique = name;
  for (let n = 2; sources.some((s) => s.name === unique); n++) unique = `${name} ${n}`;
  sources.push({ name: unique, file, removable: true, ...extra });
}

async function addFiles(fileList) {
  el.problem.textContent = "";
  const problems = [];
  for (const f of fileList) {
    if (f.size > MAX_FILE_BYTES) { problems.push(`${f.name}: too large to be a run file.`); continue; }
    let parsed;
    try {
      parsed = JSON.parse(await f.text());
    } catch {
      problems.push(`${f.name}: not a JSON file.`);
      continue;
    }
    const result = readRunFile(parsed);
    if (!result.ok) { problems.push(`${f.name}: ${result.error}`); continue; }
    addSource(f.name.replace(/\.json$/i, ""), result.file);
  }
  el.problem.textContent = problems.join(" ");
  render();
}

async function boot() {
  if (compareMode) {
    document.title = "LLM-Super-Bench · compare run files";
    el.pageSub.textContent = "COMPARE RUN FILES";
    el.addFile.textContent = "ADD A RUN FILE";
    el.modeNote.textContent = "This tab starts empty and shows only the files you add here. Your own latest run is not included; add it from SAVED ON THIS SERVER below if you want it.";
  }
  try {
    const response = await fetch("/api/last-run");
    if (response.ok) {
      const raw = await response.text();
      const result = readRunFile(JSON.parse(raw));
      if (result.ok) {
        serverRaw = raw;
        if (!compareMode) sources.push({ name: "This server", file: result.file, removable: true });
      }
    }
  } catch {
    /* no run yet, or the server is not reachable */
  }
  render();
}

el.addFile.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  addFiles([...el.fileInput.files]);
  el.fileInput.value = "";
});
el.json.addEventListener("click", () => serverRaw && download(`llm-super-bench-${day()}.json`, "application/json", serverRaw));
el.report.addEventListener("click", () => download(`llm-super-bench-report-${day()}.html`, "text/html", buildReport()));
el.addSaved.addEventListener("click", addSavedRun);
el.csv.addEventListener("click", () => download(`llm-super-bench-${day()}.csv`, "text/csv", rowsToCsv(series)));

boot();
loadSaved();

import {
  METRICS, barChartSvg, buildSeries, cells, lineChartSvg, presetLabel, readRunFile, rowAt, rowsToCsv, MAX_FILE_BYTES,
} from "/charts.js";

const $ = (id) => document.getElementById(id);
const el = {
  sources: $("sources"), sourcesNote: $("sources-note"), problem: $("problem"),
  addFile: $("add-file"), fileInput: $("file-input"), json: $("download-json"), csv: $("download-csv"),
  picker: $("picker"), size: $("size"), streams: $("streams"), charts: $("charts"),
  setupsPanel: $("setups-panel"), setups: $("setups"),
};

const sources = []; // { name, file, raw?, removable }
let series = [];
let size = null;
let streams = null;
let serverRaw = null;

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
  el.json.disabled = serverRaw === null;
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
  if (series.length === 0) {
    el.sourcesNote.textContent = "Nothing to show yet. Run a race or a sweep on the main page, or add a run file from someone else.";
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

  // Setups.
  el.setups.textContent = "";
  const head = document.createElement("tr");
  for (const h of ["MACHINE", "FROM", "MODEL FILE", "QUANT", "BUILD", "SLOTS", "REPLY LENGTH", "THINKING", "NOTES"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }
  el.setups.append(head);
  for (const s of series) {
    const st = s.machine?.setup ?? {};
    const tr = document.createElement("tr");
    for (const v of [s.display, s.source, st.modelFile ?? s.machine?.model ?? "", st.quant ?? "", st.build ?? "", st.slots ?? "", s.file.settings.maxTokens ?? "", s.file.settings.thinking, st.notes ?? ""]) {
      const td = document.createElement("td");
      td.textContent = String(v);
      tr.append(td);
    }
    el.setups.append(tr);
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
  try {
    const response = await fetch("/api/last-run");
    if (response.ok) {
      const raw = await response.text();
      const result = readRunFile(JSON.parse(raw));
      if (result.ok) {
        serverRaw = raw;
        sources.push({ name: "This server", file: result.file, removable: false });
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
el.csv.addEventListener("click", () => download(`llm-super-bench-${day()}.csv`, "text/csv", rowsToCsv(series)));

boot();

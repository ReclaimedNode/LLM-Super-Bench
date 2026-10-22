/*
  The progress page is a display. Every number it shows was measured in the
  bench process and arrived over the event stream; nothing here times anything.

  Lane labels, model names and server messages are user data and are written
  with textContent. Never innerHTML.
*/

const LANE_COLORS = ["var(--lane-1)", "var(--lane-2)", "var(--lane-3)", "var(--lane-4)"];

const el = {
  runName: document.getElementById("run-name"),
  cellsDone: document.getElementById("cells-done"),
  elapsed: document.getElementById("elapsed"),
  remaining: document.getElementById("remaining"),
  actionBar: document.getElementById("action-bar"),
  lanes: document.getElementById("lanes"),
  log: document.getElementById("log"),
};

const laneViews = new Map();
const laneState = new Map();

let startedAtMs = null;
let estimateSec = 0;
let cellsTotal = 0;
let finished = false;

// ------------------------------------------------------------------ helpers

function duration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rest}s`;
  return `${rest}s`;
}

const PHASE_WORDS = {
  waiting: ["waiting", "flat"],
  "starting-server": ["starting server", "running"],
  "awaiting-human": ["needs you", "waiting-human"],
  calibrating: ["sizing prompts", "running"],
  warming: ["warm-up", "running"],
  running: ["measuring", "running"],
  resting: ["resting", "flat"],
  engine: ["engine benchmark", "running"],
  "stopping-server": ["stopping server", "flat"],
  done: ["done", "done"],
  failed: ["failed", "failed"],
};

function logLine(text, kind) {
  const li = document.createElement("li");
  li.textContent = text;
  if (kind && kind !== "info") li.className = kind === "error" ? "bad" : "warn";
  el.log.prepend(li);
  while (el.log.children.length > 200) el.log.lastChild.remove();
}

// ------------------------------------------------------------------ build

function buildLanes(lanes) {
  el.lanes.textContent = "";
  el.lanes.style.setProperty("--lane-count", String(Math.min(lanes.length, 4)));
  laneViews.clear();

  const template = document.getElementById("lane-template");
  lanes.forEach((lane, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--lane-color", LANE_COLORS[index % LANE_COLORS.length]);

    const q = (sel) => node.querySelector(sel);
    q(".lane-label").textContent = lane.laneLabel;
    q(".lane-kind").textContent = lane.managed ? "managed" : "manual";

    laneViews.set(lane.laneLabel, {
      kind: q(".lane-kind"),
      phase: q(".lane-phase"),
      model: q(".lane-model"),
      cell: q(".lane-cell"),
      runs: q(".lane-runs"),
      runsBar: q(".lane-runs-bar"),
      cells: q(".lane-cells"),
      cellsBar: q(".lane-cells-bar"),
      recent: q(".lane-recent"),
    });
    el.lanes.append(node);
    renderLane(lane);
  });
}

function renderLane(lane) {
  laneState.set(lane.laneLabel, lane);
  const view = laneViews.get(lane.laneLabel);
  if (!view) return;

  const [word, cls] = PHASE_WORDS[lane.phase] ?? [lane.phase, "flat"];
  view.phase.textContent = lane.phase === "resting" && lane.restLeftSec > 0 ? `resting ${lane.restLeftSec}s` : word;
  view.phase.className = `mark lane-phase ${cls}`;

  view.model.textContent = lane.currentModel ? `Model: ${lane.currentModel}` : "No model loaded yet";
  view.cell.textContent = lane.currentCell ?? (lane.phase === "done" ? "Finished." : "—");

  view.runs.textContent = `${lane.runsDone} / ${lane.runsInCell}`;
  view.runsBar.style.width = lane.runsInCell > 0 ? `${(lane.runsDone / lane.runsInCell) * 100}%` : "0%";

  view.cells.textContent = `${lane.cellsDone} / ${lane.cellsTotal}`;
  view.cellsBar.style.width = lane.cellsTotal > 0 ? `${(lane.cellsDone / lane.cellsTotal) * 100}%` : "0%";

  view.recent.textContent = "";
  for (const item of lane.recent) {
    const li = document.createElement("li");
    li.textContent = item.text;
    li.className = item.kind;
    view.recent.append(li);
  }

  renderTotals();
  renderAction();
}

function renderTotals() {
  let done = 0;
  for (const lane of laneState.values()) done += lane.cellsDone;
  el.cellsDone.textContent = `${done} / ${cellsTotal}`;

  if (finished) {
    el.remaining.textContent = "done";
    return;
  }
  // The estimate is rough by construction -- it assumes a speed the run has not
  // measured yet -- so once cells are landing it is replaced with the rate the
  // run is actually going at, which is a measurement.
  const elapsed = startedAtMs === null ? 0 : (Date.now() - startedAtMs) / 1000;
  if (done > 0 && done < cellsTotal) {
    el.remaining.textContent = `~${duration((elapsed / done) * (cellsTotal - done))}`;
  } else if (estimateSec > 0) {
    el.remaining.textContent = `~${duration(Math.max(0, estimateSec - elapsed))}`;
  }
}

/** One thing for a human to do, at the top, in plain words. */
function renderAction() {
  const waiting = [...laneState.values()].filter((l) => l.action);
  if (waiting.length === 0) {
    el.actionBar.hidden = true;
    el.actionBar.textContent = "";
    return;
  }
  el.actionBar.hidden = false;
  el.actionBar.textContent = waiting.map((l) => l.action).join("   ·   ");
}

// ------------------------------------------------------------------ events

function onEvent(event) {
  switch (event.type) {
    case "bench-start":
      startedAtMs = Date.now();
      estimateSec = event.estimateSec;
      cellsTotal = event.cellsTotal;
      finished = false;
      el.runName.textContent =
        `${event.runName} — ${event.runsPlanned} runs to do` +
        (event.cellsSkipped > 0 ? `, ${event.cellsSkipped} cells already done and skipped` : "");
      buildLanes(event.lanes);
      logLine(`Grid started: ${event.cellsTotal} cells, ${event.runsPlanned} runs, rough estimate ${duration(event.estimateSec)}.`);
      break;

    case "lane":
      renderLane(event.lane);
      break;

    case "note":
      logLine(event.laneLabel ? `${event.laneLabel}: ${event.message}` : event.message, event.kind);
      break;

    case "cell":
      if (event.stat.status !== "ok") {
        logLine(
          `${event.stat.laneLabel} ${event.stat.nominalLabel}: ${event.stat.status} — ${event.stat.runsUsed} of ${event.stat.runsRecorded} runs used.`,
          "warn",
        );
      }
      break;

    case "bench-done":
      finished = true;
      logLine(`Grid finished in ${duration(event.elapsedSec)}. Results are in results/bench/${event.runName}/.`);
      renderTotals();
      break;
  }
}

// ------------------------------------------------------------------ boot

function tickClock() {
  if (startedAtMs !== null && !finished) {
    el.elapsed.textContent = duration((Date.now() - startedAtMs) / 1000);
    renderTotals();
  }
  setTimeout(tickClock, 500);
}

function listen() {
  const source = new EventSource("/events");
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      /* a frame we cannot parse is not worth stopping the page for */
    }
  };
  source.onerror = () => {
    // The bench process exits when the grid ends; that is not an error worth
    // shouting about once the final event has landed.
    if (!finished) el.runName.textContent = "connection lost — is the bench still running?";
  };
}

tickClock();
listen();

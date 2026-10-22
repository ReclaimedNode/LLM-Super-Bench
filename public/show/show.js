/*
  The page is a display, not a stopwatch. Every second rendered here was
  measured in the bun server process -- the live clock on a monotonic reading
  taken there, the final number by the machine itself -- and arrived over the
  event stream. Nothing here times anything. The one Date in this file writes
  the wall-clock label on a log line, which is a caption, not a measurement.

  All lane labels, prompts and model replies are user data and are written with
  textContent. Never innerHTML.
*/

const el = {
  tests: document.getElementById("tests"),
  start: document.getElementById("start"),
  about: document.getElementById("about"),
  prompt: document.getElementById("prompt"),
  sizes: document.getElementById("sizes"),
  models: document.getElementById("models"),
  lanes: document.getElementById("lanes"),
  scoreboard: document.getElementById("scoreboard"),
  verdict: document.getElementById("verdict"),
  log: document.getElementById("log"),
};

/** laneId -> the bits of DOM we update */
const laneViews = new Map();
/** Every test /api/config offered, by id. */
const tests = new Map();

let selected = null;
let testButtons = [];
let sizeButtons = [];
let modelButtons = [];
let running = false;

/** What this run has come back with so far, for the one log line at the end. */
let runLog = null;

// ------------------------------------------------------------------ helpers

function logLine(text, kind) {
  const li = document.createElement("li");
  li.textContent = text;
  if (kind) li.className = kind;
  el.log.prepend(li);
  while (el.log.children.length > 60) el.log.lastChild.remove();
}

function seconds(value) {
  if (value === null || value === undefined) return "--";
  return value < 10 ? `${value.toFixed(2)}s` : `${value.toFixed(1)}s`;
}

function setStatus(view, text, kind) {
  view.status.textContent = text;
  view.status.className = `lane-status ${kind}`;
}

/** One group of toggle buttons, the same shape as the test buttons. */
function buildChoices(container, choices, onPick) {
  container.textContent = "";
  if (!choices || choices.length === 0) {
    container.hidden = true;
    return [];
  }
  container.hidden = false;
  let picked = choices[0].id;
  const buttons = choices.map((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = choice.label;
    button.setAttribute("aria-pressed", String(choice.id === picked));
    if (choice.note) button.title = choice.note;
    button.addEventListener("click", () => {
      if (running) return;
      picked = choice.id;
      for (const b of buttons) b.setAttribute("aria-pressed", String(b === button));
      onPick(choice.id);
    });
    container.append(button);
    return button;
  });
  onPick(picked);
  return buttons;
}

// ------------------------------------------------------------------ build

function buildLanes(lanes) {
  el.lanes.textContent = "";
  el.lanes.style.setProperty("--lane-count", String(Math.max(lanes.length, 1)));
  laneViews.clear();

  const template = document.getElementById("lane-template");
  for (const lane of lanes) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.style.setProperty("--lane-color", lane.color);

    const q = (sel) => node.querySelector(sel);
    q(".lane-label").textContent = lane.label;

    laneViews.set(lane.laneId, {
      root: node,
      label: lane.label,
      strip: {
        gpu: q(".stat-gpu"),
        gpuWatts: q(".stat-gpu-watts"),
        cpu: q(".stat-cpu"),
        ram: q(".stat-ram"),
        ane: q(".stat-ane"),
        temp: q(".stat-temp"),
      },
      clock: q(".clock"),
      status: q(".lane-status"),
      number: q(".number"),
      numberLabel: q(".number-label"),
      extras: q(".extras"),
      media: q(".media"),
      answer: q(".answer"),
      failure: q(".failure"),
      failureReason: q(".failure-reason"),
      failureLines: q(".failure-lines"),
    });
    el.lanes.append(node);
  }
}

function resetLanes() {
  for (const view of laneViews.values()) {
    view.clock.textContent = "0.00s";
    view.number.textContent = "--";
    view.number.classList.remove("lit");
    view.numberLabel.textContent = "";
    view.extras.textContent = "";
    view.media.textContent = "";
    view.media.hidden = true;
    view.answer.textContent = "";
    view.answer.hidden = true;
    view.failure.hidden = true;
    view.failureReason.textContent = "";
    view.failureLines.textContent = "";
    setStatus(view, "READY", "");
  }
  el.scoreboard.hidden = true;
  el.verdict.textContent = "";
}

/** The test buttons, and everything the picked one needs typed or toggled. */
function buildTests(list) {
  el.tests.textContent = "";
  tests.clear();
  for (const test of list) tests.set(test.id, test);

  testButtons = list.map((test) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = test.label;
    button.title = test.about;
    button.dataset.testId = test.id;
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      if (running) return;
      pickTest(test.id);
    });
    el.tests.append(button);
    return button;
  });

  if (list.length > 0) pickTest(list[0].id);
}

function pickTest(id) {
  const test = tests.get(id);
  if (!test) return;

  // Moving to a different test wipes the last one's numbers, media, answers
  // and verdict. Leaving them there put the previous test's seconds under a
  // new test's name until somebody pressed START, which on camera reads as a
  // result for a test that has not been run. Re-pressing the button already
  // selected changes nothing, so it clears nothing. The results log at the
  // bottom is the run history and is left alone.
  const changed = selected === null || selected.id !== id;
  selected = { id, size: null, model: null };
  if (changed && !running) resetLanes();

  for (const button of testButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.testId === id));
  }

  el.about.textContent = test.about;

  if (test.prompt) {
    el.prompt.hidden = false;
    el.prompt.placeholder = test.prompt.placeholder;
  } else {
    el.prompt.hidden = true;
  }

  // The footage job is a different job at each model size, and the
  // transcription is a different job at each model AND each recording. Both
  // describe themselves that way, so the line under the buttons follows the
  // toggles instead of standing on whichever combination the table lists
  // first. The sizes are built before the models, so the model row's own
  // opening call is the one that lands with both choices known.
  const refreshAbout = () => {
    const byModel = test.aboutByModel;
    const key = selected.size === null ? String(selected.model) : `${selected.model}/${selected.size}`;
    el.about.textContent = (byModel && byModel[key]) || test.about;
  };

  sizeButtons = buildChoices(el.sizes, test.sizes, (choice) => {
    selected.size = choice;
    refreshAbout();
  });
  modelButtons = buildChoices(el.models, test.models, (choice) => {
    selected.model = choice;
    refreshAbout();
  });
}

function setControlsDisabled(disabled) {
  el.start.disabled = disabled;
  for (const b of testButtons) b.disabled = disabled;
  for (const b of sizeButtons) b.disabled = disabled;
  for (const b of modelButtons) b.disabled = disabled;
  el.prompt.disabled = disabled;
}

// ------------------------------------------------------------------ events

function onEvent(event) {
  switch (event.type) {
    case "run-start": {
      runLog = { test: event.testLabel, lanes: new Map(), verdict: null };
      logLine(`${event.testLabel} started on ${event.lanes.map((l) => l.label).join(" and ")}.`);
      break;
    }

    case "lane-start": {
      const view = laneViews.get(event.laneId);
      if (view) setStatus(view, "RUNNING", "running");
      break;
    }

    case "tick":
      for (const lane of event.lanes) {
        const view = laneViews.get(lane.laneId);
        if (view) view.clock.textContent = seconds(lane.elapsedSec);
      }
      break;

    case "lane-done": {
      const view = laneViews.get(event.laneId);
      if (!view) break;
      setStatus(view, "DONE", "done");
      view.clock.textContent = seconds(event.seconds);
      view.number.textContent = event.seconds === null ? "--" : event.seconds.toFixed(1);
      view.number.classList.add("lit");
      view.numberLabel.textContent = event.label;

      view.extras.textContent = "";
      for (const extra of event.extras) {
        const li = document.createElement("li");
        li.textContent = extra;
        view.extras.append(li);
      }

      if (event.media) showMedia(view, event.media);

      if (event.answer && event.answer.length > 0) {
        view.answer.textContent = event.answer.join("\n");
        view.answer.hidden = false;
      }

      if (runLog) runLog.lanes.set(view.label, seconds(event.seconds));
      logLine(`${view.label} finished in ${seconds(event.seconds)}.`, "good");
      break;
    }

    case "lane-failed": {
      const view = laneViews.get(event.laneId);
      if (view) {
        setStatus(view, "FAILED", "failed");
        view.failure.hidden = false;
        view.failureReason.textContent = event.reason;
        view.failureLines.textContent = event.lines.join("\n");
        if (runLog) runLog.lanes.set(view.label, "failed");
      }
      logLine(`${view ? view.label : "The run"}: ${event.reason}`, "bad");
      break;
    }

    case "verdict":
      if (event.line) {
        el.verdict.textContent = event.line;
        el.scoreboard.hidden = false;
        if (runLog) runLog.verdict = event.line;
      }
      break;

    case "run-done":
      writeRunLine();
      break;
  }
}

/** The picture or the clip, inside the lane, at lane width. */
function showMedia(view, media) {
  view.media.textContent = "";
  const node = document.createElement(media.kind === "video" ? "video" : "img");
  if (media.kind === "video") {
    // Muted and looping so it plays on its own while the camera is on it; the
    // control is there for when somebody wants to stop on a frame. Muted is
    // also what lets it start without a click at all.
    node.muted = true;
    node.loop = true;
    node.controls = true;
    node.autoplay = true;
    node.playsInline = true;
    node.preload = "auto";
  } else {
    node.alt = "";
  }
  node.src = media.url;
  view.media.append(node);

  // Under the clip itself, not in a header somewhere: the camera frames one
  // lane at a time, and a licence line that is off screen is a line that was
  // not said. Only the clips owe one.
  if (media.disclosure) {
    const note = document.createElement("p");
    note.className = "disclosure";
    note.textContent = media.disclosure;
    view.media.append(note);
  }

  view.media.hidden = false;
}

/** One line per run in the log at the bottom: when, what, both lanes, the verdict. */
function writeRunLine() {
  if (!runLog) return;
  const when = new Date().toLocaleTimeString();
  const lanes = [...runLog.lanes.entries()].map(([label, value]) => `${label} ${value}`).join(", ");
  const verdict = runLog.verdict ? ` -- ${runLog.verdict}` : "";
  logLine(`${when} - ${runLog.test}: ${lanes}${verdict}`);
  runLog = null;
}

// ------------------------------------------------------------------ strip

/** Dashes in every box, for a lane whose machine is not reporting. */
function clearStrip(view) {
  for (const box of Object.values(view.strip)) box.textContent = "--";
}

/** One reading, in the six boxes under the lane's name. */
function showStats(view, stats) {
  view.strip.gpu.textContent = `${stats.gpuPct}%`;
  view.strip.gpuWatts.textContent = `${stats.gpuWatts.toFixed(1)} W`;
  view.strip.cpu.textContent = `${stats.cpuPct}%`;
  view.strip.ram.textContent = `${stats.ramUsedGb.toFixed(1)} / ${stats.ramTotalGb.toFixed(1)} GB`;
  view.strip.ane.textContent = `${stats.aneWatts.toFixed(1)} W`;
  view.strip.temp.textContent = `${stats.gpuTempC} °C`;
}

/**
 * The strip's own stream, separate from the run's.
 *
 * An EventSource because it reconnects on its own: the page is reloaded and
 * left open for hours on a shoot, and the server counts these connections to
 * decide when to start and stop the readers on the Macs. A lane that stops
 * reporting goes back to dashes rather than freezing on its last number,
 * which would read as a live measurement that is not moving.
 */
function watchStats() {
  const stream = new EventSource("/api/stats");
  stream.addEventListener("message", (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch {
      return;
    }
    const view = laneViews.get(event.laneId);
    if (!view) return;
    if (event.type === "stats") showStats(view, event.stats);
    if (event.type === "stats-gone") clearStrip(view);
  });
}

// ------------------------------------------------------------------ run

async function start() {
  if (running || selected === null) return;
  running = true;
  setControlsDisabled(true);
  el.start.textContent = "RUNNING";
  resetLanes();

  try {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        test: selected.id,
        prompt: el.prompt.value,
        size: selected.size,
        model: selected.model,
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `server returned HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* a frame we cannot parse is not worth stopping the run for */
        }
      }
    }
  } catch (err) {
    logLine(err.message, "bad");
  } finally {
    running = false;
    setControlsDisabled(false);
    el.start.textContent = "START";
  }
}

// ------------------------------------------------------------------ boot

async function boot() {
  const response = await fetch("/api/config");
  const config = await response.json();

  buildLanes(config.lanes);
  buildTests(config.tests);
  resetLanes();
  watchStats();

  el.start.addEventListener("click", start);
  el.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter") start();
  });

  logLine(
    config.lanes.length === 0
      ? "No machines yet."
      : `${config.lanes.length} machines: ${config.lanes.map((l) => l.label).join(", ")}.`,
  );
  if (config.laneError) logLine(config.laneError, "bad");
  if (config.usingExampleConfig) {
    logLine("No bench.config.json found, so the example config is in use. It has no machines in it.", "bad");
  }
}

boot().catch((err) => logLine(`Could not start: ${err.message}`, "bad"));

/*
  The page is a display, not a stopwatch. Every number rendered here was
  measured in the bun server process on a monotonic clock and arrived over the
  event stream. Nothing here calls Date.now() to time anything.

  All lane labels, model names and model replies are user data and are written
  with textContent. Never innerHTML.
*/

const LANE_COLORS = ["#f1a21a", "#c0dcdf", "#c2ba51", "#ca9f43"];

const el = {
  machines: document.getElementById("machines"),
  presets: document.getElementById("presets"),
  streams: document.getElementById("streams"),
  streamsNote: document.getElementById("streams-note"),
  presetsNote: document.getElementById("presets-note"),
  editorPanel: document.getElementById("editor-panel"),
  editorHint: document.getElementById("editor-hint"),
  replyLength: document.getElementById("reply-length"),
  replyNote: document.getElementById("reply-note"),
  thinkingSwitch: document.getElementById("thinking-switch"),
  thinkingNote: document.getElementById("thinking-note"),
  editorRows: document.getElementById("editor-rows"),
  editorSave: document.getElementById("editor-save"),
  editorStatus: document.getElementById("editor-status"),
  machinesPanel: document.getElementById("machines-panel"),
  machineCards: document.getElementById("machine-cards"),
  machineDiffs: document.getElementById("machine-diffs"),
  machineHint: document.getElementById("machine-hint"),
  sweepSizes: document.getElementById("sweep-sizes"),
  sweepStreams: document.getElementById("sweep-streams"),
  sweepRepeats: document.getElementById("sweep-repeats"),
  sweepNote: document.getElementById("sweep-note"),
  sweepStart: document.getElementById("sweep-start"),
  sweepCsv: document.getElementById("sweep-csv"),
  sweepTableWrap: document.getElementById("sweep-table-wrap"),
  sweepHead: document.getElementById("sweep-head"),
  sweepRows: document.getElementById("sweep-rows"),
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  lanes: document.getElementById("lanes"),
  scoreboard: document.getElementById("scoreboard"),
  verdicts: document.getElementById("verdicts"),
  notes: document.getElementById("notes"),
  log: document.getElementById("log"),
};

/** laneId -> the bits of DOM we update */
const laneViews = new Map();
let selectedPreset = "short";
let presetButtons = [];
let racing = false;

// Which machines race: "all" is head to head, anything else is one lane's id.
// "head" races two machines against each other; "solo" runs the first one on its own.
let mode = "head";
let selectedMachine = "all";
let machineButtons = [];
let replyButtons = [];
let thinkingButtons = [];
let currentThinking = "auto";
let currentReply = 512;
let configLanes = [];

// Streams per machine, as chosen, and as the race that is on screen ran them.
let selectedStreams = 1;
let streamButtons = [];
let shownStreams = 1;

// The sweep panel's own choices: which sizes and stream counts to run, and how many times.
let sweepSizeButtons = [];
let sweepStreamButtons = [];
let sweepRepeatButtons = [];
let sweepWarmupButton = null;
const sweepSizes = new Set();
const sweepStreams = new Set([1]);
let sweepWarmup = true;
let sweepRepeats = 3;
let sweepCsvText = null;
let sweepStreamOptions = [1];

function choiceButtons() {
  return [
    ...machineButtons, ...presetButtons, ...streamButtons, ...replyButtons, ...thinkingButtons,
    ...sweepSizeButtons, ...sweepStreamButtons, ...sweepRepeatButtons,
    ...(sweepWarmupButton ? [sweepWarmupButton] : []),
  ];
}

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

// ------------------------------------------------------------------ build

function buildLanes(lanes) {
  el.lanes.textContent = "";
  el.lanes.style.setProperty("--lane-count", String(lanes.length));
  laneViews.clear();

  const template = document.getElementById("lane-template");
  lanes.forEach((lane, index) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const color = LANE_COLORS[index % LANE_COLORS.length];
    node.style.setProperty("--lane-color", color);

    const q = (sel) => node.querySelector(sel);
    q(".lane-label").textContent = lane.label;
    q(".lane-model").textContent = lane.displayModel;

    const view = {
      label: lane.label,
      root: node,
      firstResponseSec: null,
      firstWord: q(".first-word"),
      firstWordField: q(".first-word-field"),
      rate: q(".rate"),
      rateUnit: q(".rate-unit"),
      speedName: q(".speed-name"),
      stats: q(".stats"),
      throughputStat: q(".throughput-stat"),
      throughput: q(".throughput"),
      throughputUnit: q(".throughput-unit"),
      streamNote: q(".stream-note"),
      promptNote: q(".prompt-note"),
      clock: q(".clock"),
      status: q(".lane-status"),
      thinking: q(".thinking"),
      thinkingText: q(".thinking-text"),
      output: q(".output"),
      total: q(".total-value"),
    };
    laneViews.set(lane.laneId, view);
    el.lanes.append(node);
  });
}

function resetLanes() {
  for (const view of laneViews.values()) {
    view.firstResponseSec = null;
    view.firstWord.textContent = "--";
    view.firstWord.classList.remove("lit");
    view.firstWordField.textContent = "";
    view.rate.textContent = "--";
    view.rate.classList.remove("lit");
    view.rateUnit.textContent = "chunks/sec";
    view.throughput.textContent = "--";
    view.throughput.classList.remove("lit");
    view.throughputUnit.textContent = "";
    view.clock.textContent = "0.00s";
    view.thinking.hidden = true;
    view.sawThinking = false;
    view.sawReply = false;
    view.thinkingText.textContent = "";
    view.output.textContent = "";
    view.output.classList.remove("failed");
    view.promptNote.hidden = true;
    view.promptNote.textContent = "";
    view.total.textContent = "--";
    setStatus(view, "READY", "");
  }
  el.scoreboard.hidden = true;
  el.verdicts.textContent = "";
  el.notes.textContent = "";
}

/** Draws the lanes the next race will use and hides the rest. */
function showLanes(laneIds) {
  const visible = laneIds === "all" ? [...laneViews.keys()] : laneIds;
  for (const [laneId, view] of laneViews) view.root.hidden = !visible.includes(laneId);
  el.lanes.style.setProperty("--lane-count", String(Math.max(1, visible.length)));
}

/** One stream is the layout it has always had. Several add the combined number and say whose text is shown. */
function setStreamLayout(streams) {
  shownStreams = streams;
  for (const view of laneViews.values()) {
    const several = streams > 1;
    view.stats.classList.toggle("three", several);
    view.throughputStat.hidden = !several;
    view.speedName.textContent = several ? "SPEED PER STREAM" : "SPEED";
    view.streamNote.hidden = !several;
    view.streamNote.textContent = several
      ? `Showing stream 1 of ${streams}. The numbers above count all ${streams}.`
      : "";
  }
}

/** The unit under SPEED, which with several streams is one stream's median. */
function speedUnitText(unit) {
  return shownStreams > 1 ? `${unit} per stream · median of ${shownStreams}` : unit;
}

function machineIdFor(m) {
  return m === "head" || !configLanes[0] ? "all" : configLanes[0].laneId;
}

/** HEAD TO HEAD or SOLO. The machine rows under MANAGE MACHINES follow this choice. */
function chooseMode(next) {
  mode = next;
  selectedMachine = machineIdFor(mode);
  for (const b of machineButtons) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  showLanes(selectedMachine === "all" ? "all" : [selectedMachine]);
  refreshCapacity();
  refreshMachines();
  updateSweepNote();
  el.editorStatus.textContent = "";
  renderEditorMode();
}

function buildMachines(lanes) {
  configLanes = lanes;
  selectedMachine = machineIdFor(mode);
  el.machines.textContent = "";
  const options = [
    { id: "head", label: "HEAD TO HEAD", title: "two machines race the same prompt at the same instant" },
    { id: "solo", label: "SOLO", title: "one machine on its own, with nothing to race" },
  ];
  machineButtons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.title = option.title;
    button.dataset.mode = option.id;
    button.setAttribute("aria-pressed", String(option.id === mode));
    button.addEventListener("click", () => {
      if (racing) return;
      chooseMode(option.id);
    });
    el.machines.append(button);
    return button;
  });
}

// The stream counts the config allows, used until (and unless) the machines answer.
let configStreamOptions = [1];
// Bumped on every question, so a slow answer about an old selection is dropped.
let capacityAsked = 0;

function selectedLaneIds() {
  return selectedMachine === "all" ? configLanes.map((l) => l.laneId) : [selectedMachine];
}

function formatTokens(n) {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString("en-US");
}

/** One line per machine: what it said, or that it could not. */
function capacityNote(answer) {
  const parts = answer.lanes.map((lane) => {
    if (lane.slots === null) return `${lane.label}: can't tell`;
    const ctx = lane.contextTokens ? `, ${formatTokens(lane.contextTokens)} context` : "";
    return `${lane.label}: ${lane.slots} at once${ctx}`;
  });
  let text = parts.join(" · ");
  if (answer.selection.unknown > 0) {
    text += `. A machine that can't say is not limited here, so more streams than it runs at once would queue and show up as a late first word.`;
  }
  return text;
}

/** Dashes the prompt sizes a machine's reported context looks too small for, and says which machines. */
function markPresetFit(fit) {
  const tightSizes = [];
  const machines = new Set();
  for (const button of presetButtons) {
    const lanes = fit[button.dataset.presetId] ?? [];
    button.classList.toggle("tight", lanes.length > 0);
    if (lanes.length > 0) {
      tightSizes.push(button.textContent);
      lanes.forEach((l) => machines.add(l));
    }
  }
  el.presetsNote.textContent = tightSizes.length === 0
    ? ""
    : `${tightSizes.join(", ")} may not fit in the context ${[...machines].join(" and ")} reports. ` +
      `You can still run them; a prompt that does not fit comes back as an error on that machine.`;
}

/**
 * Asks the selected machines how many requests they run at once and redraws the
 * stream choices to match. If they cannot be asked, the config's choices stay.
 */
async function refreshCapacity() {
  const ask = ++capacityAsked;
  let answer = null;
  try {
    const response = await fetch(`/api/capacity?lanes=${selectedLaneIds().join(",")}`);
    if (response.ok) answer = await response.json();
  } catch {
    answer = null;
  }
  if (ask !== capacityAsked || racing) return;

  if (!answer) {
    el.streamsNote.textContent = "";
    markPresetFit({});
    buildStreams(configStreamOptions);
    return;
  }

  markPresetFit(answer.presetFit ?? {});

  const options = answer.selection.options;
  // Keep the person's choice if it is still offered, else the largest that is.
  selectedStreams = Math.max(...options.filter((n) => n <= selectedStreams), 1);
  buildStreams(options);
  setStreamLayout(selectedStreams);
  el.streamsNote.textContent = capacityNote(answer);
}

/** One toggle button per option; pressing it adds or removes it from `chosen`. */
function toggleButtons(container, options, chosen, label, title, onChange) {
  container.textContent = "";
  return options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label(option);
    button.title = title(option);
    button.setAttribute("aria-pressed", String(chosen.has(option)));
    button.addEventListener("click", () => {
      if (racing) return;
      if (chosen.has(option)) chosen.delete(option);
      else chosen.add(option);
      button.setAttribute("aria-pressed", String(chosen.has(option)));
      onChange();
    });
    container.append(button);
    return button;
  });
}

function buildSweepStreams(options) {
  sweepStreamOptions = options;
  for (const n of [...sweepStreams]) if (!options.includes(n)) sweepStreams.delete(n);
  if (sweepStreams.size === 0) sweepStreams.add(1);
  sweepStreamButtons = toggleButtons(
    el.sweepStreams, options, sweepStreams,
    (n) => String(n), (n) => `${n} request${n === 1 ? "" : "s"} to each machine at once`,
    updateSweepNote,
  );
  updateSweepNote();
}

function buildSweepSizes(presets) {
  sweepSizes.clear();
  // A spread of sizes that finishes in reasonable time. The big ones are one click away.
  for (const id of ["4k", "16k"]) if (presets.some((p) => p.id === id)) sweepSizes.add(id);
  if (sweepSizes.size === 0) sweepSizes.add(presets[0].id);
  const byId = new Map(presets.map((p) => [p.id, p]));
  sweepSizeButtons = toggleButtons(
    el.sweepSizes, presets.map((p) => p.id), sweepSizes,
    (id) => byId.get(id).label, (id) => byId.get(id).targetTokens
      ? `approx ${byId.get(id).targetTokens.toLocaleString("en-US")} tokens`
      : "a short question, no source text",
    updateSweepNote,
  );
}

function buildSweepRepeats() {
  el.sweepRepeats.textContent = "";
  // Warm-up rides on the same row as an on/off choice.
  const warm = document.createElement("button");
  warm.type = "button";
  warm.textContent = "WARM-UP";
  warm.title = "run one short race first and throw it away, so the first measured run is not the one that wakes the model up";
  warm.setAttribute("aria-pressed", String(sweepWarmup));
  warm.addEventListener("click", () => {
    if (racing) return;
    sweepWarmup = !sweepWarmup;
    warm.setAttribute("aria-pressed", String(sweepWarmup));
  });
  sweepWarmupButton = warm;
  sweepRepeatButtons = [1, 3, 5].map((n) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(n);
    button.title = n === 1 ? "one run per cell" : `${n} runs per cell; the table shows the median and the lowest and highest`;
    button.setAttribute("aria-pressed", String(n === sweepRepeats));
    button.addEventListener("click", () => {
      if (racing) return;
      sweepRepeats = n;
      for (const b of sweepRepeatButtons) b.setAttribute("aria-pressed", String(b === button));
      updateSweepNote();
    });
    el.sweepRepeats.append(button);
    return button;
  });
  el.sweepRepeats.append(warm);
}

const SWEEP_MAX_RUNS = 60;

function sweepRunCount() {
  return sweepSizes.size * sweepStreams.size * sweepRepeats;
}

function updateSweepNote() {
  const runs = sweepRunCount();
  const where = selectedMachine === "all" ? "head to head" : "on the machine picked above";
  el.sweepNote.textContent = runs > SWEEP_MAX_RUNS
    ? `${runs} races is more than a sweep runs (${SWEEP_MAX_RUNS}). Take something out.`
    : `${sweepSizes.size} size${sweepSizes.size === 1 ? "" : "s"} × ${sweepStreams.size} stream count${sweepStreams.size === 1 ? "" : "s"} × ${sweepRepeats} = ${runs} races, run one after another ${where}. ` +
      `Big prompts at many streams take a long time; each race is also logged.`;
  el.sweepStart.disabled = racing || runs === 0 || runs > SWEEP_MAX_RUNS;
}

// ------------------------------------------------------------------ reply length and thinking

function kLabel(n) {
  return n >= 1024 && n % 1024 === 0 ? `${n / 1024}K` : String(n);
}

async function changeSetting(change) {
  try {
    const response = await postJson("/api/settings", change);
    const answer = await response.json();
    if (!response.ok) {
      logLine(`Not changed. ${answer.error ?? "The server refused."}`, "bad");
      return false;
    }
    currentReply = answer.maxTokens;
    currentThinking = answer.thinking;
    if (answer.saved === false) logLine("Changed until the server restarts. Save your machines once and it is kept.");
    return true;
  } catch (err) {
    logLine(`Not changed. ${err.message}`, "bad");
    return false;
  }
}

function paintSettings() {
  for (const b of replyButtons) b.setAttribute("aria-pressed", String(Number(b.dataset.tokens) === currentReply));
  for (const b of thinkingButtons) b.setAttribute("aria-pressed", String(b.dataset.thinking === currentThinking));
  el.replyNote.textContent = `Each machine may write up to ${currentReply.toLocaleString("en-US")} tokens.`;
  el.thinkingNote.textContent = currentThinking === "off"
    ? "Every machine is asked not to think. A model whose template ignores this still will."
    : "The model is left as it is. A thinking model can use its whole reply thinking.";
}

function buildSettings(config) {
  currentReply = config.maxTokens;
  currentThinking = config.thinking ?? "auto";
  const lengths = [...new Set([...(config.replyLengths ?? [512]), config.maxTokens])].sort((x, y) => x - y);
  const mk = (parent, items) =>
    items.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.title = item.title;
      if (!editable) {
        button.title = "Changing this needs a password (start the server with RACE_PASSWORD).";
      }
      button.addEventListener("click", async () => {
        if (racing || !editable) return;
        if (await changeSetting(item.change)) {
          paintSettings();
          refreshCapacity();
        }
      });
      button.dataset.tokens = item.tokens ?? "";
      button.dataset.thinking = item.thinking ?? "";
      parent.append(button);
      return button;
    });
  el.replyLength.textContent = "";
  el.thinkingSwitch.textContent = "";
  replyButtons = mk(el.replyLength, lengths.map((n) => ({
    label: kLabel(n), title: `Each machine may write up to ${n} tokens`, tokens: n, change: { maxTokens: n },
  })));
  thinkingButtons = mk(el.thinkingSwitch, [
    { label: "AUTO", title: "leave the model as it is", thinking: "auto", change: { thinking: "auto" } },
    { label: "OFF", title: "ask every machine not to think", thinking: "off", change: { thinking: "off" } },
  ]);
  paintSettings();
}

/** After a race: a machine that only ever thought used its whole reply doing it. Say so, with the way out. */
function warnAboutThinking() {
  const spent = [];
  for (const [, view] of laneViews) {
    if (view.sawThinking && !view.sawReply) spent.push(view.root.querySelector(".lane-label").textContent);
  }
  if (spent.length === 0) return;
  logLine(
    `${spent.join(" and ")} spent the whole reply thinking and never answered, so its speed is thinking speed. ` +
      "Set THINKING to OFF, or pick a longer REPLY LENGTH, and run again.",
    "bad",
  );
}

// ------------------------------------------------------------------ machine editor

let editable = false;
let editorLoaded = false;
const MIN_MACHINES = 2;
const MAX_MACHINES = 4;

/** STOP: asks the server to cut every request off. Retries briefly in case the race is still starting. */
async function stopRun() {
  el.stop.disabled = true;
  el.stop.textContent = "STOPPING...";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch("/api/stop", { method: "POST" });
      if (response.ok) {
        logLine("Stop pressed. Cutting every request off; the machines stop generating when they see the connection close.");
        return;
      }
    } catch {
      /* try again */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  // Nothing was running by then, or the server could not be reached.
  el.stop.disabled = false;
  el.stop.textContent = "STOP";
}

function showStop(on) {
  el.stop.hidden = !on;
  el.stop.disabled = false;
  el.stop.textContent = "STOP";
}

function setEditorBusy(busy) {
  el.editorSave.disabled = busy;
}

function postJson(url, body) {
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** The one line shown under a machine's row after it has been asked. */
function checkText(c) {
  const parts = [
    c.modelFile ?? "model not reported",
    c.quant,
    c.build ? `build ${c.build}` : null,
    c.slots !== null ? `${c.slots} slot${c.slots === 1 ? "" : "s"}` : null,
    c.contextPerSlot !== null ? `${c.contextPerSlot.toLocaleString("en-US")} context per slot` : null,
  ];
  return "Answered: " + parts.filter(Boolean).join(" · ");
}

async function checkRow(row) {
  const address = row.address.value.trim();
  if (address === "") {
    row.status.textContent = "";
    return null;
  }
  row.status.className = "row-status";
  row.status.textContent = "Asking...";
  const ask = (row.asked = (row.asked ?? 0) + 1);
  try {
    const response = await postJson("/api/lanes/check", { baseUrl: address });
    const answer = await response.json();
    if (ask !== row.asked) return null;
    if (answer.ok) {
      row.address.value = answer.address;
      row.status.textContent = checkText(answer);
      return answer;
    }
    row.status.className = "row-status bad";
    row.status.textContent = answer.error ?? "Could not ask this machine.";
  } catch {
    if (ask === row.asked) {
      row.status.className = "row-status bad";
      row.status.textContent = "Could not ask this machine.";
    }
  }
  return null;
}

// Two fixed slots: head to head shows both, solo shows the first. Anything typed in a hidden slot is kept.
let editorSlots = [];
let savedLanes = [];
let editorLoadToken = 0;

/** The streams-at-once box: empty clears it (the machine is asked), a number sets it. */
function slotsOf(row) {
  const text = row.slots.value.trim();
  return text === "" ? null : Number(text);
}

function createSlot(lane, n) {
  const node = document.createElement("div");
  node.className = "editor-row";
  const field = (placeholder, value, label) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value ?? "";
    input.setAttribute("aria-label", label);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("spellcheck", "false");
    return input;
  };
  const row = {
    node,
    name: field(`Machine ${n} name, e.g. Mac Studio`, lane?.label, `Machine ${n} name`),
    address: field("Address, e.g. http://192.168.1.50:8000", lane?.baseUrl, `Machine ${n} address`),
    notes: field("Notes: how it was started (optional)", lane?.notes, `Notes about how machine ${n} was started`),
    slots: field("Streams at once (blank: ask the machine)", lane?.slots ?? "", `Streams machine ${n} runs at once`),
    status: document.createElement("p"),
  };
  row.status.className = "row-status";
  // Asked as soon as the address is entered, not when saving.
  row.address.addEventListener("change", () => checkRow(row));
  node.append(row.name, row.address, row.notes, row.slots, row.status);
  el.editorRows.append(node);
  return row;
}

/** Shows two rows for head to head and one for solo. */
function renderEditorMode() {
  const count = mode === "head" ? 2 : 1;
  editorSlots.forEach((row, i) => {
    row.node.hidden = i >= count;
  });
  if (!editable) return;
  el.editorHint.textContent =
    (mode === "head"
      ? "Head to head: two machines race the same prompt at the same instant. "
      : "Solo: one machine on its own. ") +
    "Each address is asked as soon as you enter it. " +
    "Saving keeps the settings you do not see here (API key, slot count, extra request fields) for a machine you keep.";
}

async function loadEditor() {
  if (!editable) {
    el.editorHint.textContent =
      "Changing machines from this page needs a password, because it lets the page ask any address on your network. " +
      "Stop the server and start it with RACE_PASSWORD=something-long bun run race, then reload.";
    el.editorSave.disabled = true;
    return;
  }
  // Two loads can start together (opening the panel and a reload); only the latest one may draw.
  const token = ++editorLoadToken;
  try {
    const response = await fetch("/api/lanes-config");
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error ?? "not allowed");
    if (token !== editorLoadToken) return;
    savedLanes = answer.lanes;
    el.editorRows.textContent = "";
    editorSlots = [0, 1].map((i) => createSlot(savedLanes[i], i + 1));
    editorSlots.forEach((row, i) => {
      if (savedLanes[i]) checkRow(row);
    });
    editorLoaded = true;
    renderEditorMode();
  } catch (err) {
    if (token === editorLoadToken) el.editorStatus.textContent = `Could not load the machines: ${err.message}`;
  }
}

async function saveEditor() {
  if (racing) return;
  const shown = mode === "head" ? 2 : 1;
  const lanes = editorSlots.slice(0, shown).map((r) => ({
    label: r.name.value.trim(),
    baseUrl: r.address.value.trim(),
    notes: r.notes.value.trim(),
    slots: slotsOf(r),
  }));
  // Solo changes the first machine only. A machine already saved for head to head is kept only if it
  // still answers, so a leftover that is switched off can never block saving the one machine.
  if (mode === "solo") {
    savedLanes.slice(1).forEach((l, i) => {
      const row = editorSlots[i + 1];
      if (row && row.status.textContent.startsWith("Answered")) {
        lanes.push({ label: l.label, baseUrl: l.baseUrl, notes: l.notes ?? "", slots: l.slots ?? null });
      }
    });
  }
  setEditorBusy(true);
  el.editorStatus.textContent = "Asking every machine, then saving...";
  try {
    const response = await postJson("/api/lanes/save", { lanes });
    const answer = await response.json();
    if (!response.ok) {
      el.editorStatus.textContent = `Not saved. ${answer.error ?? "The server refused."}`;
      return;
    }
    el.editorStatus.textContent = mode === "head" ? "Saved. Head to head is ready." : "Saved. The solo machine is ready.";
    logLine(`Machines changed: now testing ${lanes.map((l) => l.label).join(", ")}.`, "good");
    await reloadMachines();
  } catch (err) {
    el.editorStatus.textContent = `Not saved. ${err.message}`;
  } finally {
    setEditorBusy(!editable);
  }
}

/** Redraws everything that depends on which machines there are. */
async function reloadMachines() {
  const config = await (await fetch("/api/config")).json();
  if (config.lanes.length < 2) mode = "solo";
  buildLanes(config.lanes);
  buildMachines(config.lanes);
  resetLanes();
  showLanes(selectedMachine === "all" ? "all" : [selectedMachine]);
  setStreamLayout(selectedStreams);
  updateSweepNote();
  refreshCapacity();
  refreshMachines();
  loadEditor();
}

// ------------------------------------------------------------------ machine details

let machinesAsked = 0;

function tokensText(n) {
  return n === null || n === undefined ? "not reported" : n.toLocaleString("en-US");
}

function detailRows(m) {
  const slotNote = m.slotsSource === "config" ? " (from the config)" : "";
  const perSlot = m.slotContexts && new Set(m.slotContexts).size > 1
    ? m.slotContexts.map(tokensText).join(" / ")
    : tokensText(m.contextPerSlot);
  const parameters = m.parameters ? `${(m.parameters / 1e9).toFixed(1)}B parameters` : null;
  return [
    ["Model file", m.modelFile ?? "not reported"],
    ["Quantization", m.quant ? `${m.quant} (from the file name)` : "not in the file name"],
    ["Size", parameters ?? "not reported"],
    ["Server build", m.build ?? "not reported"],
    ["Slots", m.slots === null ? "not reported" : `${m.slots}${slotNote}`],
    ["Context per slot", perSlot],
    ["Trained context", tokensText(m.trainContext)],
    ["Images", m.vision === null ? "not reported" : m.vision ? "supported" : "not supported"],
    ["Template mentions thinking", m.templateMentionsThinking === null ? "not reported" : m.templateMentionsThinking ? "yes" : "no"],
    ["Notes", m.notes ?? "none in the config"],
  ];
}

function renderMachines(answer) {
  el.machineCards.textContent = "";
  el.machineDiffs.textContent = "";
  for (const m of answer.machines) {
    const card = document.createElement("section");
    card.className = "machine-card";
    const title = document.createElement("h3");
    title.textContent = m.reachable ? m.label : `${m.label} (did not answer)`;
    card.append(title);
    const list = document.createElement("dl");
    for (const [name, value] of detailRows(m)) {
      const dt = document.createElement("dt");
      dt.textContent = name;
      const dd = document.createElement("dd");
      dd.textContent = value;
      list.append(dt, dd);
    }
    card.append(list);
    el.machineCards.append(card);
  }
  for (const text of answer.differences) {
    const li = document.createElement("li");
    li.textContent = text;
    el.machineDiffs.append(li);
  }
  el.machineHint.textContent = answer.differences.length === 0 && answer.machines.length > 1
    ? "Nothing reported differs. The launch flags (-c, -ngl, flash attention, speculative decoding) are not visible to the API; add them as \"notes\" on each lane in race.config.json."
    : "How a server was started (-c, -ngl, flash attention, speculative decoding) is not visible to the API; add it as \"notes\" on each lane in race.config.json.";
}

async function refreshMachines() {
  if (!el.machinesPanel.open) return;
  const ask = ++machinesAsked;
  el.machineHint.textContent = "Asking the machines...";
  try {
    const response = await fetch(`/api/machines?lanes=${selectedLaneIds().join(",")}`);
    const answer = response.ok ? await response.json() : null;
    if (ask !== machinesAsked) return;
    if (answer) renderMachines(answer);
    else el.machineHint.textContent = "The machines could not be asked.";
  } catch {
    if (ask === machinesAsked) el.machineHint.textContent = "The machines could not be asked.";
  }
}

function buildStreams(options) {
  buildSweepStreams(options);
  el.streams.textContent = "";
  streamButtons = options.map((count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(count);
    button.title = count === 1
      ? "one request to each machine"
      : `${count} requests to each machine, all started at the same instant`;
    button.setAttribute("aria-pressed", String(count === selectedStreams));
    button.addEventListener("click", () => {
      if (racing) return;
      selectedStreams = count;
      for (const b of streamButtons) b.setAttribute("aria-pressed", String(b === button));
      setStreamLayout(count);
    });
    el.streams.append(button);
    return button;
  });
}

function buildPresets(presets) {
  el.presets.textContent = "";
  presetButtons = presets.map((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.label;
    button.dataset.presetId = preset.id;
    button.setAttribute("aria-pressed", String(preset.id === selectedPreset));
    const chars = preset.targetChars.toLocaleString("en-US");
    button.title = preset.targetTokens
      ? `approx ${preset.targetTokens.toLocaleString("en-US")} tokens (${chars} characters of source text)`
      : "a short question, no source text";
    button.addEventListener("click", () => {
      if (racing) return;
      selectedPreset = preset.id;
      for (const b of presetButtons) b.setAttribute("aria-pressed", String(b === button));
    });
    el.presets.append(button);
    return button;
  });
}

// ------------------------------------------------------------------ events

function onEvent(event) {
  switch (event.type) {
    case "race-start": {
      const chars = event.promptChars.toLocaleString("en-US");
      const who = event.lanes.length > 1
        ? `head to head, ${event.lanes.map((l) => l.label).join(" vs ")}`
        : `${event.lanes[0].label} on its own`;
      const streams = event.concurrency > 1 ? `, ${event.concurrency} streams per machine` : "";
      logLine(`Race ${event.runId} - ${who}, preset ${event.preset}, prompt ${chars} characters${streams}.`);
      showLanes(event.lanes.map((l) => l.laneId));
      setStreamLayout(event.concurrency);
      break;
    }

    case "preflight":
      logLine(event.message, event.ok ? "good" : "bad");
      break;

    case "lane-blocked": {
      const view = laneViews.get(event.laneId);
      if (view) {
        setStatus(view, "BLOCKED", "failed");
        view.output.textContent = event.message;
        view.output.classList.add("failed");
      }
      break;
    }

    case "lane-start": {
      const view = laneViews.get(event.laneId);
      if (view) setStatus(view, "RUNNING", "running");
      break;
    }

    // The first streamed line, which may carry no text at all. It never
    // touches the FIRST WORD clock -- an instant empty chunk is a response,
    // not a word -- but it is worth showing beside it.
    case "first-response": {
      const view = laneViews.get(event.laneId);
      if (!view) break;
      view.firstResponseSec = event.firstResponseSec;
      view.firstWordField.textContent = `first response ${event.firstResponseSec.toFixed(2)}s`;
      break;
    }

    case "first-word": {
      const view = laneViews.get(event.laneId);
      if (!view) break;
      view.firstWord.textContent = event.firstWordSec.toFixed(2);
      view.firstWord.classList.add("lit");
      // Name the field the text actually came from. A model that streams its
      // thinking first has not said its first word of reply.
      const parts = ["seconds"];
      if (event.field !== "content") parts.push(`(${event.field})`);
      if (event.streams > 1) parts.push(`· median of ${event.streams} streams`);
      if (view.firstResponseSec !== null) parts.push(`· first response ${view.firstResponseSec.toFixed(2)}s`);
      view.firstWordField.textContent = parts.join(" ");
      break;
    }

    case "delta": {
      const view = laneViews.get(event.laneId);
      if (!view) break;
      if (event.field === "content") {
        view.sawReply = true;
        view.output.append(document.createTextNode(event.text));
        view.output.scrollTop = view.output.scrollHeight;
      } else {
        view.thinking.hidden = false;
        view.sawThinking = true;
        view.thinkingText.append(document.createTextNode(event.text));
      }
      break;
    }

    case "tick":
      for (const lane of event.lanes) {
        const view = laneViews.get(lane.laneId);
        if (!view) continue;
        view.clock.textContent = seconds(lane.elapsedSec);
        if (lane.rate !== null) {
          view.rate.textContent = lane.rate.toFixed(1);
          view.rate.classList.add("lit");
          view.rateUnit.textContent = speedUnitText(lane.rateUnit);
        }
        if (lane.streams) {
          if (lane.throughput !== null && lane.throughput !== undefined) {
            view.throughput.textContent = lane.throughput.toFixed(1);
            view.throughput.classList.add("lit");
            view.throughputUnit.textContent = `${lane.rateUnit} · all ${lane.streams.total} together`;
          }
          if (!lane.done) {
            setStatus(view, `RUNNING · ${lane.streams.streaming} of ${lane.streams.total} STREAMING`, "running");
          }
        }
      }
      break;

    case "lane-done": {
      const view = laneViews.get(event.laneId);
      if (!view) break;
      setStatus(view, "DONE", "done");
      view.clock.textContent = seconds(event.totalSec);
      view.total.textContent = seconds(event.totalSec);
      if (event.rate !== null) {
        view.rate.textContent = event.rate.toFixed(1);
        view.rate.classList.add("lit");
      }
      view.rateUnit.textContent = speedUnitText(event.rateUnit);
      if (event.streams > 1 && event.throughput !== null && event.throughput !== undefined) {
        view.throughput.textContent = event.throughput.toFixed(1);
        view.throughput.classList.add("lit");
        view.throughputUnit.textContent = `${event.rateUnit} · all ${event.streams} together`;
      }
      const label = view.root.querySelector(".lane-label").textContent;
      const together = event.streams > 1 ? " across all streams" : "";
      const counted = event.tokens === null
        ? `${event.chunks} chunks${together} (endpoint reported no token usage)`
        : `${event.tokens} tokens, ${event.chunks} chunks${together}`;
      const took = event.streams > 1 ? `finished ${event.streams - event.failedStreams} of ${event.streams} streams` : "finished";
      logLine(`${label} ${took} in ${seconds(event.totalSec)} - ${counted}.`, event.failedStreams > 0 ? "bad" : "good");
      break;
    }

    case "lane-error": {
      const view = laneViews.get(event.laneId);
      if (view) {
        setStatus(view, event.stopped ? "STOPPED" : "FAILED", "failed");
        view.output.textContent = event.message;
        view.output.classList.add("failed");
        view.total.textContent = "--";
      }
      logLine(event.stopped ? `${view ? view.label : "Lane"} stopped.` : `Error: ${event.message}`, event.stopped ? "" : "bad");
      break;
    }

    case "race-done":
      renderScoreboard(event.scoreboard);
      warnAboutThinking();
      break;

    case "sweep-warmup":
      el.sweepStart.textContent = "WARM-UP";
      logLine("Sweep warm-up: one short race that is not counted, so the first measured run is not the one that wakes the model up.");
      break;

    case "sweep-progress":
      el.sweepStart.textContent = `SWEEP ${event.index}/${event.total}`;
      logLine(
        `Sweep ${event.index} of ${event.total} - ${event.preset}, ${event.concurrency} stream${event.concurrency === 1 ? "" : "s"} per machine, run ${event.repeat} of ${event.repeats}.`,
      );
      break;

    case "sweep-done":
      renderSweepTable(event.rows);
      sweepCsvText = event.csv;
      el.sweepCsv.hidden = false;
      logLine(
        event.complete
          ? `Sweep finished${event.savedAs ? `. Table saved as ${event.savedAs}` : ""}.`
          : `${event.stopped ? "Sweep stopped" : "Sweep ended early"}; the table covers the races that finished${event.savedAs ? `, saved as ${event.savedAs}` : ""}. The race that was cut off is not in it.`,
        event.complete ? "good" : "bad",
      );
      break;
  }
}

function renderScoreboard(scoreboard) {
  el.verdicts.textContent = "";
  el.notes.textContent = "";

  // One machine has nothing to be ahead of, so it is a result and not a scoreboard.
  document.getElementById("scoreboard-title").textContent =
    scoreboard.laneRates.length > 1 ? "SCOREBOARD" : "RESULT";

  // Put every lane's SPEED into the one unit the race settled on, so the
  // scoreboard and the lane tiles never show a lane two different numbers.
  for (const { laneId, rate } of scoreboard.laneRates) {
    const view = laneViews.get(laneId);
    if (!view) continue;
    view.rateUnit.textContent = speedUnitText(scoreboard.speedUnit);
    if (rate === null) continue;
    view.rate.textContent = rate.toFixed(1);
    view.rate.classList.add("lit");
  }
  for (const { laneId, rate, promptTokens } of scoreboard.lanePromptSpeeds ?? []) {
    const view = laneViews.get(laneId);
    if (!view || rate === null) continue;
    view.promptNote.textContent =
      `PROMPT TAKEN IN: ${Math.round(rate).toLocaleString("en-US")} tokens/sec (${promptTokens.toLocaleString("en-US")} prompt tokens ÷ time to first word)`;
    view.promptNote.hidden = false;
  }
  for (const { laneId, rate } of scoreboard.laneThroughputs ?? []) {
    const view = laneViews.get(laneId);
    if (!view) continue;
    view.throughputUnit.textContent = `${scoreboard.speedUnit} · all ${scoreboard.concurrency} together`;
    if (rate === null) continue;
    view.throughput.textContent = rate.toFixed(1);
    view.throughput.classList.add("lit");
  }

  for (const entry of scoreboard.entries) {
    const row = document.createElement("div");
    row.className = "verdict";

    const measure = document.createElement("span");
    measure.className = "verdict-measure";
    measure.textContent = entry.measure.toUpperCase();
    row.append(measure);

    if (entry.ratio !== null) {
      const ratio = document.createElement("span");
      ratio.className = "verdict-ratio";
      ratio.textContent = `${entry.ratio.toFixed(1)}x`;
      row.append(ratio);
    }

    const text = document.createElement("span");
    text.className = "verdict-text";
    text.textContent = entry.sentence;
    row.append(text);

    el.verdicts.append(row);
  }

  for (const note of scoreboard.notes) {
    const li = document.createElement("li");
    li.textContent = note;
    el.notes.append(li);
  }

  el.scoreboard.hidden = false;
}

// ------------------------------------------------------------------ run

async function startRace() {
  if (racing) return;
  if (mode === "head" && configLanes.length < 2) {
    logLine("Head to head needs two machines. Add the second one under MANAGE MACHINES, or pick SOLO.", "bad");
    return;
  }
  racing = true;
  setEditorBusy(true);
  showStop(true);
  el.start.disabled = true;
  el.sweepStart.disabled = true;
  el.start.textContent = "RACING";
  for (const b of choiceButtons()) b.disabled = true;
  resetLanes();

  try {
    const response = await fetch("/api/race", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preset: selectedPreset,
        lanes: selectedMachine === "all" ? configLanes.map((l) => l.laneId) : [selectedMachine],
        concurrency: selectedStreams,
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `server returned HTTP ${response.status}`);
    }

    await readEvents(response);
  } catch (err) {
    logLine(`Race failed to run: ${err.message}`, "bad");
  } finally {
    racing = false;
    el.start.disabled = false;
    el.start.textContent = "START";
    for (const b of choiceButtons()) b.disabled = false;
    setEditorBusy(!editable);
    showStop(false);
    updateSweepNote();
  }
}

/** Reads a server-sent event stream to its end, handing each event to onEvent. */
async function readEvents(response) {
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
        /* a frame we cannot parse is not worth stopping the race for */
      }
    }
  }
}

// ------------------------------------------------------------------ sweep

async function startSweep() {
  if (racing) return;
  if (mode === "head" && configLanes.length < 2) {
    logLine("Head to head needs two machines. Add the second one under MANAGE MACHINES, or pick SOLO.", "bad");
    return;
  }
  const runs = sweepRunCount();
  if (runs === 0 || runs > SWEEP_MAX_RUNS) return;

  racing = true;
  setEditorBusy(true);
  showStop(true);
  el.start.disabled = true;
  el.sweepStart.disabled = true;
  el.sweepCsv.hidden = true;
  el.sweepTableWrap.hidden = true;
  sweepCsvText = null;
  for (const b of choiceButtons()) b.disabled = true;
  resetLanes();

  try {
    const response = await fetch("/api/sweep", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lanes: selectedLaneIds(),
        // In the order the buttons are drawn, small to large.
        presets: [...sweepSizes].sort((a, b) => presetOrder(a) - presetOrder(b)),
        concurrencies: [...sweepStreams].sort((a, b) => a - b),
        repeats: sweepRepeats,
        warmup: sweepWarmup,
      }),
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `server returned HTTP ${response.status}`);
    }
    await readEvents(response);
  } catch (err) {
    logLine(`Sweep failed to run: ${err.message}`, "bad");
  } finally {
    racing = false;
    el.start.disabled = false;
    el.sweepStart.textContent = "RUN SWEEP";
    for (const b of choiceButtons()) b.disabled = false;
    setEditorBusy(!editable);
    showStop(false);
    updateSweepNote();
  }
}

function presetOrder(id) {
  return presetButtons.findIndex((b) => b.dataset.presetId === id);
}

function spreadText(s, digits) {
  if (!s) return "--";
  const f = (n) => n.toFixed(digits);
  return s.min === s.max ? f(s.median) : `${f(s.median)} (${f(s.min)}-${f(s.max)})`;
}

const SWEEP_COLUMNS = ["SIZE", "STREAMS", "MACHINE", "FIRST WORD (s)", "SPEED", "ALL STREAMS", "PROMPT TOK/S", "TOTAL (s)", "RUNS"];

function renderSweepTable(rows) {
  el.sweepHead.textContent = "";
  el.sweepRows.textContent = "";

  const head = document.createElement("tr");
  for (const name of SWEEP_COLUMNS) {
    const th = document.createElement("th");
    th.textContent = name;
    head.append(th);
  }
  el.sweepHead.append(head);

  for (const r of rows) {
    const unit = r.speedUnit === "tokens/sec" ? "tok/s" : "chunks/s";
    const cells = [
      r.preset,
      String(r.concurrency),
      r.label,
      spreadText(r.firstWordSec, 2),
      r.speed ? `${spreadText(r.speed, 1)} ${unit}` : "--",
      r.throughput ? `${spreadText(r.throughput, 1)} ${unit}` : "--",
      r.promptSpeed ? Math.round(r.promptSpeed.median).toLocaleString("en-US") : "--",
      spreadText(r.totalSec, 1),
      `${r.finished}/${r.repeats}`,
    ];
    const tr = document.createElement("tr");
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    el.sweepRows.append(tr);
  }
  el.sweepTableWrap.hidden = false;
}

function downloadSweepCsv() {
  if (!sweepCsvText) return;
  const blob = new Blob([sweepCsvText], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `llm-super-bench-sweep-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ------------------------------------------------------------------ boot

async function boot() {
  const response = await fetch("/api/config");
  const config = await response.json();

  mode = config.lanes.length >= 2 ? "head" : "solo";
  buildLanes(config.lanes);
  buildMachines(config.lanes);
  editable = config.editable === true;
  buildSettings(config);
  buildPresets(config.presets);
  buildSweepSizes(config.presets);
  buildSweepRepeats();
  configStreamOptions = config.concurrencyOptions ?? [1];
  buildStreams(configStreamOptions);
  resetLanes();
  showLanes(selectedMachine === "all" ? "all" : [selectedMachine]);
  setStreamLayout(1);

  el.start.addEventListener("click", startRace);
  el.stop.addEventListener("click", stopRun);
  el.sweepStart.addEventListener("click", startSweep);
  el.machinesPanel.addEventListener("toggle", refreshMachines);
  editable = config.editable === true;
  el.editorPanel.addEventListener("toggle", () => {
    if (el.editorPanel.open && !editorLoaded) loadEditor();
  });
  el.editorSave.addEventListener("click", saveEditor);
  // First run on the built-in mock machines: take the person straight to entering their own.
  if (config.usingExampleConfig && editable) {
    el.editorPanel.open = true;
    loadEditor();
  }
  el.sweepCsv.addEventListener("click", downloadSweepCsv);
  // Not awaited: a machine that is down must not hold the page up.
  refreshCapacity();

  logLine(
    `${config.lanes.length} lanes loaded. Replies are capped at ${config.maxTokens} tokens. Prompt source: ${config.promptFile}.`,
  );
  if (config.usingExampleConfig) {
    logLine("No race.config.json found, so the example config is in use. It points at the mock lanes (bun run mock).");
  }
  if (config.sourceError) {
    logLine(config.sourceError, "bad");
  }
}

boot().catch((err) => logLine(`Could not start: ${err.message}`, "bad"));

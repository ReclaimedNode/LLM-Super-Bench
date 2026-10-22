/*
  The power page. It has one job: tell the person holding the meter what to do,
  and take the number they read off it.

  Nothing here measures anything. The watts are typed in by a human, and every
  place they later appear says so.
*/

const el = {
  progress: document.getElementById("progress"),
  lane: document.getElementById("lane"),
  laneKind: document.getElementById("lane-kind"),
  action: document.getElementById("action"),
  countdown: document.getElementById("countdown"),
  countdownValue: document.getElementById("countdown-value"),
  form: document.getElementById("reading-form"),
  watts: document.getElementById("watts"),
  skip: document.getElementById("skip"),
  readingsBody: document.getElementById("readings-body"),
};

let phase = "working";
let sending = false;
/**
 * The reading this page has already answered.
 *
 * The runner takes a moment to move on after a number is sent, and the page
 * refreshes twice a second, so without this the form reappears under the
 * person's hands while the same question is still on screen. A second number
 * typed into it would either be dropped or -- if the runner had just moved on
 * -- be recorded against the NEXT machine.
 */
let answered = -1;

let currentIndex = 0;

function render(state) {
  phase = state.phase;
  currentIndex = state.index;

  el.progress.textContent =
    state.phase === "done" ? "finished" : `reading ${Math.min(state.index + 1, state.total)} of ${state.total}`;
  el.lane.textContent = state.laneLabel || "—";
  el.laneKind.textContent = state.modelName ? state.modelName : state.kind === "idle" ? "idle reading" : "lane";

  el.action.textContent = state.action;
  el.action.className = `action${state.phase === "reading" ? " now" : ""}${state.phase === "done" ? " done" : ""}`;

  const counting = state.phase === "settling" && state.secondsLeft > 0;
  el.countdown.hidden = !counting;
  if (counting) el.countdownValue.textContent = String(state.secondsLeft);

  const asking = state.phase === "reading" && state.index !== answered;
  if (el.form.hidden === asking) {
    el.form.hidden = !asking;
    if (asking) {
      el.watts.value = "";
      el.watts.focus();
    }
  }

  el.readingsBody.textContent = "";
  for (const reading of state.taken) {
    const tr = document.createElement("tr");
    for (const value of [
      reading.laneLabel,
      reading.modelName ?? "—",
      reading.kind === "idle" ? "idle" : "under load",
      `${reading.watts} W`,
      reading.holdSeconds > 0 ? `${reading.holdSeconds}s` : "—",
    ]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.append(td);
    }
    el.readingsBody.append(tr);
  }
}

async function send(body) {
  if (sending || phase !== "reading") return;
  sending = true;
  try {
    const response = await fetch("/reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      el.action.textContent = detail.error ?? "That reading was not accepted. Try again.";
      return;
    }
    // The next state arrives on the stream; this reading is answered, so the
    // form stays away until the runner asks a different question.
    answered = currentIndex;
    el.form.hidden = true;
  } finally {
    sending = false;
  }
}

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  send({ watts: Number(el.watts.value) });
});

el.skip.addEventListener("click", () => send({ skip: true }));

const source = new EventSource("/events");
source.onmessage = (message) => {
  try {
    render(JSON.parse(message.data));
  } catch {
    /* a frame we cannot parse is not worth stopping the page for */
  }
};
source.onerror = () => {
  if (phase !== "done") el.progress.textContent = "connection lost — is the power pass still running?";
};

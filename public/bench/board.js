/*
  The results board. Every chart is SVG built here by hand -- no library, no
  CDN, no network request of any kind beyond /api/board on this same server.

  Every number was worked out in the bench process and shaped in src/bench/
  board.ts. This file multiplies by a pixel scale and draws. Lane labels, model
  names and server messages are user data: textContent, never innerHTML.
*/

import { placeColumnLabels } from "/labels.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Label placement needs the real width of rendered text, which only exists
 * once the chart is in the document. Each line chart leaves its placement job
 * here; render() runs them all after the page is built.
 */
const pendingLabelJobs = [];

const el = {
  runName: document.getElementById("run-name"),
  legend: document.getElementById("legend"),
  warnings: document.getElementById("warnings"),
  models: document.getElementById("models"),
  footer: document.getElementById("footer"),
};

// ------------------------------------------------------------------ helpers

function tag(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(name, attrs = {}) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function svgText(text, attrs, className) {
  const node = svg("text", attrs);
  if (className) node.setAttribute("class", className);
  node.textContent = text;
  return node;
}

/** 1234 -> "1,234"; 12.3 -> "12.3"; 0.26 -> "0.26". */
function number(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value).toLocaleString("en-US");
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function seconds(value) {
  if (value === null || value === undefined) return "—";
  return value < 10 ? `${value.toFixed(2)}s` : `${value.toFixed(1)}s`;
}

/**
 * Labels at the ends of an axis anchor inward, so a wide one cannot hang off
 * the edge of the chart whatever the type size is set to.
 */
function anchorFor(index, count) {
  if (count > 1 && index === 0) return "start";
  if (count > 1 && index === count - 1) return "end";
  return "middle";
}

/**
 * An axis tick, written the way a person reads one: "0", "200", "2.5".
 *
 * Never "0.00" on a tokens-per-second axis. The tick VALUES are chosen in
 * src/bench/board.ts, where they can be tested; this only writes them down.
 */
function tickLabel(value) {
  if (value === 0) return "0";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return String(Number(value.toFixed(2)));
}

// ------------------------------------------------------------------ bar chart

const BAR = {
  width: 520,
  height: 260,
  padTop: 18,
  padBottom: 42,
  padLeft: 56,
  padRight: 14,
};

/**
 * One chart: a column per lane, the median printed on the column, and a thin
 * low-to-high mark through it.
 *
 * The mark is the point of the chart as much as the column is. Five runs that
 * all landed within a hair of each other and five that were all over the place
 * produce the same median, and only the mark tells them apart.
 */
function barChart(chart) {
  const max = chart.max;
  const plotW = BAR.width - BAR.padLeft - BAR.padRight;
  const plotH = BAR.height - BAR.padTop - BAR.padBottom;
  const baseY = BAR.padTop + plotH;
  const y = (value) => baseY - (value / max) * plotH;

  const root = svg("svg", {
    viewBox: `0 0 ${BAR.width} ${BAR.height}`,
    role: "img",
    "aria-label": `${chart.measure} speed in ${chart.unit}`,
  });

  for (const value of chart.ticks) {
    const gy = y(value);
    root.append(svg("line", { x1: BAR.padLeft, x2: BAR.width - BAR.padRight, y1: gy, y2: gy, class: "svg-grid" }));
    root.append(svgText(tickLabel(value), { x: BAR.padLeft - 8, y: gy + 4, "text-anchor": "end" }, "svg-axis"));
  }

  const slot = plotW / Math.max(1, chart.bars.length);
  const barW = Math.min(slot * 0.56, 110);

  chart.bars.forEach((bar, index) => {
    const cx = BAR.padLeft + slot * (index + 0.5);
    const x = cx - barW / 2;

    root.append(svgText(bar.laneLabel, { x: cx, y: BAR.height - 22, "text-anchor": "middle" }, "svg-lane"));

    if (bar.median === null) {
      // No number is drawn as no bar, with the reason under it. A zero-height
      // bar would read as "slow" when it means "we do not know".
      root.append(
        svgText(bar.marks.join(", ") || "no data", { x: cx, y: baseY - 8, "text-anchor": "middle" }, "svg-mark"),
      );
      root.append(svgText("—", { x: cx, y: BAR.height - 6, "text-anchor": "middle" }, "svg-axis"));
      return;
    }

    const top = y(bar.median);
    root.append(
      svg("rect", {
        x,
        y: top,
        width: barW,
        height: Math.max(1, baseY - top),
        fill: `var(${bar.colorVar})`,
      }),
    );

    // The low-to-high mark, drawn over the bar in the sunk colour so it reads
    // on top of it rather than beside it.
    if (bar.low !== null && bar.high !== null && bar.high > bar.low) {
      const markX = cx;
      const capW = Math.min(barW * 0.42, 22);
      root.append(
        svg("path", {
          d:
            `M ${markX - capW / 2} ${y(bar.high)} H ${markX + capW / 2} ` +
            `M ${markX} ${y(bar.high)} V ${y(bar.low)} ` +
            `M ${markX - capW / 2} ${y(bar.low)} H ${markX + capW / 2}`,
          class: "svg-range",
        }),
      );
    }

    // The value goes inside the bar when it fits and above it when it does not,
    // so a short bar's number is never sitting on a dark background it cannot
    // be read against.
    const fitsInside = baseY - top > 34;
    root.append(
      svgText(
        number(bar.median),
        { x: cx, y: fitsInside ? top + 24 : top - 8, "text-anchor": "middle" },
        fitsInside ? "svg-value" : "svg-value outside",
      ),
    );

    if (bar.marks.length > 0) {
      root.append(svgText(bar.marks.join(", "), { x: cx, y: BAR.height - 6, "text-anchor": "middle" }, "svg-mark"));
    }
  });

  root.append(
    svg("line", { x1: BAR.padLeft, x2: BAR.width - BAR.padRight, y1: baseY, y2: baseY, class: "svg-baseline" }),
  );
  return root;
}

// ------------------------------------------------------------------ line chart

const LINE = {
  width: 1080,
  height: 320,
  padTop: 20,
  padBottom: 48,
  padLeft: 64,
  padRight: 24,
};

/**
 * The wait for the first word, in SECONDS, against prompt size.
 *
 * The x axis is the prompt sizes in order, evenly spaced, not to scale: the
 * sizes are chosen points, not a continuum, and spacing them by token count
 * would crush 512 and 4K into the left margin where nobody could read them.
 */
function lineChart(chart) {
  const max = chart.maxY;
  const plotW = LINE.width - LINE.padLeft - LINE.padRight;
  const plotH = LINE.height - LINE.padTop - LINE.padBottom;
  const baseY = LINE.padTop + plotH;
  const count = Math.max(1, chart.xLabels.length);
  const x = (index) => LINE.padLeft + (count === 1 ? plotW / 2 : (plotW * index) / (count - 1));
  const y = (value) => baseY - (value / max) * plotH;

  const root = svg("svg", {
    viewBox: `0 0 ${LINE.width} ${LINE.height}`,
    role: "img",
    "aria-label": "Wait for the first word, in seconds, against prompt size",
  });

  for (const value of chart.ticks) {
    const gy = y(value);
    root.append(svg("line", { x1: LINE.padLeft, x2: LINE.width - LINE.padRight, y1: gy, y2: gy, class: "svg-grid" }));
    root.append(svgText(`${tickLabel(value)}s`, { x: LINE.padLeft - 10, y: gy + 4, "text-anchor": "end" }, "svg-axis"));
  }

  chart.xLabels.forEach((label, index) => {
    root.append(svgText(label, { x: x(index), y: LINE.height - 22, "text-anchor": "middle" }, "svg-lane"));
  });
  root.append(
    svgText("prompt size", { x: LINE.padLeft + plotW / 2, y: LINE.height - 4, "text-anchor": "middle" }, "svg-axis"),
  );

  // Everything a label must not sit on: the lines and the dots of every lane,
  // not only the other labels.
  const segments = [];
  const dots = [];

  for (const series of chart.series) {
    const drawn = series.points.filter((p) => p.y !== null);
    if (drawn.length > 1) {
      root.append(
        svg("polyline", {
          points: drawn.map((p) => `${x(p.x)},${y(p.y)}`).join(" "),
          fill: "none",
          stroke: `var(${series.colorVar})`,
          "stroke-width": 4,
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        }),
      );
      for (let i = 1; i < drawn.length; i++) {
        segments.push({
          x1: x(drawn[i - 1].x),
          y1: y(drawn[i - 1].y),
          x2: x(drawn[i].x),
          y2: y(drawn[i].y),
        });
      }
    }
    for (const point of drawn) {
      root.append(svg("circle", { cx: x(point.x), cy: y(point.y), r: 6, fill: `var(${series.colorVar})` }));
      dots.push({ cx: x(point.x), cy: y(point.y), r: 6 });
    }
  }

  root.append(
    svg("line", { x1: LINE.padLeft, x2: LINE.width - LINE.padRight, y1: baseY, y2: baseY, class: "svg-baseline" }),
  );

  // Each label is drawn in its own lane's colour and created now so it can be
  // measured, but it is not POSITIONED until the chart is in the document and
  // the real width of the text is known. A number on the wrong line is worse
  // than no number, and guessing a text width is how that happens.
  const leaders = svg("g", {});
  root.append(leaders);

  const jobs = [];
  for (let index = 0; index < count; index++) {
    const anchor = anchorFor(index, count);
    const column = [];

    chart.series.forEach((series, laneIndex) => {
      const point = series.points[index];
      if (!point || point.y === null) return;
      const node = svgText(seconds(point.y), { x: x(index), y: y(point.y), "text-anchor": anchor }, "svg-value");
      // Inline, not a `fill` attribute: a stylesheet rule beats a presentation
      // attribute, and `.svg-value` sets a fill of its own.
      node.style.fill = `var(${series.colorVar})`;
      root.append(node);
      column.push({
        id: `${index}-${laneIndex}`,
        node,
        colorVar: series.colorVar,
        px: x(index),
        py: y(point.y),
        anchor,
      });
    });

    if (column.length > 0) jobs.push(column);
  }

  const bounds = {
    minX: 2,
    minY: 2,
    maxX: LINE.width - 2,
    maxY: baseY - 2,
  };

  pendingLabelJobs.push(() => {
    for (const column of jobs) {
      const measured = column.map((item) => {
        const box = item.node.getBBox();
        return { ...item, width: box.width, height: box.height, dyTop: box.y - item.py };
      });

      for (const placed of placeColumnLabels(measured, { segments, dots }, bounds)) {
        const item = column.find((c) => c.id === placed.id);
        item.node.setAttribute("y", String(placed.baselineY));

        // A label pushed clear of the fan needs something tying it back to the
        // point it belongs to, or it is just a number floating near two lines.
        if (!placed.needsLeader) continue;
        const endY = placed.side === "above" ? placed.rect.y + placed.rect.height : placed.rect.y;
        leaders.append(
          svg("line", {
            x1: item.px,
            y1: item.py,
            x2: item.px,
            y2: endY,
            stroke: `var(${item.colorVar})`,
            "stroke-width": 1.5,
            opacity: 0.75,
          }),
        );
      }
    }
  });

  return root;
}

// ------------------------------------------------------------------ tables

function dataTable(header, rows) {
  const table = tag("table", "data-table");
  const thead = document.createElement("thead");
  const hrow = document.createElement("tr");
  for (const h of header) hrow.append(tag("th", null, h));
  thead.append(hrow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const cellValue of row) {
      const td = tag("td", null, typeof cellValue === "string" ? cellValue : cellValue.text);
      if (typeof cellValue !== "string" && cellValue.unavailable) td.className = "unavailable";
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  return table;
}

// ------------------------------------------------------------------ sections

function chartBlock(chart, titleText) {
  const block = tag("div", "chart");
  block.append(tag("h4", `chart-title ${chart.measure}`, titleText));
  block.append(barChart(chart));
  return block;
}

function sizeRow(row, lanes) {
  const section = tag("section", "size-row");

  const head = tag("div", "size-head");
  head.append(tag("span", "size-label", row.nominalLabel));
  const trueCounts = row.truePromptTokens
    .map((t, i) => (t === null ? null : `${lanes[i].label} read ${Math.round(t).toLocaleString("en-US")}`))
    .filter(Boolean)
    .join(" · ");
  head.append(
    tag(
      "span",
      "size-sub",
      `${row.nominalTokens.toLocaleString("en-US")} tokens asked for${trueCounts ? ` — ${trueCounts}` : ""}`,
    ),
  );
  if (row.torture) head.append(tag("span", "mark warn", "torture · 1 run"));
  section.append(head);

  const twin = tag("div", "twin");
  twin.append(chartBlock(row.reading, `Reading — ${row.reading.unit}`));
  twin.append(chartBlock(row.writing, `Writing — ${row.writing.unit}`));
  section.append(twin);

  if (row.notes.length > 0) {
    const list = tag("ul", "cell-notes");
    for (const note of row.notes) list.append(tag("li", null, note));
    section.append(list);
  }
  return section;
}

function engineSection(engine) {
  const section = tag("section", "size-row");
  const head = tag("div", "size-head");
  head.append(tag("span", "size-label", "Engine"));
  head.append(
    tag(
      "span",
      "size-sub",
      "the engine's own benchmark on the machine — no server, no chat template, no network. Median of its trials, worked out here; the tool prints a mean.",
    ),
  );
  section.append(head);

  section.append(
    dataTable(
      ["Lane", "Prompt", "Reads (tok/s)", "Writes (tok/s)", "Peak memory", "Trials"],
      engine.map((e) =>
        e.unavailable
          ? [
              e.laneLabel,
              e.nominalLabel,
              { text: `not available — ${e.unavailable}`, unavailable: true },
              "—",
              "—",
              "0",
            ]
          : [
              e.laneLabel,
              e.nominalLabel,
              `${number(e.readMedian)} (${number(e.readLow)}–${number(e.readHigh)})`,
              `${number(e.writeMedian)} (${number(e.writeLow)}–${number(e.writeHigh)})`,
              e.peakMemoryGb === null ? "—" : `${e.peakMemoryGb.toFixed(2)} GB`,
              String(e.trials),
            ],
      ),
    ),
  );
  return section;
}

function powerSection(power) {
  const section = tag("section", "size-row");
  const head = tag("div", "size-head");
  head.append(tag("span", "size-label", "Power"));
  head.append(tag("span", "size-sub", "wall meter, read by hand"));
  section.append(head);

  section.append(
    dataTable(
      ["Lane", "Under load", "Idle", "Tokens per watt", "Held for"],
      power.map((p) => [
        p.laneLabel,
        p.loadWatts === null ? "—" : `${Math.round(p.loadWatts)} W`,
        p.idleWatts === null ? "—" : `${Math.round(p.idleWatts)} W`,
        p.tokensPerWatt === null ? "—" : p.tokensPerWatt.toFixed(3),
        p.holdSeconds === null ? "—" : `${p.holdSeconds}s`,
      ]),
    ),
  );
  return section;
}

/**
 * The image section: seconds per image per lane, and the pictures themselves.
 *
 * The pictures are the proof, not decoration. Every lane drew from one seed, so
 * they should be the same image; showing them lets a viewer check that instead
 * of taking it on trust, and a checksum that differs is said out loud.
 */
function imagesSection(images) {
  const section = tag("section", "model");
  section.append(tag("div", "model-rule"));

  const head = tag("div", "model-head");
  head.append(tag("h2", "model-name", "Images"));
  const spec = [
    images.size,
    images.seed !== null ? `seed ${images.seed}` : null,
    images.steps !== null ? `${images.steps} steps` : "each model's own default steps",
    images.mfluxVersion ? `mflux ${images.mfluxVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (spec) head.append(tag("span", "model-spec", spec));
  section.append(head);

  if (images.prompt) section.append(tag("p", "headline", `"${images.prompt}"`));

  for (const model of images.models) {
    const row = tag("section", "size-row");
    const rowHead = tag("div", "size-head");
    rowHead.append(tag("span", "size-label", model.modelName));
    rowHead.append(tag("span", "size-sub", `seconds to make one image, model already loaded · ${model.kind}`));
    row.append(rowHead);

    const block = tag("div", "chart");
    block.append(tag("h4", "chart-title writing", "Seconds per image — lower is faster"));
    block.append(barChart({ measure: "writing", unit: "seconds", bars: model.bars, max: model.max, ticks: model.ticks }));
    row.append(block);

    // Load time sits beside the speeds, never inside them.
    const loads = model.bars.filter((b) => b.loadSeconds !== null || b.peakMemoryGb !== null);
    if (loads.length > 0) {
      row.append(
        dataTable(
          ["Lane", "Weights loaded in", "Peak memory", "Checksum"],
          loads.map((b) => [
            b.laneLabel,
            b.loadSeconds === null ? "—" : `${b.loadSeconds.toFixed(1)}s (not counted in the times above)`,
            b.peakMemoryGb === null ? "—" : `${b.peakMemoryGb.toFixed(1)} GB`,
            b.sha256 === null ? "images differ" : b.sha256.slice(0, 12),
          ]),
        ),
      );
    }

    const shown = model.bars.filter((b) => b.image);
    if (shown.length > 0) {
      const strip = tag("div", "image-strip");
      for (const bar of shown) {
        const figure = tag("figure", "image-proof");
        const img = document.createElement("img");
        img.src = `/run-image/${bar.image}`;
        img.alt = `${bar.laneLabel}: the image this lane generated`;
        img.loading = "lazy";
        figure.append(img);
        const caption = tag("figcaption", null, bar.laneLabel);
        caption.style.color = `var(${bar.colorVar})`;
        figure.append(caption);
        strip.append(figure);
      }
      row.append(strip);
    }

    if (model.warnings.length > 0 || model.notes.length > 0) {
      const list = tag("ul", "cell-notes");
      for (const text of [...model.warnings, ...model.notes]) list.append(tag("li", null, text));
      row.append(list);
    }

    section.append(row);
  }

  return section;
}

/**
 * The video section. Marked experimental, and carrying two things the number
 * cannot be read without: it is a community port, and the seconds include the
 * model load because the port reports one time for the whole invocation.
 */
function videoSection(videos) {
  const section = tag("section", "model");
  section.append(tag("div", "model-rule"));

  const head = tag("div", "model-head");
  head.append(tag("h2", "model-name", "Video"));
  head.append(tag("span", "mark warn", "experimental port"));
  section.append(head);

  for (const video of videos) {
    const row = tag("section", "size-row");
    const rowHead = tag("div", "size-head");
    rowHead.append(tag("span", "size-label", video.modelName));
    rowHead.append(
      tag(
        "span",
        "size-sub",
        [video.settings, video.portCommit ? `port ${video.portCommit}` : null].filter(Boolean).join(" · "),
      ),
    );
    row.append(rowHead);

    const block = tag("div", "chart");
    block.append(tag("h4", "chart-title writing", "Seconds per clip — model load included"));
    block.append(barChart({ measure: "writing", unit: "seconds", bars: video.bars, max: video.max, ticks: video.ticks }));
    row.append(block);

    const clips = video.bars.filter((b) => b.clip);
    if (clips.length > 0) {
      const strip = tag("div", "image-strip");
      for (const bar of clips) {
        const figure = tag("figure", "image-proof");
        const player = document.createElement("video");
        player.src = `/run-clip/${bar.clip}`;
        player.controls = true;
        player.loop = true;
        player.muted = true;
        player.preload = "metadata";
        figure.append(player);
        const caption = tag("figcaption", null, bar.laneLabel);
        caption.style.color = `var(${bar.colorVar})`;
        figure.append(caption);
        strip.append(figure);
      }
      row.append(strip);
    }

    const list = tag("ul", "cell-notes");
    list.append(tag("li", null, video.disclosure));
    for (const note of video.notes) list.append(tag("li", null, note));
    row.append(list);

    section.append(row);
  }
  return section;
}

function modelSection(model, lanes) {
  const section = tag("section", "model");
  section.append(tag("div", "model-rule"));

  const head = tag("div", "model-head");
  head.append(tag("h2", "model-name", model.modelName));
  // activeParams is free text from the config and is printed exactly as
  // written: a suffix here produced "27B dense, all active per token active".
  const spec = [model.quantization, model.fileSize, model.activeParams].filter(Boolean).join(" · ");
  if (spec) head.append(tag("span", "model-spec", spec));
  section.append(head);

  if (model.headline) section.append(tag("p", "headline", model.headline));

  for (const row of model.rows) section.append(sizeRow(row, lanes));

  if (model.firstWord.series.some((s) => s.points.some((p) => p.y !== null))) {
    const waitSection = tag("section", "size-row");
    const head2 = tag("div", "size-head");
    head2.append(tag("span", "size-label", "The wait"));
    head2.append(tag("span", "size-sub", "seconds before the first word, against prompt size"));
    waitSection.append(head2);
    const block = tag("div", "chart");
    block.append(lineChart(model.firstWord));
    waitSection.append(block);
    section.append(waitSection);
  }

  if (model.engine.length > 0) section.append(engineSection(model.engine));
  if (model.power.length > 0) section.append(powerSection(model.power));

  return section;
}

// ------------------------------------------------------------------ render

function renderLegend(lanes) {
  el.legend.textContent = "";
  lanes.forEach((lane) => {
    const item = tag("div", "legend-item");
    const swatch = tag("span", "legend-swatch");
    swatch.style.background = `var(${lane.colorVar})`;
    item.append(swatch);
    item.append(tag("span", null, lane.label));
    item.append(tag("span", "legend-kind", lane.managed ? "managed" : "manual"));
    el.legend.append(item);
  });
}

function renderFooter(footer, models) {
  el.footer.textContent = "";
  el.footer.append(tag("h2", "section-title", "How these numbers were made"));

  const list = document.createElement("dl");

  // A label and its value are ONE grid item, not two.
  //
  // Appending them as separate children of the grid let a row end on a label
  // and start the next with its value, which shifted every pair after it: the
  // board read "REST BETWEEN CELLS / TEMPERATURE" with "5 seconds" sitting
  // under the wrong heading. A wrapper makes that impossible rather than
  // unlikely. `dl > div > dt + dd` is valid HTML.
  const add = (term, value) => {
    const pair = tag("div", "footer-pair");
    pair.append(tag("dt", null, term));
    pair.append(tag("dd", null, value));
    list.append(pair);
  };

  for (const model of models) {
    const bits = [
      model.quantization ? `quantized ${model.quantization}` : null,
      model.fileSize ? `${model.fileSize} on disk` : null,
      model.activeParams,
      footer.charsPerToken[model.modelId]
        ? `${footer.charsPerToken[model.modelId].toFixed(2)} characters per token, measured`
        : null,
    ].filter(Boolean);
    add(model.modelName, bits.length > 0 ? bits.join(" · ") : "no details given in the config");
  }

  // A run folder can hold a language grid, an image grid, or both. Printing
  // "output cap: 0 tokens" under a board of pictures would be a setting that
  // was never used, so the language-grid lines appear only when one ran.
  const measured = footer.measured ?? ["llm"];
  if (measured.includes("llm")) {
    add("Output cap", `${footer.outputCap} tokens on every request`);
    add("Runs per cell", `${footer.measuredRuns} measured, after ${footer.warmupRuns} discarded warm-up`);
    add("Rest between cells", `${footer.restSeconds} seconds`);
    add("Temperature", String(footer.temperature));
    add("Thinking", footer.disableThinking ? "asked to be off" : "left on");
    add("Prompt source", `${footer.promptFile}, with a unique run id on the first line of every prompt`);
  } else {
    add("Runs per cell", `${footer.measuredRuns} measured, after ${footer.warmupRuns} discarded warm-up`);
  }
  add("Headline figure", "the median, with the lowest and highest marked on the bar. Never a mean.");
  add("Software", footer.fingerprints.length > 0 ? footer.fingerprints.join(", ") : "not reported by the server");
  add("Run", `${footer.startedAt} → ${footer.finishedAt ?? "did not finish"}`);

  el.footer.append(list);
}

function render(data) {
  pendingLabelJobs.length = 0;
  el.runName.textContent = data.runName;
  renderLegend(data.lanes);

  el.warnings.textContent = "";
  el.warnings.hidden = data.warnings.length === 0;
  for (const warning of data.warnings) el.warnings.append(tag("li", null, warning));

  el.models.textContent = "";
  // "Nothing here yet" is only true when there is nothing at all: a run of
  // pictures alone has no language-model sections and is not empty.
  if (data.models.length === 0 && !data.images && !data.video) {
    el.models.append(tag("p", "size-sub", "This run has no finished cells yet."));
  }
  for (const model of data.models) el.models.append(modelSection(model, data.lanes));
  if (data.images && data.images.models.length > 0) el.models.append(imagesSection(data.images));
  if (data.video && data.video.length > 0) el.models.append(videoSection(data.video));

  renderFooter(data.footer, data.models);

  // Now that everything is in the document, the text has a real width and the
  // wait chart's labels can be put where they will not sit on a line.
  for (const job of pendingLabelJobs.splice(0)) job();
}

async function boot() {
  const response = await fetch("/api/board");
  if (!response.ok) {
    el.runName.textContent = "could not load this run";
    return;
  }
  render(await response.json());
}

boot().catch((err) => {
  el.runName.textContent = `could not load: ${err.message}`;
});

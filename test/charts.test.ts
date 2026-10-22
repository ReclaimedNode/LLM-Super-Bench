import { describe, expect, test } from "bun:test";
// @ts-expect-error plain browser module
import * as c from "../public/charts.js";

const sp = (n: number) => ({ median: n, min: n - 1, max: n + 1 });
const raw = (label = "Mac Studio") => ({
  format: "llm-super-bench-run", version: 1, kind: "sweep", createdAt: "2026-10-22T10:00:00Z",
  settings: { maxTokens: 512, thinking: "off" }, complete: true,
  machines: [{ id: "a", label, model: "m", setup: null }],
  rows: [{ preset: "short", concurrency: 1, laneId: "a", label, repeats: 1, finished: 1, speedUnit: "tokens/sec",
    firstWordSec: sp(2), speed: sp(50), throughput: null, promptSpeed: null, totalSec: sp(5), promptTokens: 10 }],
});

describe("readRunFile", () => {
  test("accepts a good file", () => expect(c.readRunFile(raw()).ok).toBe(true));
  test("rejects wrong shapes", () => {
    for (const bad of [null, 5, {}, { ...raw(), format: "x" }, { ...raw(), version: 2 }, { ...raw(), rows: [] }, { ...raw(), rows: [{ label: "" }] }])
      expect(c.readRunFile(bad).ok).toBe(false);
  });
  test("drops non-numbers from spreads", () => {
    const r = raw();
    (r.rows[0] as any).speed = { median: "NaN", min: 1, max: 2 };
    expect(c.readRunFile(r).file.rows[0].speed).toBeNull();
  });
});

describe("charts", () => {
  const series = () => c.buildSeries([{ name: "me", file: c.readRunFile(raw()).file }, { name: "friend", file: c.readRunFile(raw()).file }]);
  test("clashing machine names are kept apart", () => {
    const names = series().map((s: any) => s.display);
    expect(new Set(names).size).toBe(2);
  });
  test("hostile labels are escaped in SVG", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const svg = c.barChartSvg({ title: evil, note: evil, unit: "s", bars: [{ label: evil, color: "#fff", value: 1, min: 0, max: 2 }] });
    expect(svg).not.toContain("<img");
    expect(svg.startsWith("<svg")).toBe(true);
  });
  test("missing values do not break charts", () => {
    const bar = c.barChartSvg({ title: "t", unit: "s", bars: [{ label: "a", color: "#fff", value: null }] });
    const line = c.lineChartSvg({ title: "t", unit: "s", xTitle: "x", xLabels: ["1", "2"], lines: [{ label: "a", color: "#fff", shape: "circle", points: [null, null] }] });
    expect(bar).toContain("<svg");
    expect(line).toContain("<svg");
  });
  test("CSV quotes spreadsheet formulas", () => {
    const r = raw("=HYPERLINK(\"x\")");
    const csv = c.rowsToCsv(c.buildSeries([{ name: "n", file: c.readRunFile(r).file }]));
    expect(csv).not.toMatch(/(^|,)=HYPER/);
  });
});

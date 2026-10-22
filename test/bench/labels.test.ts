/**
 * Where the wait chart puts its point labels.
 *
 * The bug these exist for: at a 512-token prompt both machines answer in under
 * a second, so the points bunch and the lines fan out from them. The labels
 * politely stacked and did not overlap EACH OTHER -- which is all the old
 * check measured -- while the pale lane's line ran straight through the orange
 * lane's number, and the orange lane's number sat on the pale lane's dot.
 *
 * So these tests measure the thing the picture showed: a label's box against
 * every line and every dot, and which point each label belongs to.
 */

import { describe, expect, test } from "bun:test";
// @ts-expect-error -- plain browser module, no types, imported for its maths.
import { labelIsClear, labelRect, placeColumnLabels, rectIntersectsCircle, rectIntersectsSegment, rectsOverlap, segmentsIntersect } from "../../public/bench/labels.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
interface Dot {
  cx: number;
  cy: number;
  r: number;
}
interface Placed {
  id: string;
  baselineY: number;
  rect: Rect;
  side: "above" | "below";
  penalty: number;
  needsLeader: boolean;
}

/** A measured label, the way the page hands one over after getBBox(). */
function label(id: string, px: number, py: number, width = 40, height = 15) {
  return { id, px, py, width, height, dyTop: -12, anchor: "middle" as const };
}

const BOUNDS = { minX: 2, minY: 2, maxX: 1078, maxY: 252 };

function place(labels: ReturnType<typeof label>[], segments: Seg[] = [], dots: Dot[] = []): Placed[] {
  return placeColumnLabels(labels, { segments, dots }, BOUNDS) as Placed[];
}

/** Every label clear of every line, dot and other label. */
function allClear(placed: Placed[], segments: Seg[], dots: Dot[]): boolean {
  return placed.every((p, i) =>
    labelIsClear(
      p.rect,
      { segments, dots },
      placed.filter((_, j) => j !== i).map((o) => o.rect),
      BOUNDS,
    ),
  );
}

describe("the geometry the old check was missing", () => {
  test("a box knows when a line runs through it", () => {
    const box = { x: 100, y: 100, width: 40, height: 15 };
    // Straight through the middle -- the exact failure in the screenshot.
    expect(rectIntersectsSegment(box, { x1: 80, y1: 108, x2: 200, y2: 108 })).toBe(true);
    // Clear above and clear below.
    expect(rectIntersectsSegment(box, { x1: 80, y1: 60, x2: 200, y2: 60 })).toBe(false);
    expect(rectIntersectsSegment(box, { x1: 80, y1: 200, x2: 200, y2: 200 })).toBe(false);
    // A sloped line clipping one corner still counts.
    expect(rectIntersectsSegment(box, { x1: 80, y1: 130, x2: 130, y2: 90 })).toBe(true);
    // A line that stops short of the box does not.
    expect(rectIntersectsSegment(box, { x1: 0, y1: 108, x2: 90, y2: 108 })).toBe(false);
  });

  test("a box knows when a dot touches it", () => {
    const box = { x: 100, y: 100, width: 40, height: 15 };
    expect(rectIntersectsCircle(box, { cx: 120, cy: 107, r: 6 })).toBe(true);
    expect(rectIntersectsCircle(box, { cx: 96, cy: 107, r: 6 })).toBe(true); // just outside the edge
    expect(rectIntersectsCircle(box, { cx: 80, cy: 107, r: 6 })).toBe(false);
  });

  test("boxes, and segments, know when they cross", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
  });

  test("a label's box follows its anchor", () => {
    expect(labelRect({ px: 100, width: 40, dyTop: -12, anchor: "start" }, 50).x).toBe(100);
    expect(labelRect({ px: 100, width: 40, dyTop: -12, anchor: "middle" }, 50).x).toBe(80);
    expect(labelRect({ px: 100, width: 40, dyTop: -12, anchor: "end" }, 50).x).toBe(60);
  });
});

describe("two lanes, near-equal, at the first point", () => {
  // The real numbers off the live run: 0.77s and 1.03s at the left edge, with
  // both lines climbing away to the right.
  const orange = label("orange", 64, 210); // 0.77s -- the LOWER point
  const pale = label("pale", 64, 195); // 1.03s -- the upper point
  const segments: Seg[] = [
    { x1: 64, y1: 210, x2: 1056, y2: 60 }, // orange climbs steeply
    { x1: 64, y1: 195, x2: 1056, y2: 170 }, // pale climbs gently
  ];
  const dots: Dot[] = [
    { cx: 64, cy: 210, r: 6 },
    { cx: 64, cy: 195, r: 6 },
  ];

  test("no label sits on any line or any dot", () => {
    // THIS is the test that fails against the old code: the old placement
    // stacked both labels above the bunch, straight across the pale line.
    const placed = place([orange, pale], segments, dots);
    expect(allClear(placed, segments, dots)).toBe(true);
    for (const p of placed) expect(p.penalty).toBe(0);
  });

  test("each label ends up on its own side of the bunch, nearest its own point", () => {
    const placed = place([orange, pale], segments, dots);
    const o = placed.find((p) => p.id === "orange")!;
    const l = placed.find((p) => p.id === "pale")!;

    // The upper point's label goes above, the lower point's below, so the
    // number nearest each dot is that dot's own number.
    expect(l.side).toBe("above");
    expect(o.side).toBe("below");
    expect(l.rect.y + l.rect.height).toBeLessThanOrEqual(pale.py);
    expect(o.rect.y).toBeGreaterThanOrEqual(orange.py);
  });

  test("the label order matches the point order", () => {
    const placed = place([orange, pale], segments, dots);
    const o = placed.find((p) => p.id === "orange")!;
    const l = placed.find((p) => p.id === "pale")!;
    // pale's point is above orange's, so pale's label is above orange's.
    expect(l.rect.y).toBeLessThan(o.rect.y);
  });
});

describe("two lanes, near-equal, at the last point", () => {
  const a = label("a", 1056, 100);
  const b = label("b", 1056, 108);
  const segments: Seg[] = [
    { x1: 64, y1: 240, x2: 1056, y2: 100 },
    { x1: 64, y1: 230, x2: 1056, y2: 108 },
  ];
  const dots: Dot[] = [
    { cx: 1056, cy: 100, r: 6 },
    { cx: 1056, cy: 108, r: 6 },
  ];

  test("nothing sits on a line, and nothing leaves the chart", () => {
    const placed = place([a, b], segments, dots);
    expect(allClear(placed, segments, dots)).toBe(true);
    for (const p of placed) {
      expect(p.rect.y).toBeGreaterThanOrEqual(BOUNDS.minY);
      expect(p.rect.y + p.rect.height).toBeLessThanOrEqual(BOUNDS.maxY);
    }
  });
});

describe("lines that cross between the points", () => {
  // One lane overtakes the other, so at the middle column a line passes right
  // through where the other lane's label would naturally sit.
  const left = label("left", 560, 150);
  const right = label("right", 560, 158);
  const segments: Seg[] = [
    { x1: 64, y1: 80, x2: 1056, y2: 220 }, // falling
    { x1: 64, y1: 220, x2: 1056, y2: 80 }, // rising -- they cross near x=560
    { x1: 64, y1: 150, x2: 1056, y2: 150 }, // and one runs flat through the middle
  ];
  const dots: Dot[] = [
    { cx: 560, cy: 150, r: 6 },
    { cx: 560, cy: 158, r: 6 },
  ];

  test("both labels find clear air", () => {
    const placed = place([left, right], segments, dots);
    expect(allClear(placed, segments, dots)).toBe(true);
  });
});

describe("four lanes bunched together", () => {
  const labels = [label("l0", 64, 200), label("l1", 64, 206), label("l2", 64, 212), label("l3", 64, 218)];
  const segments: Seg[] = labels.map((l, i) => ({ x1: 64, y1: l.py, x2: 1056, y2: 60 + i * 30 }));
  const dots: Dot[] = labels.map((l) => ({ cx: 64, cy: l.py, r: 6 }));

  test("all four are clear of every line, every dot and each other", () => {
    const placed = place(labels, segments, dots);
    expect(placed).toHaveLength(4);
    expect(allClear(placed, segments, dots)).toBe(true);
  });

  test("the four labels keep the order of their four points", () => {
    const placed = place(labels, segments, dots);
    const byPoint = [...labels].sort((a, b) => a.py - b.py).map((l) => l.id);
    const byLabel = [...placed].sort((a, b) => a.rect.y - b.rect.y).map((p) => p.id);
    expect(byLabel).toEqual(byPoint);
  });

  test("none of them leaves the chart", () => {
    for (const p of place(labels, segments, dots)) {
      expect(p.rect.y).toBeGreaterThanOrEqual(BOUNDS.minY);
      expect(p.rect.y + p.rect.height).toBeLessThanOrEqual(BOUNDS.maxY);
      expect(p.rect.x).toBeGreaterThanOrEqual(BOUNDS.minX);
      expect(p.rect.x + p.rect.width).toBeLessThanOrEqual(BOUNDS.maxX);
    }
  });

  test("a label pushed well clear of its point asks for a leader", () => {
    // The outermost of four bunched labels ends up a long way from its dot,
    // and a number floating near two lines needs something tying it back.
    const placed = place(labels, segments, dots);
    expect(placed.some((p) => p.needsLeader)).toBe(true);
  });
});

describe("the ordinary case is left alone", () => {
  test("a single label sits just above its point with no leader", () => {
    const only = label("only", 560, 150);
    const placed = place([only], [], [{ cx: 560, cy: 150, r: 6 }]);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.side).toBe("above");
    expect(placed[0]!.needsLeader).toBe(false);
    expect(placed[0]!.rect.y + placed[0]!.rect.height).toBeLessThan(150);
  });

  test("two lanes far apart each keep a label right next to their own point", () => {
    const high = label("high", 560, 60);
    const low = label("low", 560, 220);
    const placed = place([high, low], [], []);
    for (const p of placed) {
      const own = p.id === "high" ? high : low;
      const distance = p.side === "above" ? own.py - (p.rect.y + p.rect.height) : p.rect.y - own.py;
      expect(distance).toBeLessThan(20);
      expect(p.needsLeader).toBe(false);
    }
  });
});

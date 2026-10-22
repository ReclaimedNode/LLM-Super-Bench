/*
  Where a point's label goes on the wait chart.

  Pure geometry, no DOM: the page measures the text and hands the boxes in, and
  `bun test` imports this file directly. A chart that gets filmed cannot have a
  number sitting on the wrong line, so the rules here are worth testing rather
  than eyeballing.

  Two rules, both learnt from a 3x zoom of a real board:

    1. A label belongs to ONE lane and must read that way. It is drawn in its
       lane's colour, it sits on its own side of the bunch, and a leader joins
       it to its point when it has been pushed away.
    2. A label may not sit on any line or any dot -- not just on another label.
       At a small prompt every lane answers in about the same fraction of a
       second, so the points bunch, the lines fan out from them, and the space
       a label can safely occupy is the space OUTSIDE the fan.

  Hence the shape of the algorithm: the points in a column are split down the
  middle, the upper half labelled above the bunch and the lower half below it,
  each stacked outwards from the middle so the order of the labels always
  matches the order of the points. Anything still touching a line is pushed
  further out, away from the fan, until it is clear.
*/

// ------------------------------------------------------------------ geometry

/** Do two axis-aligned boxes overlap? Touching edges do not count. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function orientation(ax, ay, bx, by, cx, cy) {
  const v = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  return v === 0 ? 0 : v > 0 ? 1 : 2;
}

function onSegment(ax, ay, bx, by, cx, cy) {
  return (
    Math.min(ax, bx) <= cx && cx <= Math.max(ax, bx) && Math.min(ay, by) <= cy && cy <= Math.max(ay, by)
  );
}

/** Do two line segments cross or touch? */
export function segmentsIntersect(p1, p2, p3, p4) {
  const o1 = orientation(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  const o2 = orientation(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y);
  const o3 = orientation(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y);
  const o4 = orientation(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y);

  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y)) return true;
  if (o2 === 0 && onSegment(p1.x, p1.y, p2.x, p2.y, p4.x, p4.y)) return true;
  if (o3 === 0 && onSegment(p3.x, p3.y, p4.x, p4.y, p1.x, p1.y)) return true;
  if (o4 === 0 && onSegment(p3.x, p3.y, p4.x, p4.y, p2.x, p2.y)) return true;
  return false;
}

function pointInRect(rect, x, y) {
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/**
 * Does a line segment touch a box?
 *
 * This is the test the old check was missing: it compared text against text,
 * so two labels that had politely stacked still both sat on a line.
 */
export function rectIntersectsSegment(rect, seg) {
  const a = { x: seg.x1, y: seg.y1 };
  const b = { x: seg.x2, y: seg.y2 };
  if (pointInRect(rect, a.x, a.y) || pointInRect(rect, b.x, b.y)) return true;

  const tl = { x: rect.x, y: rect.y };
  const tr = { x: rect.x + rect.width, y: rect.y };
  const br = { x: rect.x + rect.width, y: rect.y + rect.height };
  const bl = { x: rect.x, y: rect.y + rect.height };

  return (
    segmentsIntersect(a, b, tl, tr) ||
    segmentsIntersect(a, b, tr, br) ||
    segmentsIntersect(a, b, br, bl) ||
    segmentsIntersect(a, b, bl, tl)
  );
}

/** Does a dot touch a box? */
export function rectIntersectsCircle(rect, dot) {
  const nearestX = Math.max(rect.x, Math.min(dot.cx, rect.x + rect.width));
  const nearestY = Math.max(rect.y, Math.min(dot.cy, rect.y + rect.height));
  const dx = dot.cx - nearestX;
  const dy = dot.cy - nearestY;
  return dx * dx + dy * dy <= dot.r * dot.r;
}

// ------------------------------------------------------------------ placement

/** The box a text sits in, given where its baseline is put. */
export function labelRect(label, baselineY) {
  const left =
    label.anchor === "end" ? label.px - label.width : label.anchor === "middle" ? label.px - label.width / 2 : label.px;
  return { x: left, y: baselineY + label.dyTop, width: label.width, height: label.height };
}

function penaltyFor(rect, obstacles, placedRects, bounds) {
  let penalty = 0;
  for (const seg of obstacles.segments) if (rectIntersectsSegment(rect, seg)) penalty += 1;
  for (const dot of obstacles.dots) if (rectIntersectsCircle(rect, dot)) penalty += 1;
  for (const other of placedRects) if (rectsOverlap(rect, other)) penalty += 1;
  // Leaving the chart is worse than touching something inside it.
  if (rect.y < bounds.minY || rect.y + rect.height > bounds.maxY) penalty += 50;
  if (rect.x < bounds.minX || rect.x + rect.width > bounds.maxX) penalty += 50;
  return penalty;
}

/**
 * Places every label in one column.
 *
 * `labels` are the points of one x position, each already measured:
 * { id, px, py, width, height, dyTop, anchor }. `dyTop` is how far the text's
 * box starts above its baseline, which only the browser knows.
 *
 * Returns one entry per label: the baseline to draw it at, its box, and
 * whether it ended up far enough from its point to need a leader.
 */
export function placeColumnLabels(labels, obstacles, bounds, options = {}) {
  const gap = options.gap ?? 7;
  const step = options.step ?? 7;
  const maxSteps = options.maxSteps ?? 30;
  /** How far a label may sit from its point before it needs a leader drawn. */
  const leaderAfter = options.leaderAfter ?? 20;

  // Top of the screen first. A stable tiebreak keeps two points at the very
  // same height from swapping between renders.
  const sorted = [...labels].sort((a, b) => a.py - b.py || String(a.id).localeCompare(String(b.id)));
  const n = sorted.length;

  // Split the column in half by default, but follow the room actually
  // available: four points bunched near the bottom of the chart have nowhere
  // to put two labels below them, and stacking them anyway pushes the last one
  // off the axis.
  const slot = Math.max(...sorted.map((l) => l.height)) + gap;
  const roomAbove = Math.max(0, Math.floor((sorted[0].py - bounds.minY) / slot));
  const roomBelow = Math.max(0, Math.floor((bounds.maxY - sorted[n - 1].py) / slot));

  let aboveCount = Math.ceil(n / 2);
  if (n - aboveCount > roomBelow) aboveCount = n - roomBelow;
  aboveCount = Math.min(aboveCount, Math.max(1, roomAbove), n);

  const above = sorted.slice(0, aboveCount);
  const below = sorted.slice(aboveCount);

  const placedRects = [];
  const out = new Map();

  const settle = (label, direction, baseBaseline) => {
    let best = null;
    for (let i = 0; i <= maxSteps; i++) {
      const baselineY = baseBaseline + direction * step * i;
      const rect = labelRect(label, baselineY);
      const penalty = penaltyFor(rect, obstacles, placedRects, bounds);
      if (penalty === 0) return { baselineY, rect, penalty };
      if (best === null || penalty < best.penalty) best = { baselineY, rect, penalty };
    }
    return best;
  };

  // --- Upper half: labelled above the bunch, stacked upwards from the middle,
  //     so the label order matches the point order.
  let ceiling = Number.POSITIVE_INFINITY;
  for (let i = above.length - 1; i >= 0; i--) {
    const label = above[i];
    // Sit the box just above the point...
    let baseline = label.py - gap - label.height - label.dyTop;
    // ...but never below a label already placed for a point above this one.
    const wouldBottom = baseline + label.dyTop + label.height;
    if (wouldBottom > ceiling - gap) baseline -= wouldBottom - (ceiling - gap);

    const settled = settle(label, -1, baseline);
    placedRects.push(settled.rect);
    ceiling = settled.rect.y;
    out.set(label.id, { ...settled, side: "above", label });
  }

  // --- Lower half: below the bunch, stacked downwards from the middle.
  let floor = Number.NEGATIVE_INFINITY;
  for (const label of below) {
    let baseline = label.py + gap - label.dyTop;
    const wouldTop = baseline + label.dyTop;
    if (wouldTop < floor + gap) baseline += floor + gap - wouldTop;

    const settled = settle(label, 1, baseline);
    placedRects.push(settled.rect);
    floor = settled.rect.y + settled.rect.height;
    out.set(label.id, { ...settled, side: "below", label });
  }

  return labels.map((label) => {
    const settled = out.get(label.id);
    const rect = settled.rect;
    // How far the box's nearest edge ended up from the point it belongs to.
    const distance = settled.side === "above" ? label.py - (rect.y + rect.height) : rect.y - label.py;
    return {
      id: label.id,
      baselineY: settled.baselineY,
      rect,
      side: settled.side,
      penalty: settled.penalty,
      needsLeader: distance > leaderAfter,
    };
  });
}

/**
 * Is a label's box clear of every line, dot and other label?
 *
 * The board's own check, exported so a test can assert the thing the picture
 * showed rather than a proxy for it.
 */
export function labelIsClear(rect, obstacles, otherRects, bounds) {
  return penaltyFor(rect, obstacles, otherRects, bounds) === 0;
}

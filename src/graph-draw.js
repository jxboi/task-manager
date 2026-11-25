// The graph view's drawing, over anything shaped like a CanvasRenderingContext2D: a flat page,
// hairline links, circles back to front (hubs as ink rings) and a small monospace label on every node. Pure apart from the
// calls on `ctx`; src/graph-view.js owns the canvas and when to draw.
import { drawnRadius, HUB_RING } from './graph-space.js';

export { HUB_RING };

// Defaults matching the styles.css tokens; graph-view.js passes the live tokens when it can.
export const PALETTE = {
  bg: '#f4f4f1', // --page
  open: '#111111', // --ink
  done: '#c4c4bf',
  hub: '#111111', // --ink: the hub ring
  link: 'rgba(17, 17, 17, 0.12)',
  label: '#4f4f4a', // --text-2
  hubLabel: '#111111', // --ink
  focus: '#111111',
};
export const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'; // --mono
export const LABELS = {
  max: 250, // a safety cap on task labels per frame; hub labels always show
  size: 10, // px
  weight: 500, // task labels
  hubWeight: 600,
  charWidth: 7.5, // px per character at `size` with the letter spacing (a little generous)
  gap: 4, // px between a circle and its label
  halo: 3, // px of page colour around each label, so it reads over circles and links
  pad: 1, // px kept clear around a label box when testing what it covers
  patience: 24, // in a crowd: spots tried before a label may overlap another label (never a circle)
  crowd: 60, // nodes: above this a frame is a crowd
};
const LINE = LABELS.size + 2; // px: a label box's height

const colourFor = (palette, state) => (state === 'done' ? palette.done : palette.open);

const labelWidth = (label) => [...label].length * LABELS.charWidth;

// A label box: `x` is where the text is drawn with `align`, `y` its middle.
function box(x, y, w, align) {
  const left = align === 'left' ? x : align === 'right' ? x - w : x - w / 2;
  return { x, y, align, left, right: left + w, top: y - LINE / 2, bottom: y + LINE / 2 };
}

const labelBox = (px, r, label, align) => (align === 'right'
  ? box(px - r - LABELS.gap, 0, labelWidth(label), 'right')
  : box(px + r + LABELS.gap, 0, labelWidth(label), 'left'));

// Chooses left vs right of the circle for a label so it avoids clipping at the canvas right edge.
export function placeLabel(px, r, label, width = Infinity) {
  const right = labelBox(px, r, label, 'left');
  const left = labelBox(px, r, label, 'right');
  const onLeft = right.right + LABELS.halo > width && (left.left >= 0 || width - right.x < left.x);
  return onLeft ? left : right;
}

// Places around a circle at (px, py) with drawn radius r, most preferred first: beside it, above
// and below it, at the diagonals, then a line or more further out. `leftFirst` mirrors left/right.
export function labelCandidates(px, py, r, label, leftFirst = false) {
  return [...spots(px, py, r, labelWidth(label), leftFirst)];
}

// labelCandidates() one at a time, so a label that fits at the first spot builds no others.
function* spots(px, py, r, w, leftFirst) {
  const near = r + LABELS.gap;
  const step = LINE + 2;
  const above = py - near - LINE / 2;
  const below = py + near + LINE / 2;
  const diag = r * 0.5;
  const first = leftFirst ? -1 : 1;
  const beside = (side, y) => box(px + side * near, y, w, side > 0 ? 'left' : 'right');
  const corner = (side, y) => box(px + side * diag, y, w, side > 0 ? 'left' : 'right');
  yield beside(first, py);
  yield beside(-first, py);
  yield box(px, above, w, 'center');
  yield box(px, below, w, 'center');
  for (const side of [first, -first]) {
    yield corner(side, above);
    yield corner(side, below);
  }
  for (let k = 1; k <= 5; k += 1) {
    for (const side of [first, -first]) {
      yield beside(side, py - k * step);
      yield beside(side, py + k * step);
    }
    yield box(px, above - k * step, w, 'center');
    yield box(px, below + k * step, w, 'center');
    for (const side of [first, -first]) {
      yield corner(side, above - k * step);
      yield corner(side, below + k * step);
    }
  }
}

function circleHitsBox(cx, cy, cr, left, top, right, bottom) {
  const nx = Math.max(left, Math.min(cx, right));
  const ny = Math.max(top, Math.min(cy, bottom));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < cr * cr;
}

const boxesOverlap = (a, b, pad) => a.left - pad < b.right && b.left - pad < a.right && a.top - pad < b.bottom && b.top - pad < a.bottom;

// A uniform grid of items with boxes, so a query only looks at nearby ones.
function grid(cellSize = 40) {
  const cells = new Map();
  let stamp = 0;
  const range = (lo, hi) => [Math.floor(lo / cellSize), Math.floor(hi / cellSize)];
  return {
    add(item, left, top, right, bottom) {
      const [c0, c1] = range(left, right);
      const [r0, r1] = range(top, bottom);
      for (let c = c0; c <= c1; c += 1) {
        for (let r = r0; r <= r1; r += 1) {
          const key = c * 65536 + r;
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(item);
        }
      }
    },
    // Calls `fn` once per item near the box; stops early when `fn` returns true.
    some(left, top, right, bottom, fn) {
      stamp += 1;
      const [c0, c1] = range(left, right);
      const [r0, r1] = range(top, bottom);
      for (let c = c0; c <= c1; c += 1) {
        for (let r = r0; r <= r1; r += 1) {
          for (const item of cells.get(c * 65536 + r) ?? []) {
            if (item.seen === stamp) continue;
            item.seen = stamp;
            if (fn(item)) return true;
          }
        }
      }
      return false;
    },
  };
}

function visibleCircles(projected, nodes, width, height) {
  const circles = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const x = projected[k];
    const y = projected[k + 1];
    const r = drawnRadius(nodes[i].radius, scale);
    if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
    circles.push({ index: i, x, y, r });
  }
  return circles;
}

// Labels to draw, hubs first, then tasks from the front: every node whose centre is on the canvas
// gets one. Each label takes the first of labelCandidates() that stays inside the canvas and
// covers no circle (its own included) and no label already placed; when none is clear, the one
// covering the fewest circles, then the fewest labels. Returns [{index, x, y, align, left, …}].
export function planLabels(projected, nodes, order, {
  width = Infinity, height = Infinity, max = LABELS.max, hubsOnly = false,
} = {}) {
  const picked = [];
  const circles = grid();
  for (const c of visibleCircles(projected, nodes, width, height)) {
    circles.add(c, Math.max(0, c.x - c.r), Math.max(0, c.y - c.r),
      Math.min(width, c.x + c.r), Math.min(height, c.y + c.r));
  }
  const placed = grid();
  const pad = LABELS.pad;
  // Counts stop once past `limit`: a spot that can't beat the best so far needn't be counted out.
  const countCircles = (b, limit) => {
    let hits = 0;
    circles.some(b.left - pad, b.top - pad, b.right + pad, b.bottom + pad, (c) => {
      if (circleHitsBox(c.x, c.y, c.r + pad, b.left, b.top, b.right, b.bottom)) hits += 1;
      return hits > limit;
    });
    return hits;
  };
  const countLabels = (b, limit) => {
    let hits = 0;
    placed.some(b.left - pad, b.top - pad, b.right + pad, b.bottom + pad, (other) => {
      if (boxesOverlap(b, other, pad)) hits += 1;
      return hits > limit;
    });
    return hits;
  };
  const patience = nodes.length > LABELS.crowd ? LABELS.patience : Infinity;
  const inside = (b) => b.left >= 0 && b.right <= width && b.top >= 0 && b.bottom <= height;
  const claim = (i) => {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) return false;
    const px = projected[k];
    const py = projected[k + 1];
    if (px < 0 || px > width || py < 0 || py > height) return false;
    const r = drawnRadius(nodes[i].radius, scale);
    const label = nodes[i].label;
    const leftFirst = placeLabel(px, r, label, width).align === 'right';
    let chosen = null;
    let best = Infinity;
    let tried = 0;
    for (const spot of spots(px, py, r, labelWidth(label), leftFirst)) {
      // In a crowd, a spot clear of circles that only overlaps a label is good enough after a while.
      if (++tried > patience && best < 1000) break;
      // Past a side edge, the spot slides back in (it may then cover its own circle, which counts).
      const slide = Math.max(-spot.left, Math.min(0, width - spot.right));
      const candidate = slide ? box(spot.x + slide, spot.y, spot.right - spot.left, spot.align) : spot;
      if (!inside(candidate)) continue;
      const circleHits = countCircles(candidate, Math.floor(best / 1000));
      if (circleHits * 1000 >= best) continue;
      const cost = circleHits * 1000 + countLabels(candidate, best - circleHits * 1000 - 1);
      if (cost < best) {
        chosen = candidate;
        best = cost;
        if (cost === 0) break;
      }
    }
    if (!chosen) {
      // Wider than any spot around the node: beside it, slid back inside the canvas.
      const b = labelCandidates(px, py, r, label, leftFirst)[0];
      const shift = Math.max(-b.left, Math.min(0, width - b.right));
      const dy = Math.max(-b.top, Math.min(0, height - b.bottom));
      chosen = box(b.x + (Number.isFinite(shift) ? shift : 0), b.y + (Number.isFinite(dy) ? dy : 0), b.right - b.left, b.align);
    }
    const entry = { index: i, ...chosen };
    placed.add(entry, entry.left, entry.top, entry.right, entry.bottom);
    picked.push(entry);
    return true;
  };
  for (let n = order.length - 1; n >= 0; n -= 1) {
    if (nodes[order[n]].kind === 'hub') claim(order[n]);
  }
  if (hubsOnly) return picked;
  let tasks = 0;
  for (let n = order.length - 1; n >= 0 && tasks < max; n -= 1) {
    const i = order[n];
    if (nodes[i].kind === 'task' && claim(i)) tasks += 1;
  }
  return picked;
}

// Indices of the nodes to label (see planLabels). `hubsOnly` is the lite tier.
export function pickLabels(projected, nodes, order, options = {}) {
  return planLabels(projected, nodes, order, options).map((entry) => entry.index);
}

// frame: {nodes, projected (graph-space.js project), order (back to front), links (flat node
// index pairs), dpr, width, height (CSS px), tier ('full'|'lite'|'static'), focusIndex (-1 for
// none), palette?, font?}. Returns what was drawn, for diagnostics and tests.
export function drawFrame(ctx, frame) {
  const { nodes, projected, order, links, dpr = 1, width, height, tier = 'full', focusIndex = -1 } = frame;
  const palette = frame.palette ?? PALETTE;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, width, height);

  // Every link in one path and one stroke; a link stops at a hub's ring rather than crossing it.
  const trim = (from, to) => {
    const node = nodes[to];
    const t = to * 4;
    if (node.kind !== 'hub') return [projected[t], projected[t + 1]];
    const f = from * 4;
    const dx = projected[f] - projected[t];
    const dy = projected[f + 1] - projected[t + 1];
    const d = Math.hypot(dx, dy);
    const r = drawnRadius(node.radius, projected[t + 2]);
    return d > r ? [projected[t] + (dx / d) * r, projected[t + 1] + (dy / d) * r] : [projected[t], projected[t + 1]];
  };
  ctx.beginPath();
  for (let l = 0; l < links.length; l += 2) {
    const a = links[l];
    const b = links[l + 1];
    if (!(projected[a * 4 + 2] > 0) || !(projected[b * 4 + 2] > 0)) continue;
    ctx.moveTo(...trim(b, a));
    ctx.lineTo(...trim(a, b));
  }
  ctx.strokeStyle = palette.link;
  ctx.lineWidth = 1;
  ctx.stroke();

  let circles = 0;
  let fill = null;
  for (let n = 0; n < order.length; n += 1) {
    const i = order[n];
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const r = drawnRadius(nodes[i].radius, scale);
    const x = projected[k];
    const y = projected[k + 1];
    if (x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
    circles += 1;
    if (nodes[i].kind === 'hub') {
      // An unfilled ink ring on the drawn radius.
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = palette.hub;
      ctx.lineWidth = HUB_RING;
      ctx.stroke();
      continue;
    }
    const colour = colourFor(palette, nodes[i].state);
    if (colour !== fill) ctx.fillStyle = fill = colour;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (focusIndex >= 0 && projected[focusIndex * 4 + 2] > 0) {
    const k = focusIndex * 4;
    const r = drawnRadius(nodes[focusIndex].radius, projected[k + 2]);
    ctx.beginPath();
    ctx.arc(projected[k], projected[k + 1], r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = palette.focus;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const labels = planLabels(projected, nodes, order, { width, height, hubsOnly: tier !== 'full' });
  if (labels.length) {
    const family = frame.font ?? MONO;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.strokeStyle = palette.bg;
    ctx.lineWidth = LABELS.halo;
    ctx.lineJoin = 'round';
    let ink = null;
    let font = null;
    let align = 'left';
    for (const { index: i, x, y, align: nextAlign } of labels) {
      const hub = nodes[i].kind === 'hub';
      const colour = hub ? palette.hubLabel : palette.label;
      const nextFont = `${hub ? LABELS.hubWeight : LABELS.weight} ${LABELS.size}px ${family}`;
      if (nextFont !== font) ctx.font = font = nextFont;
      if (nextAlign !== align) ctx.textAlign = align = nextAlign;
      if (colour !== ink) ctx.fillStyle = ink = colour;
      ctx.strokeText(nodes[i].label, x, y);
      ctx.fillText(nodes[i].label, x, y);
    }
  }
  return { circles, labels: labels.length };
}

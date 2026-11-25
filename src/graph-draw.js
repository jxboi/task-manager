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
};
const LINE = LABELS.size + 2; // px: a label box's height

const colourFor = (palette, state) => (state === 'done' ? palette.done : palette.open);

export const labelWidth = (label) => [...label].length * LABELS.charWidth;

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

// Places around a circle at (px, py) with drawn radius r, most preferred first: right of it,
// left, above, below, then the four diagonals with the box corner on the 45° line. Every one
// starts LABELS.gap px from the circle's edge: a label never strays from its own node.
// `leftFirst` mirrors left/right.
export function labelCandidates(px, py, r, label, leftFirst = false) {
  return [...spots(px, py, r, labelWidth(label), leftFirst)];
}

export const LABEL_SIDES = [
  'right', 'left', 'above', 'below',
  'ne', 'nw', 'se', 'sw',
  'aboveMidRight', 'aboveMidLeft', 'belowMidRight', 'belowMidLeft',
  'aboveRight', 'aboveLeft', 'belowRight', 'belowLeft',
  'rightUp', 'rightDown', 'leftUp', 'leftDown',
];

const MIRRORED_SIDES = [
  'left', 'right', 'above', 'below',
  'nw', 'ne', 'sw', 'se',
  'aboveMidLeft', 'aboveMidRight', 'belowMidLeft', 'belowMidRight',
  'aboveLeft', 'aboveRight', 'belowLeft', 'belowRight',
  'leftUp', 'leftDown', 'rightUp', 'rightDown',
];

// The box for a label of width `w` on `side` of the circle (px, py, r).
export function sideBox(px, py, r, w, side) {
  const near = r + LABELS.gap;
  const q = near * Math.SQRT1_2;
  let b;
  switch (side) {
    case 'right': b = box(px + near, py, w, 'left'); break;
    case 'left': b = box(px - near, py, w, 'right'); break;
    case 'above': b = box(px, py - near - LINE / 2, w, 'center'); break;
    case 'below': b = box(px, py + near + LINE / 2, w, 'center'); break;
    case 'ne': b = box(px + q, py - q - LINE / 2, w, 'left'); break;
    case 'nw': b = box(px - q, py - q - LINE / 2, w, 'right'); break;
    case 'se': b = box(px + q, py + q + LINE / 2, w, 'left'); break;
    case 'sw': b = box(px - q, py + q + LINE / 2, w, 'right'); break;
    case 'aboveMidRight': b = box(px + 0.25 * w, py - near - LINE / 2, w, 'center'); break;
    case 'aboveMidLeft': b = box(px - 0.25 * w, py - near - LINE / 2, w, 'center'); break;
    case 'belowMidRight': b = box(px + 0.25 * w, py + near + LINE / 2, w, 'center'); break;
    case 'belowMidLeft': b = box(px - 0.25 * w, py + near + LINE / 2, w, 'center'); break;
    case 'aboveRight': b = box(px, py - near - LINE / 2, w, 'left'); break;
    case 'aboveLeft': b = box(px, py - near - LINE / 2, w, 'right'); break;
    case 'belowRight': b = box(px, py + near + LINE / 2, w, 'left'); break;
    case 'belowLeft': b = box(px, py + near + LINE / 2, w, 'right'); break;
    case 'rightUp': b = box(px + near, py - 4, w, 'left'); break;
    case 'rightDown': b = box(px + near, py + 4, w, 'left'); break;
    case 'leftUp': b = box(px - near, py - 4, w, 'right'); break;
    default: b = box(px - near, py + 4, w, 'right'); break; // leftDown
  }
  b.side = side;
  return b;
}

// Box edges relative to the node centre as k × r + c (r: drawn radius, px), for the fit:
// [left, right, top, bottom], each [k, c]; screen y runs down.
export function sideExtents(side, w) {
  const g = LABELS.gap;
  const s = Math.SQRT1_2;
  switch (side) {
    case 'right': return [[1, g], [1, g + w], [0, -LINE / 2], [0, LINE / 2]];
    case 'left': return [[-1, -g - w], [-1, -g], [0, -LINE / 2], [0, LINE / 2]];
    case 'above': return [[0, -w / 2], [0, w / 2], [-1, -g - LINE], [-1, -g]];
    case 'below': return [[0, -w / 2], [0, w / 2], [1, g], [1, g + LINE]];
    case 'ne': return [[s, s * g], [s, s * g + w], [-s, -s * g - LINE], [-s, -s * g]];
    case 'nw': return [[-s, -s * g - w], [-s, -s * g], [-s, -s * g - LINE], [-s, -s * g]];
    case 'se': return [[s, s * g], [s, s * g + w], [s, s * g], [s, s * g + LINE]];
    case 'sw': return [[-s, -s * g - w], [-s, -s * g], [s, s * g], [s, s * g + LINE]];
    case 'aboveMidRight': return [[0, -0.25 * w], [0, 0.75 * w], [-1, -g - LINE], [-1, -g]];
    case 'aboveMidLeft': return [[0, -0.75 * w], [0, 0.25 * w], [-1, -g - LINE], [-1, -g]];
    case 'belowMidRight': return [[0, -0.25 * w], [0, 0.75 * w], [1, g], [1, g + LINE]];
    case 'belowMidLeft': return [[0, -0.75 * w], [0, 0.25 * w], [1, g], [1, g + LINE]];
    case 'aboveRight': return [[0, 0], [0, w], [-1, -g - LINE], [-1, -g]];
    case 'aboveLeft': return [[0, -w], [0, 0], [-1, -g - LINE], [-1, -g]];
    case 'belowRight': return [[0, 0], [0, w], [1, g], [1, g + LINE]];
    case 'belowLeft': return [[0, -w], [0, 0], [1, g], [1, g + LINE]];
    case 'rightUp': return [[1, g], [1, g + w], [0, -LINE / 2 - 4], [0, LINE / 2 - 4]];
    case 'rightDown': return [[1, g], [1, g + w], [0, -LINE / 2 + 4], [0, LINE / 2 + 4]];
    case 'leftUp': return [[-1, -g - w], [-1, -g], [0, -LINE / 2 - 4], [0, LINE / 2 - 4]];
    default: return [[-1, -g - w], [-1, -g], [0, -LINE / 2 + 4], [0, LINE / 2 + 4]];
  }
}

function* spots(px, py, r, w, leftFirst) {
  const order = leftFirst ? MIRRORED_SIDES : LABEL_SIDES;
  for (const side of order) yield sideBox(px, py, r, w, side);
}

// Distance in px from a circle's edge to the nearest point of a box (0 when they touch).
export function boxGap(cx, cy, r, b) {
  const nx = Math.max(b.left, Math.min(cx, b.right));
  const ny = Math.max(b.top, Math.min(cy, b.bottom));
  return Math.max(0, Math.hypot(cx - nx, cy - ny) - r);
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
// gets one, always on one of its own labelCandidates() (LABELS.gap px from its circle). Of those,
// the cheapest: off the canvas worst, then each circle covered (its own never is), then reaching
// into the `padding` band at the canvas edges, then each label already placed it overlaps; ties
// keep the preferred order (right, left, above, below, the diagonals). A label above or below may
// slide sideways towards the inside, as long as it still spans its node. Returns
// [{index, x, y, align, left, right, top, bottom, side, covers: [circle node indices]}].
export function planLabels(projected, nodes, order, {
  width = Infinity, height = Infinity, max = LABELS.max, hubsOnly = false, padding = 0,
} = {}) {
  const picked = [];
  const circles = grid();
  for (const c of visibleCircles(projected, nodes, width, height)) {
    circles.add(c, Math.max(0, c.x - c.r), Math.max(0, c.y - c.r),
      Math.min(width, c.x + c.r), Math.min(height, c.y + c.r));
  }
  const placed = grid();
  const pad = LABELS.pad;
  const OFF = 1e9;
  const CIRCLE = 1e6;
  const BAND = 1e3;
  // Counts stop once past `limit`: a spot that can't beat the best so far needn't be counted out.
  const coveredBy = (b, limit = Infinity, out = null) => {
    let hits = 0;
    circles.some(b.left - pad, b.top - pad, b.right + pad, b.bottom + pad, (c) => {
      if (circleHitsBox(c.x, c.y, c.r + pad, b.left, b.top, b.right, b.bottom)) {
        hits += 1;
        out?.push(c.index);
      }
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
  const inside = (b, m) => b.left >= m && b.right <= width - m && b.top >= m && b.bottom <= height - m;
  const band = Math.max(0, Math.min(padding, width / 4, height / 4));
  const claim = (i) => {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) return false;
    const px = projected[k];
    const py = projected[k + 1];
    if (px < 0 || px > width || py < 0 || py > height) return false;
    const r = drawnRadius(nodes[i].radius, scale);
    const w = labelWidth(nodes[i].label);
    let chosen = null;
    let best = Infinity;
    for (const spot of spots(px, py, r, w, false)) {
      let candidate = spot;
      if (spot.align === 'center') {
        // Slide towards the inside of the padded area, keeping the node under the label's middle 80 %.
        const lo = band - spot.left;
        const hi = width - band - spot.right;
        const want = lo > 0 ? lo : hi < 0 ? hi : 0;
        const slide = Math.max(-0.4 * w, Math.min(0.4 * w, Number.isFinite(want) ? want : 0));
        if (slide) {
          candidate = box(spot.x + slide, spot.y, w, 'center');
          candidate.side = spot.side;
        }
      }
      let cost = inside(candidate, 0) ? 0 : OFF;
      if (cost >= best) continue;
      if (!inside(candidate, band)) cost += BAND;
      if (cost >= best) continue;
      cost += coveredBy(candidate, Math.floor((best - cost) / CIRCLE)) * CIRCLE;
      if (cost >= best) continue;
      cost += countLabels(candidate, best - cost - 1);
      if (cost < best) {
        chosen = candidate;
        best = cost;
        if (cost === 0) break;
      }
    }
    const covers = [];
    coveredBy(chosen, Infinity, covers);
    const entry = { index: i, ...chosen, covers: covers.filter((j) => j !== i) };
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

// Indices of the nodes to label (see planLabels).
export function pickLabels(projected, nodes, order, options = {}) {
  return planLabels(projected, nodes, order, options).map((entry) => entry.index);
}

// frame: {nodes, projected (graph-space.js project), order (back to front), links (flat node
// index pairs), dpr, width, height (CSS px), tier ('full'|'lite'|'static'), moving?, focusIndex
// (-1 for none), palette?, font?}. Returns what was drawn, for diagnostics and tests.
export function drawFrame(ctx, frame) {
  const { nodes, projected, order, links, dpr = 1, width, height, tier = 'full', moving = false, focusIndex = -1 } = frame;
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

  const labels = planLabels(projected, nodes, order, {
    width, height, hubsOnly: tier === 'lite' && moving, padding: frame.padding ?? 0,
  });
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
  return { circles, labels: labels.length, placed: labels };
}

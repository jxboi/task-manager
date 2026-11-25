// The graph view's drawing, over anything shaped like a CanvasRenderingContext2D: a flat page,
// hairline links, circles back to front and a few small monospace labels. Pure apart from the
// calls on `ctx`; src/graph-view.js owns the canvas and when to draw.

// Defaults matching the styles.css tokens; graph-view.js passes the live tokens when it can.
export const PALETTE = {
  bg: '#f4f4f1', // --page
  open: '#111111', // --ink
  done: '#c4c4bf',
  hub: '#8a8a85',
  link: 'rgba(17, 17, 17, 0.12)',
  label: '#4f4f4a', // --text-2
  hubLabel: '#111111',
  focus: '#111111',
};
export const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace'; // --mono
export const LABELS = {
  max: 40, // task labels per frame; hub labels always show
  cell: { width: 48, height: 14 }, // a label claims the grid cells it covers
  minRadius: 3, // CSS px a task has to reach on screen before it gets a label
  size: 10, // px
  charWidth: 7, // px per character at `size` with the letter spacing, for the grid
  gap: 4, // px between a circle and its label
  halo: 3, // px of page colour around each label, so it reads over circles and links
};
const MIN_DRAWN_RADIUS = 1.5; // CSS px; smaller circles aren't drawn

const colourFor = (palette, state) => (state === 'done' ? palette.done : state === 'hub' ? palette.hub : palette.open);

// Indices of the nodes to label, hubs first, then tasks from the front. A label goes where its
// circle is, to the right; it is skipped when it would overlap one already taken (by grid cell)
// or falls off the canvas. `hubsOnly` is the lite tier.
export function pickLabels(projected, nodes, order, {
  width = Infinity, height = Infinity, max = LABELS.max, cell = LABELS.cell, minRadius = LABELS.minRadius,
  hubsOnly = false,
} = {}) {
  const taken = new Set();
  const picked = [];
  const claim = (i) => {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) return false;
    const x = projected[k] + nodes[i].radius * scale + LABELS.gap;
    const y = projected[k + 1];
    const right = x + nodes[i].label.length * LABELS.charWidth;
    if (right < 0 || x > width || y < 0 || y > height) return false;
    // Every cell the text box covers, so labels in neighbouring rows can't overlap either.
    const cells = [];
    for (let row = Math.floor((y - LABELS.size / 2) / cell.height); row <= Math.floor((y + LABELS.size / 2) / cell.height); row += 1) {
      for (let col = Math.floor(x / cell.width); col <= Math.floor(right / cell.width); col += 1) {
        const key = `${col},${row}`;
        if (taken.has(key)) return false;
        cells.push(key);
      }
    }
    for (const key of cells) taken.add(key);
    picked.push(i);
    return true;
  };
  for (let n = order.length - 1; n >= 0; n -= 1) {
    if (nodes[order[n]].kind === 'hub') claim(order[n]);
  }
  if (hubsOnly) return picked;
  let tasks = 0;
  for (let n = order.length - 1; n >= 0 && tasks < max; n -= 1) {
    const i = order[n];
    if (nodes[i].kind !== 'task' || nodes[i].radius * projected[i * 4 + 2] < minRadius) continue;
    if (claim(i)) tasks += 1;
  }
  return picked;
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

  // Every link in one path and one stroke.
  ctx.beginPath();
  for (let l = 0; l < links.length; l += 2) {
    const a = links[l] * 4;
    const b = links[l + 1] * 4;
    if (!(projected[a + 2] > 0) || !(projected[b + 2] > 0)) continue;
    ctx.moveTo(projected[a], projected[a + 1]);
    ctx.lineTo(projected[b], projected[b + 1]);
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
    const r = nodes[i].radius * scale;
    const x = projected[k];
    const y = projected[k + 1];
    if (r < MIN_DRAWN_RADIUS || x + r < 0 || x - r > width || y + r < 0 || y - r > height) continue;
    const colour = colourFor(palette, nodes[i].state);
    if (colour !== fill) ctx.fillStyle = fill = colour;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    circles += 1;
  }

  if (focusIndex >= 0 && projected[focusIndex * 4 + 2] > 0) {
    const k = focusIndex * 4;
    ctx.beginPath();
    ctx.arc(projected[k], projected[k + 1], nodes[focusIndex].radius * projected[k + 2] + 3, 0, Math.PI * 2);
    ctx.strokeStyle = palette.focus;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  const labels = pickLabels(projected, nodes, order, { width, height, hubsOnly: tier !== 'full' });
  if (labels.length) {
    ctx.font = `500 ${LABELS.size}px ${frame.font ?? MONO}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.8px';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.strokeStyle = palette.bg;
    ctx.lineWidth = LABELS.halo;
    ctx.lineJoin = 'round';
    let ink = null;
    for (const i of labels) {
      const k = i * 4;
      const x = projected[k] + nodes[i].radius * projected[k + 2] + LABELS.gap;
      const colour = nodes[i].kind === 'hub' ? palette.hubLabel : palette.label;
      if (colour !== ink) ctx.fillStyle = ink = colour;
      ctx.strokeText(nodes[i].label, x, projected[k + 1]);
      ctx.fillText(nodes[i].label, x, projected[k + 1]);
    }
  }
  return { circles, labels: labels.length };
}

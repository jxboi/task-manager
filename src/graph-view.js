// The graph view: a canvas of tasks around their category hubs, and a list of the same tasks as
// buttons for keyboards, screen readers and devices without a 2D canvas. The only graph module
// src/app.js imports, and only on demand (import('./graph-view.js')). Owns all graph state:
// layout, camera, gestures, the frame loop and the quality tier.
import { toGraph } from './graph-data.js';
import { drawFrame, MONO, PALETTE } from './graph-draw.js';
import { createGesture, TAP_SLOP } from './graph-gesture.js';
import {
  createCamera, depthOrder, extent, focalLength, layout, lookAt, orbit, pick, project, zoom,
} from './graph-space.js';

// Quality tiers step down within a session, never up. 'list' is chosen at mount (no 2D canvas).
export const TIERS = ['full', 'lite', 'static'];
export const TIER_BUDGET = {
  full: { drawMs: 6, frames: 12, intervalMs: 24, intervals: 30 },
  lite: { drawMs: 12, frames: 12 },
};
export const DPR_CAP = { full: 2, lite: 1, static: 1 };
export const EASE_MS = 250; // hub re-centre
export const INERTIA = { decayMs: 325, minSpeed: 0.02, maxSpeed: 2 }; // px/ms: the spin stops below min
const IDLE_MS = 120; // after the last frame, the button positions and frame time are written
const STATS_FRAMES = 30;

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const easeOut = (t) => 1 - (1 - t) ** 3;

// The 2D context, or null when there is no canvas support (the list tier).
export function context2d(canvas) {
  try {
    return typeof canvas?.getContext === 'function' ? canvas.getContext('2d') ?? null : null;
  } catch {
    return null;
  }
}

// Measures the first frames of each tier and steps down when they are slow: the median draw time
// over the first `frames` draws, or (full only) the median interval over the first `intervals`
// gesture frames. Once a tier passes, it is no longer measured.
export function createTierMeter(tier = 'full', budget = TIER_BUDGET) {
  let draws;
  let intervals;
  const begin = () => {
    draws = budget[tier] ? [] : null; // null: not (or no longer) measured
    intervals = budget[tier]?.intervals ? [] : null;
  };
  const step = () => {
    tier = TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + 1)];
    begin();
    return tier;
  };
  // Adds a sample; once there are `count`, either steps down or stops measuring this kind.
  const sample = (samples, value, count, limit) => {
    samples.push(value);
    if (samples.length < count) return 'more';
    return median(samples) > limit ? 'slow' : 'ok';
  };
  begin();
  return {
    get tier() { return tier; },
    draw(ms) {
      if (!draws) return tier;
      const verdict = sample(draws, ms, budget[tier].frames, budget[tier].drawMs);
      if (verdict === 'slow') return step();
      if (verdict === 'ok') draws = null;
      return tier;
    },
    interval(ms) {
      if (!intervals) return tier;
      const verdict = sample(intervals, ms, budget[tier].intervals, budget[tier].intervalMs);
      if (verdict === 'slow') return step();
      if (verdict === 'ok') intervals = null;
      return tier;
    },
  };
}

// The static tier: the same layout seen from straight above, without perspective. Same output
// shape as graph-space.js project(); depth is height, so higher nodes draw on top.
export function projectFlat(positions, nodes, camera, viewport, out = null) {
  const result = out && out.length === nodes.length * 4 ? out : new Float32Array(nodes.length * 4);
  const scale = focalLength(viewport) / camera.distance;
  const { target } = camera;
  for (let i = 0; i < nodes.length; i += 1) {
    const p = positions.get(nodes[i].id);
    const k = i * 4;
    if (!p) {
      result[k] = result[k + 1] = result[k + 2] = 0;
      result[k + 3] = Infinity;
      continue;
    }
    result[k] = viewport.width / 2 + (p.x - target.x) * scale;
    result[k + 1] = viewport.height / 2 + (p.z - target.z) * scale;
    result[k + 2] = scale;
    result[k + 3] = -p.y;
  }
  return result;
}

function readPalette(root) {
  try {
    const style = getComputedStyle(root);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      palette: { ...PALETTE, bg: token('--page', PALETTE.bg), open: token('--ink', PALETTE.open),
        label: token('--text-2', PALETTE.label), hubLabel: token('--text', PALETTE.hubLabel) },
      font: token('--mono', MONO),
    };
  } catch {
    return { palette: PALETTE, font: MONO };
  }
}

// root: an empty element, sized by CSS. onOpenTask(todoId) opens the task. reducedMotion: a
// MediaQueryList, read live. clock: ms, for tests.
export function mountGraph(root, { onOpenTask, reducedMotion = null, clock = () => performance.now() } = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const list = document.createElement('ul');
  list.className = 'graph-a11y';
  const ctx = context2d(canvas);
  const meter = createTierMeter('full');
  const { palette, font } = readPalette(root);
  let tier = ctx ? 'full' : 'list';
  root.dataset.mode = tier;
  if (ctx) root.replaceChildren(canvas, list);
  else root.replaceChildren(list);

  let signature = null;
  let nodes = [];
  let positions = null;
  let index = new Map(); // node id -> node index
  let links = new Uint32Array(0);
  let projected = null;
  let order = null;
  let camera = null;
  let size = { width: 0, height: 0, dpr: 1 };
  let buttons = new Map(); // node id -> button
  let focusIndex = -1;
  let frameId = 0;
  let idleTimer = 0;
  let spin = null; // {vx, vy} px/ms after a flick
  let ease = null; // {from, to, start}
  let lastFrame = null; // {t, live}
  let destroyed = false;
  const drawTimes = [];
  const gesture = createGesture();
  const still = () => Boolean(reducedMotion?.matches);

  const measure = () => {
    const rect = (ctx ? canvas : root).getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, DPR_CAP[tier] ?? 1);
    size = { width: Math.max(0, rect.width || 0), height: Math.max(0, rect.height || 0), dpr };
    if (!ctx) return;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    schedule();
  };

  function schedule() {
    if (destroyed || !ctx || frameId) return;
    frameId = requestAnimationFrame(frame);
  }

  function setTier(next) {
    if (next === tier) return;
    tier = next;
    root.dataset.mode = tier;
    spin = null;
    measure();
  }

  function render() {
    if (!camera || !size.width || !size.height) return;
    const viewport = { width: size.width, height: size.height };
    projected = (tier === 'static' ? projectFlat : project)(positions, nodes, camera, viewport, projected);
    order = depthOrder(projected, order);
    const started = clock();
    drawFrame(ctx, {
      nodes, projected, order, links, dpr: size.dpr, width: size.width, height: size.height, tier, focusIndex,
      palette, font,
    });
    const ms = clock() - started;
    drawTimes.push(ms);
    if (drawTimes.length > STATS_FRAMES) drawTimes.shift();
    setTier(meter.draw(ms));
  }

  function frame(t) {
    frameId = 0;
    clearTimeout(idleTimer);
    if (destroyed) return;
    const dt = lastFrame ? Math.min(64, Math.max(0, t - lastFrame.t)) : 16;
    if (ease) {
      ease.start ??= t;
      const progress = Math.min(1, (t - ease.start) / EASE_MS);
      const k = easeOut(progress);
      camera = lookAt(camera, {
        x: ease.from.x + (ease.to.x - ease.from.x) * k,
        y: ease.from.y + (ease.to.y - ease.from.y) * k,
        z: ease.from.z + (ease.to.z - ease.from.z) * k,
      });
      if (progress >= 1) ease = null;
    }
    if (spin && !gesture.active) {
      camera = orbit(camera, spin.vx * dt, spin.vy * dt);
      const decay = Math.exp(-dt / INERTIA.decayMs);
      spin = { vx: spin.vx * decay, vy: spin.vy * decay };
      if (Math.hypot(spin.vx, spin.vy) < INERTIA.minSpeed) spin = null;
    }
    render();
    // Frames that follow each other in a gesture or animation measure the device's frame rate.
    const live = gesture.mode === 'orbit' || gesture.mode === 'pinch' || Boolean(spin || ease);
    if (live && lastFrame?.live) setTier(meter.interval(t - lastFrame.t));
    lastFrame = { t, live };
    if (spin || ease) schedule();
    else idleTimer = setTimeout(idle, IDLE_MS);
  }

  // At rest: where each task's button sits on the canvas (for tests and diagnostics), and the
  // median draw time.
  function idle() {
    if (destroyed) return;
    lastFrame = null;
    root.dataset.frameMs = median(drawTimes).toFixed(2);
    for (const [id, button] of buttons) {
      const k = index.get(id) * 4;
      if (projected && projected[k + 2] > 0) {
        button.dataset.x = String(Math.round(projected[k]));
        button.dataset.y = String(Math.round(projected[k + 1]));
      } else {
        delete button.dataset.x;
        delete button.dataset.y;
      }
    }
  }

  function renderList(todos) {
    const byTodo = new Map(todos.map((todo) => [todo.id, todo]));
    const focused = [...buttons.entries()].find(([, button]) => button === document.activeElement)?.[0];
    buttons = new Map();
    const groups = [];
    for (const hub of nodes) {
      if (hub.kind !== 'hub') continue;
      const item = document.createElement('li');
      const heading = document.createElement('h3');
      heading.className = 'graph-hub';
      heading.textContent = hub.label;
      const tasks = document.createElement('ul');
      tasks.setAttribute('aria-label', hub.label);
      for (const node of nodes) {
        if (node.hubId !== hub.id) continue;
        const todo = byTodo.get(node.todoId);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `graph-node is-${node.state}`;
        button.dataset.focusKey = JSON.stringify(['graph-node', node.todoId]);
        button.dataset.nodeId = node.id;
        button.textContent = todo?.text ?? node.label;
        if (node.state === 'done') button.setAttribute('aria-label', `${button.textContent}, done`);
        const row = document.createElement('li');
        row.append(button);
        tasks.append(row);
        buttons.set(node.id, button);
      }
      item.append(heading, tasks);
      groups.push(item);
    }
    list.replaceChildren(...groups);
    buttons.get(focused)?.focus();
  }

  const nodeOf = (target) => {
    const button = target?.closest?.('button');
    return button && list.contains(button) ? nodes[index.get(button.dataset.nodeId)] ?? null : null;
  };
  const onListClick = (event) => {
    const node = nodeOf(event.target);
    if (node) onOpenTask?.(node.todoId);
  };
  const onFocusIn = (event) => {
    const node = nodeOf(event.target);
    focusIndex = node ? index.get(node.id) : -1;
    schedule();
  };
  const onFocusOut = () => {
    focusIndex = -1;
    schedule();
  };

  function act(intent) {
    if (!intent || !camera) return;
    if (intent.type === 'orbit') {
      if (tier === 'static') return;
      camera = orbit(camera, intent.dx, intent.dy);
      schedule();
    } else if (intent.type === 'zoom') {
      camera = zoom(camera, intent.factor);
      schedule();
    } else if (intent.type === 'release') {
      const speed = Math.hypot(intent.vx, intent.vy);
      const cap = Math.min(1, INERTIA.maxSpeed / (speed || 1));
      spin = tier === 'full' && !still() && speed >= INERTIA.minSpeed ? { vx: intent.vx * cap, vy: intent.vy * cap } : null;
      schedule();
    } else if (intent.type === 'tap') {
      if (!projected) return;
      const rect = canvas.getBoundingClientRect();
      const slop = TAP_SLOP[intent.pointerType] ?? TAP_SLOP.mouse;
      const x = intent.x - (rect.left || 0);
      const y = intent.y - (rect.top || 0);
      // A circle under the finger wins over a nearer one that only reaches it with the slop.
      const id = pick(projected, nodes, x, y, 0) ?? pick(projected, nodes, x, y, slop);
      const node = id === null ? null : nodes[index.get(id)];
      if (node?.kind === 'task') onOpenTask?.(node.todoId);
      else if (node?.kind === 'hub') centreOn(node);
    }
  }

  function centreOn(hub) {
    const to = positions.get(hub.id);
    spin = null;
    if (still()) {
      ease = null;
      camera = lookAt(camera, to);
    } else ease = { from: { ...camera.target }, to, start: null };
    schedule();
  }

  const onDown = (event) => {
    spin = null;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): the gesture still works without capture.
    }
    act(gesture.down(event));
  };
  const onMove = (event) => act(gesture.move(event));
  const onUp = (event) => act(gesture.up(event));
  const onCancel = (event) => {
    gesture.cancel(event);
    spin = null;
  };
  // A touch tap acts on pointerup; the click the browser synthesizes after it would land on
  // whatever the tap opened (the task sheet's scrim, which closes it). The canvas needs no click.
  const onTouchEnd = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  const onWheel = (event) => {
    event.preventDefault();
    act(gesture.wheel(event));
  };
  const onMotion = () => {
    if (!still()) return;
    spin = null;
    if (ease) {
      camera = lookAt(camera, ease.to);
      ease = null;
      schedule();
    }
  };

  const canvasListeners = [
    ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onCancel],
    ['wheel', onWheel, { passive: false }], ['touchend', onTouchEnd, { passive: false }],
  ];
  if (ctx) for (const [type, handler, options] of canvasListeners) canvas.addEventListener(type, handler, options);
  list.addEventListener('click', onListClick);
  list.addEventListener('focusin', onFocusIn);
  list.addEventListener('focusout', onFocusOut);
  reducedMotion?.addEventListener?.('change', onMotion);
  const observer = ctx && typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  observer?.observe(root);
  if (ctx && !observer) globalThis.addEventListener?.('resize', measure);
  measure();

  return {
    update({ todos, categories, now }) {
      if (destroyed) return;
      const graph = toGraph(todos, categories, now);
      if (graph.signature === signature) return;
      signature = graph.signature;
      nodes = graph.nodes;
      positions = layout(graph, positions);
      index = new Map(nodes.map((node, i) => [node.id, i]));
      links = new Uint32Array(graph.links.length * 2);
      graph.links.forEach((link, l) => {
        links[l * 2] = index.get(link.source);
        links[l * 2 + 1] = index.get(link.target);
      });
      projected = null;
      order = null;
      focusIndex = -1;
      camera ??= createCamera(extent(positions, nodes));
      renderList(todos);
      schedule();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frameId) cancelAnimationFrame(frameId);
      clearTimeout(idleTimer);
      if (ctx) for (const [type, handler, options] of canvasListeners) canvas.removeEventListener(type, handler, options);
      list.removeEventListener('click', onListClick);
      list.removeEventListener('focusin', onFocusIn);
      list.removeEventListener('focusout', onFocusOut);
      reducedMotion?.removeEventListener?.('change', onMotion);
      observer?.disconnect();
      if (ctx && !observer) globalThis.removeEventListener?.('resize', measure);
      root.replaceChildren();
      delete root.dataset.mode;
      delete root.dataset.frameMs;
    },
  };
}

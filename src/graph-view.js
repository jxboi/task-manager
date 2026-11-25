// The graph view: a canvas of tasks around their category hubs, and a list of the same tasks as
// buttons for keyboards, screen readers and devices without a 2D canvas. The only graph module
// src/app.js imports, and only on demand (import('./graph-view.js')). Owns all graph state:
// layout, camera, gestures, the frame loop and the quality tier.
import { toGraph } from './graph-data.js';
import { drawFrame, labelWidth as drawLabelWidth, MONO, PALETTE, planLabels, sideExtents } from './graph-draw.js';
import { createGesture, TAP_SLOP } from './graph-gesture.js';
import {
  createCamera, depthOrder, DISTANCE, drawnRadius, extent, FIT_PADDING, fitCamera, frameCamera, groupOnScreen, layout, lookAt,
  nudgeLabels, orbit, pick, pickNearest, project, projectFlat, spreadOnScreen, zoom,
} from './graph-space.js';

export { projectFlat }; // the static tier's projection

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

function readPalette(root) {
  try {
    const style = getComputedStyle(root);
    const token = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    return {
      palette: { ...PALETTE, bg: token('--page', PALETTE.bg), open: token('--ink', PALETTE.open),
        label: token('--text-2', PALETTE.label), hubLabel: token('--ink', PALETTE.hubLabel), hub: token('--ink', PALETTE.hub) },
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
  let framed = false; // the camera has been fitted to a real viewport at least once
  let size = { width: 0, height: 0, dpr: 1 };
  let buttons = new Map(); // node id -> button
  let focusIndex = -1;
  let frameId = 0;
  let idleTimer = 0;
  let spin = null; // {vx, vy} px/ms after a flick
  let ease = null; // {from, to, start}
  let wheeling = false;
  let needsLabels = false;
  let lastFrame = null; // {t, live}
  let destroyed = false;
  const drawTimes = [];
  const gesture = createGesture();
  const gesturing = () => gesture.mode === 'orbit' || gesture.mode === 'pinch';
  const still = () => Boolean(reducedMotion?.matches);

  // Fits the camera including label bounding boxes (two passes so side flips at the new scale are caught).
  const fitWithLabels = (cam, pos, viewport, flat, reset = false) => {
    let fitted = reset ? fitCamera(cam, pos, nodes, viewport, undefined, { flat }) : cam;
    for (let pass = 0; pass < 2; pass += 1) {
      const proj = (flat ? projectFlat : project)(pos, nodes, fitted, viewport);
      const plan = planLabels(proj, nodes, depthOrder(proj), {
        width: viewport.width, height: viewport.height, padding: FIT_PADDING,
      });
      const labels = new Map();
      for (const entry of plan) {
        const node = nodes[entry.index];
        labels.set(node.id, sideExtents(entry.side, drawLabelWidth(node.label)));
      }
      fitted = fitCamera(fitted, pos, nodes, viewport, undefined, { flat, labels });
    }
    return fitted;
  };

  // Nudges nodes if any label still covers a circle or overlaps another label, keeping labels inside padding.
  const nudgeAndFit = (cam, pos, viewport, flat) => {
    const planFn = (proj, ord) => planLabels(proj, nodes, ord, {
      width: viewport.width, height: viewport.height, padding: FIT_PADDING,
    });
    let fitted = fitWithLabels(cam, pos, viewport, flat, true);
    let next = nudgeLabels(pos, nodes, fitted, viewport, planFn, { flat });
    fitted = fitWithLabels(fitted, next, viewport, flat, false);
    next = nudgeLabels(next, nodes, fitted, viewport, planFn, { flat, maxIterations: 6 });
    const proj = (flat ? projectFlat : project)(next, nodes, fitted, viewport);
    const out = planFn(proj, depthOrder(proj)).some((e) => (
      e.left < FIT_PADDING - 0.5 || e.right > viewport.width - FIT_PADDING + 0.5
      || e.top < FIT_PADDING - 0.5 || e.bottom > viewport.height - FIT_PADDING + 0.5
    ));
    if (out) fitted = fitWithLabels(fitted, next, viewport, flat, false);
    return { camera: fitted, positions: next };
  };

  // Fits the camera to the current viewport: the first time from the best starting angle, after
  // that (a resize, a moved node off screen, the static tier) keeping the user's angle.
  const refit = (spreadFlat = false) => {
    if (!camera || !positions || !(size.width > 0) || !(size.height > 0)) return;
    const viewport = { width: size.width, height: size.height };
    const flat = tier === 'static';
    const labelWidth = (node) => drawLabelWidth(node.label);
    spin = null;
    ease = null;
    if (framed && !spreadFlat) {
      // A refit (resize, moved node): fit first so all hubs are in view, group categories, nudge and fit labels.
      camera = fitCamera(camera, positions, nodes, viewport, undefined, { flat });
      positions = groupOnScreen(positions, nodes, camera, viewport, { flat, labelWidth, labelGap: 4 });
      ({ camera, positions } = nudgeAndFit(camera, positions, viewport, flat));
    } else if (framed) {
      // Into the static tier: its top view stacks circles the perspective view had apart.
      camera = fitCamera(camera, positions, nodes, viewport, undefined, { flat });
      positions = spreadOnScreen(positions, nodes, camera, viewport, { flat });
      positions = groupOnScreen(positions, nodes, camera, viewport, { flat, labelWidth, labelGap: 4 });
      ({ camera, positions } = nudgeAndFit(camera, positions, viewport, flat));
    } else {
      // The first view: the best angle, overlapping circles pushed apart on screen, grouped, then fitted with labels.
      camera = frameCamera(positions, nodes, viewport, undefined, { flat });
      positions = spreadOnScreen(positions, nodes, camera, viewport, { flat });
      positions = groupOnScreen(positions, nodes, camera, viewport, { flat, labelWidth, labelGap: 4 });
      ({ camera, positions } = nudgeAndFit(camera, positions, viewport, flat));
    }
    framed = true;
  };

  const measure = () => {
    const rect = (ctx ? canvas : root).getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, DPR_CAP[tier] ?? 1);
    const width = Math.max(0, rect.width || 0);
    const height = Math.max(0, rect.height || 0);
    const resized = width !== size.width || height !== size.height;
    size = { width, height, dpr };
    if (!ctx) return;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    if (resized || !framed) refit();
    schedule();
  };

  function schedule() {
    if (destroyed || !ctx || frameId) return;
    frameId = requestAnimationFrame(frame);
  }

  function setTier(next) {
    if (next === tier) return;
    const flatChanged = (next === 'static') !== (tier === 'static');
    tier = next;
    root.dataset.mode = tier;
    spin = null;
    measure();
    // The static tier's top view has other bounds than the perspective one.
    if (flatChanged) refit(tier === 'static');
  }

  function render(moving) {
    if (!camera || !size.width || !size.height) return;
    const viewport = { width: size.width, height: size.height };
    projected = (tier === 'static' ? projectFlat : project)(positions, nodes, camera, viewport, projected);
    order = depthOrder(projected, order);
    const started = clock();
    needsLabels = tier === 'lite' && moving;
    drawFrame(ctx, {
      nodes, projected, order, links, dpr: size.dpr, width: size.width, height: size.height, tier, focusIndex,
      moving, palette, font, padding: FIT_PADDING,
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
    // Frames that follow each other in a gesture or animation measure the device's frame rate.
    const live = gesturing() || Boolean(spin || ease);
    render(live || wheeling);
    if (live && lastFrame?.live) setTier(meter.interval(t - lastFrame.t));
    lastFrame = { t, live };
    if (spin || ease) schedule();
    else idleTimer = setTimeout(idle, IDLE_MS);
  }

  // At rest: where each task's button sits on the canvas (for tests and diagnostics), and the
  // median draw time.
  function idle() {
    if (destroyed) return;
    wheeling = false;
    // A wheel burst has no release event. Repaint once after its last frame, or let the
    // pointer release or animation's last frame restore the labels if one is still active.
    if (needsLabels && !gesturing() && !frameId) {
      schedule();
      return;
    }
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

  function setButtonTitle(button, text) {
    button.textContent = text;
    if (button.classList.contains('is-done')) button.setAttribute('aria-label', `${text}, done`);
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
        setButtonTitle(button, todo?.text ?? node.label);
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
      // About the wheel cursor, or the pinch midpoint (client px): what is under it stays under it,
      // following the fingers when their midpoint moves.
      const rect = canvas.getBoundingClientRect();
      const left = rect.left || 0;
      const top = rect.top || 0;
      const x = (intent.fromX ?? intent.cx) - left;
      const y = (intent.fromY ?? intent.cy) - top;
      // A moving midpoint is followed exactly at the depth of the node under it, if any.
      let depth;
      if (positions && tier !== 'static' && (intent.fromX !== undefined || intent.fromY !== undefined)) {
        // The last drawn frame can be a finger behind: project at the camera as it is now.
        const now = project(positions, nodes, camera, { width: size.width, height: size.height });
        const id = pick(now, nodes, x, y, 0) ?? pickNearest(now, nodes, x, y, TAP_SLOP.touch);
        if (id !== null) depth = now[index.get(id) * 4 + 3];
      }
      const viewport = { width: size.width, height: size.height };
      const flat = tier === 'static';
      camera = zoom(camera, intent.factor, { x, y, toX: intent.cx - left, toY: intent.cy - top, depth, viewport, flat });
      if (intent.factor > 1 && camera.distance === DISTANCE.max) {
        // Anchoring can slide the whole graph away. At the zoom-out limit, fit it back into
        // view if there isn't a visible circle left to zoom around.
        const check = (flat ? projectFlat : project)(positions, nodes, camera, viewport);
        const visible = nodes.some((node, i) => {
          const k = i * 4;
          const r = drawnRadius(node.radius, check[k + 2]);
          const px = check[k];
          const py = check[k + 1];
          return r > 0 && px + r >= 0 && px - r <= viewport.width && py + r >= 0 && py - r <= viewport.height;
        });
        if (!visible) {
          camera = lookAt(camera, { x: 0, y: 0, z: 0 });
          refit();
        }
      }
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
      // Try task circles, then hub strokes, then the nearest visible node within the touch slop.
      const id = pick(projected, nodes, x, y, 0) ?? pickNearest(projected, nodes, x, y, slop);
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
    if (event.pointerType === 'mouse' && event.button != null && event.button !== 0) return;
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
    if (needsLabels) schedule();
  };
  // A touch tap acts on pointerup; the click the browser synthesizes after it would land on
  // whatever the tap opened (the task sheet's scrim, which closes it). The canvas needs no click.
  const onTouchEnd = (event) => {
    if (event.cancelable) event.preventDefault();
  };
  const onWheel = (event) => {
    event.preventDefault();
    const intent = gesture.wheel(event);
    if (!intent) return;
    clearTimeout(idleTimer);
    wheeling = true;
    act(intent);
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
      if (graph.signature === signature) {
        // The canvas label can stay the same when the full title changes.
        for (const todo of todos) {
          const button = buttons.get(`task:${todo.id}`);
          if (button && button.textContent !== todo.text) setButtonTitle(button, todo.text);
        }
        return;
      }
      const previous = positions;
      signature = graph.signature;
      nodes = graph.nodes;
      positions = layout(graph, previous, { aspect: size.width > 0 && size.height > 0 ? size.height / size.width : 1 });
      index = new Map(nodes.map((node, i) => [node.id, i]));
      links = new Uint32Array(graph.links.length * 2);
      graph.links.forEach((link, l) => {
        links[l * 2] = index.get(link.source);
        links[l * 2 + 1] = index.get(link.target);
      });
      projected = null;
      order = null;
      focusIndex = -1;
      const viewport = { width: size.width, height: size.height };
      const hasViewport = ctx && size.width > 0 && size.height > 0;
      if (!camera) {
        camera = createCamera(extent(positions, nodes));
        refit(); // fills the canvas once it has a size (measure() fits it otherwise)
      } else if (hasViewport && !framed) {
        refit();
      } else if (hasViewport) {
        // Only adjust the camera when a moved or newly added node (e.g. category change or new hub)
        // falls outside the current viewport; edits that leave nodes visible keep the user's camera.
        const moved = [];
        for (let i = 0; i < nodes.length; i += 1) {
          const cur = positions.get(nodes[i].id);
          if (!cur) continue;
          const old = previous?.get(nodes[i].id);
          if (!old || old.x !== cur.x || old.y !== cur.y || old.z !== cur.z) moved.push(i);
        }
        if (moved.length) {
          const check = (tier === 'static' ? projectFlat : project)(positions, nodes, camera, viewport);
          const offscreen = moved.some((i) => {
            const k = i * 4;
            const scale = check[k + 2];
            if (!(scale > 0)) return true;
            const r = drawnRadius(nodes[i].radius, scale);
            return check[k] - r < 0 || check[k] + r > size.width || check[k + 1] - r < 0 || check[k + 1] + r > size.height;
          });
          if (offscreen) refit();
        }
      }
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

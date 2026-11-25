// The graph view's geometry, without the DOM: a deterministic 3D layout, an orbit camera,
// perspective projection, depth order and picking. Pure; positions are in world units.

export const LAYOUT_ITERATIONS = 40; // hard cap on the sibling-repulsion passes
export const FOV = 0.9; // vertical field of view, radians
export const PITCH_LIMIT = 1.4;
export const DISTANCE = { initial: 600, min: 120, max: 2400 };
export const ORBIT_RADIANS_PER_PX = 0.006;
export const MIN_SCREEN_RADIUS = 3; // CSS px; drawn circles and hit testing clamp to at least this

// On-screen radius in CSS px for a node with positive projection `scale`.
export function drawnRadius(radius, scale) {
  return scale > 0 ? Math.max(MIN_SCREEN_RADIUS, radius * scale) : 0;
}

const HUB_SPACING = 60; // hub sphere radius per sqrt(hub count)
const CLUSTER = { r0: 18, k: 7, gap: 4 };
const NEAR = 1;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// FNV-1a over the UTF-16 code units, 32-bit.
export function hash(text, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// Three numbers in [0, 1) from an id, the same on every machine.
function unit3(id) {
  const a = hash(id);
  const b = hash(id, a ^ 0x9e3779b9);
  const c = hash(id, b ^ 0x85ebca6b);
  return [a / 2 ** 32, b / 2 ** 32, c / 2 ** 32];
}

// Point `i` of `n` evenly spread on a sphere of `radius`.
export function fibonacciPoint(i, n, radius) {
  if (n <= 1) return { x: 0, y: 0, z: 0 };
  const y = 1 - (2 * (i + 0.5)) / n;
  const ring = Math.sqrt(1 - y * y);
  const angle = i * GOLDEN_ANGLE;
  return { x: radius * ring * Math.cos(angle), y: radius * y, z: radius * ring * Math.sin(angle) };
}

// Pushes apart overlapping points (each {x, y, z, r}); the first `fixed` don't move. Returns the
// passes used, at most `maxIterations`. Displacements are summed then applied (Jacobi), so the
// result doesn't depend on which pair comes first.
export function relax(points, fixed = 0, maxIterations = LAYOUT_ITERATIONS) {
  const n = points.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const dz = new Float64Array(n);
  let pass = 0;
  while (pass < maxIterations) {
    dx.fill(0);
    dy.fill(0);
    dz.fill(0);
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      for (let j = Math.max(i + 1, fixed); j < n; j += 1) {
        const a = points[i];
        const b = points[j];
        let ex = b.x - a.x;
        let ey = b.y - a.y;
        let ez = b.z - a.z;
        let d = Math.hypot(ex, ey, ez);
        const want = a.r + b.r + CLUSTER.gap;
        if (d >= want) continue;
        moved = true;
        if (d < 1e-6) {
          // Same spot: split along a direction from the pair's index, never NaN.
          [ex, ey, ez] = [Math.cos(j), Math.sin(j), 0.5];
          d = Math.hypot(ex, ey, ez);
        }
        const push = (want - d) / d;
        const share = i < fixed ? 1 : 0.5;
        if (i >= fixed) {
          dx[i] -= ex * push * share;
          dy[i] -= ey * push * share;
          dz[i] -= ez * push * share;
        }
        dx[j] += ex * push * share;
        dy[j] += ey * push * share;
        dz[j] += ez * push * share;
      }
    }
    pass += 1;
    if (!moved) break;
    for (let i = fixed; i < n; i += 1) {
      points[i].x += dx[i];
      points[i].y += dy[i];
      points[i].z += dz[i];
    }
  }
  return pass;
}

// Map<nodeId, {x, y, z, hubId}>. Hubs sit on a sphere in (label, id) order; each task starts in
// a direction hashed from its id around its hub, then siblings push apart. With `previous` (the
// last layout), nodes still on the same hub keep their place and only new ones are placed.
export function layout(graph, previous = null) {
  const hubs = graph.nodes.filter((node) => node.kind === 'hub');
  hubs.sort((a, b) => compare(a.label, b.label) || compare(a.id, b.id));
  const positions = new Map();
  const sphere = HUB_SPACING * Math.sqrt(hubs.length);
  hubs.forEach((hub, i) => {
    const kept = previous?.get(hub.id);
    const at = kept ?? fibonacciPoint(i, hubs.length, sphere);
    positions.set(hub.id, { x: at.x, y: at.y, z: at.z, hubId: null });
  });

  const clusters = new Map(hubs.map((hub) => [hub.id, []]));
  for (const node of graph.nodes) {
    if (node.kind === 'task' && clusters.has(node.hubId)) clusters.get(node.hubId).push(node);
  }
  for (const hub of hubs) {
    const tasks = clusters.get(hub.id).sort((a, b) => compare(a.id, b.id));
    const centre = positions.get(hub.id);
    const reach = CLUSTER.r0 + CLUSTER.k * Math.sqrt(tasks.length);
    const kept = [];
    const fresh = [];
    for (const task of tasks) {
      const old = previous?.get(task.id);
      if (old && old.hubId === hub.id) {
        kept.push({ id: task.id, x: old.x, y: old.y, z: old.z, r: task.radius });
        continue;
      }
      const [u, v, w] = unit3(task.id);
      const cosPolar = 1 - 2 * u;
      const ring = Math.sqrt(1 - cosPolar * cosPolar);
      const angle = 2 * Math.PI * v;
      const distance = hub.radius + task.radius + reach * (0.45 + 0.55 * w);
      fresh.push({
        id: task.id,
        x: centre.x + distance * ring * Math.cos(angle),
        y: centre.y + distance * cosPolar,
        z: centre.z + distance * ring * Math.sin(angle),
        r: task.radius,
      });
    }
    // The hub and kept tasks are fixed; only the new tasks move.
    const points = [{ id: hub.id, ...centre, r: hub.radius }, ...kept, ...fresh];
    if (fresh.length) relax(points, 1 + kept.length);
    for (const point of points.slice(1)) {
      positions.set(point.id, { x: point.x, y: point.y, z: point.z, hubId: hub.id });
    }
  }
  return positions;
}

// The furthest node from the origin plus its radius: what the camera has to fit.
export function extent(positions, nodes) {
  let reach = 0;
  for (const node of nodes) {
    const p = positions.get(node.id);
    if (p) reach = Math.max(reach, Math.hypot(p.x, p.y, p.z) + node.radius);
  }
  return reach;
}

// `reach`: from extent(); 0 gives the default distance.
export function createCamera(reach = 0) {
  const fit = reach > 0 ? (reach / Math.tan(FOV / 2)) * 1.15 + reach : DISTANCE.initial;
  return {
    yaw: 0.6,
    pitch: -0.35,
    distance: clamp(Math.max(DISTANCE.initial, fit), DISTANCE.min, DISTANCE.max),
    target: { x: 0, y: 0, z: 0 },
  };
}

// Fit the camera distance so the projected layout fills the viewport with `padding` CSS px
// of room on each side (for labels). `positions` and `nodes` are from layout(); `viewport`
// is {width, height}. The camera's yaw/pitch/target stay as given, only distance changes.
export function fitCamera(camera, positions, nodes, viewport, padding = 40, { flat = false } = {}) {
  const focal = focalLength(viewport);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const { target } = camera;
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const usableX = cx - padding;
  const usableY = cy - padding;

  // Find the camera distance where every node fits inside (cx ± usable, cy ± usable).
  // For each node: sx = cx + x1 * focal / (distance + z2), so |x1 * focal / (distance + z2)| <= usable.
  // Rearranging: distance >= |x1| * focal / usable - z2.
  let minDist = DISTANCE.min;
  for (const node of nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const x = p.x - target.x;
    const y = p.y - target.y;
    const z = p.z - target.z;
    let sxExtent;
    let syExtent;
    let z2;
    if (flat) {
      sxExtent = Math.abs(x);
      syExtent = Math.abs(z);
      z2 = 0;
    } else {
      const x1 = x * cosYaw - z * sinYaw;
      const z1 = x * sinYaw + z * cosYaw;
      const y2 = y * cosPitch - z1 * sinPitch;
      z2 = y * sinPitch + z1 * cosPitch;
      sxExtent = Math.abs(x1);
      syExtent = Math.abs(y2);
    }
    const r = node.radius;
    if (usableX > 0) minDist = Math.max(minDist, (sxExtent + r) * focal / usableX - z2);
    if (usableY > 0) minDist = Math.max(minDist, (syExtent + r) * focal / usableY - z2);
  }
  // Add a little margin (5%) so it isn't pixel-tight.
  const distance = clamp(minDist * 1.05, DISTANCE.min, DISTANCE.max);
  return { ...camera, distance };
}

// Drag right turns the scene right; pitch stops short of the poles.
export function orbit(camera, dxPx, dyPx) {
  return {
    ...camera,
    yaw: camera.yaw + dxPx * ORBIT_RADIANS_PER_PX,
    pitch: clamp(camera.pitch + dyPx * ORBIT_RADIANS_PER_PX, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

// factor > 1 moves away.
export function zoom(camera, factor) {
  if (!(factor > 0) || !Number.isFinite(factor)) return camera;
  return { ...camera, distance: clamp(camera.distance * factor, DISTANCE.min, DISTANCE.max) };
}

// Re-centres the orbit on a point (a tapped hub).
export function lookAt(camera, point) {
  return { ...camera, target: { x: point.x, y: point.y, z: point.z } };
}

export function focalLength({ width, height }) {
  return (0.5 * Math.min(width, height)) / Math.tan(FOV / 2);
}

// Per node, 4 floats: screen x, screen y (CSS px, y down), scale (px per world unit at that
// depth; 0 when behind the camera or without a position) and depth from the camera. Pass the
// last result as `out` to reuse it.
export function project(positions, nodes, camera, viewport, out = null) {
  const result = out && out.length === nodes.length * 4 ? out : new Float32Array(nodes.length * 4);
  const focal = focalLength(viewport);
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const { target } = camera;
  for (let i = 0; i < nodes.length; i += 1) {
    const p = positions.get(nodes[i].id);
    const k = i * 4;
    if (!p) {
      result[k] = result[k + 1] = result[k + 2] = 0;
      result[k + 3] = Infinity;
      continue;
    }
    const x = p.x - target.x;
    const y = p.y - target.y;
    const z = p.z - target.z;
    // Yaw about the vertical axis, then pitch about the horizontal one.
    const x1 = x * cosYaw - z * sinYaw;
    const z1 = x * sinYaw + z * cosYaw;
    const y2 = y * cosPitch - z1 * sinPitch;
    const z2 = y * sinPitch + z1 * cosPitch;
    const depth = camera.distance + z2;
    if (depth <= NEAR) {
      result[k] = result[k + 1] = result[k + 2] = 0;
      result[k + 3] = depth;
      continue;
    }
    const scale = focal / depth;
    result[k] = cx + x1 * scale;
    result[k + 1] = cy - y2 * scale;
    result[k + 2] = scale;
    result[k + 3] = depth;
  }
  return result;
}

// Node indices from back to front (painter's order); ties keep node order.
export function depthOrder(projected, out = null) {
  const n = projected.length / 4;
  const order = out && out.length === n ? out : new Uint16Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  return order.sort((a, b) => projected[b * 4 + 3] - projected[a * 4 + 3] || a - b);
}

// The id of the front-most node whose drawn radius plus `slopPx` covers (x, y), or null.
export function pick(projected, nodes, x, y, slopPx = 0) {
  let best = null;
  let bestDepth = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const reach = drawnRadius(nodes[i].radius, scale) + slopPx;
    const depth = projected[k + 3];
    if (depth < bestDepth && Math.hypot(projected[k] - x, projected[k + 1] - y) <= reach) {
      best = nodes[i].id;
      bestDepth = depth;
    }
  }
  return best;
}

// The id of the nearest visible node within `slopPx` of (x, y), by screen distance (not depth).
// Use when an exact hit missed: picks the circle the finger is closest to, not the front-most.
export function pickNearest(projected, nodes, x, y, slopPx) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const r = drawnRadius(nodes[i].radius, scale);
    const dist = Math.hypot(projected[k] - x, projected[k + 1] - y) - r;
    if (dist <= slopPx && dist < bestDist) {
      best = nodes[i].id;
      bestDist = dist;
    }
  }
  return best;
}

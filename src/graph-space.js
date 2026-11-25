// The graph view's geometry, without the DOM: a deterministic 3D layout, an orbit camera,
// perspective projection, depth order and picking. Pure; positions are in world units.

export const LAYOUT_ITERATIONS = 40; // hard cap on the sibling-repulsion passes
export const FOV = 0.5; // vertical field of view, radians: narrow, so near and far circles differ gently
export const PITCH_LIMIT = 1.4;
export const DISTANCE = { initial: 600, min: 40, max: 2400 };
export const ORBIT_RADIANS_PER_PX = 0.006;
export const MIN_SCREEN_RADIUS = 3; // CSS px; drawn circles and hit testing clamp to at least this

// On-screen radius in CSS px for a node with positive projection `scale`.
export function drawnRadius(radius, scale) {
  return scale > 0 ? Math.max(MIN_SCREEN_RADIUS, radius * scale) : 0;
}

// Layout collision radius = node radius + COLLISION_PAD, so two circles keep 2 × pad between them.
export const COLLISION_PAD = 6;
export const FIT_PADDING = 24; // CSS px between the fitted circles and the canvas edges
export const EDGE_MARGIN = 8; // CSS px: a fitted node's centre stays at least radius + this inside

const ASPECT_RANGE = [0.5, 2.2]; // the viewport aspects layout() stretches for
const ASPECT_SHARE = [0.5, 1.0]; // of the stretch: across (x, z) shrink, height (y) grows
const HUB_SPACING = 60; // hub sphere radius per sqrt(hub count)
const CLUSTER = { r0: 18, k: 7 };
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
        const want = a.r + b.r + 2 * COLLISION_PAD;
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
// a direction hashed from its id around its hub, then every new node is pushed clear of the
// others (collision radius = radius + COLLISION_PAD). With `previous` (the last layout), nodes
// still on the same hub keep their place and only new ones are placed. `aspect` (viewport height
// / width) stretches the hub sphere to match the screen, e.g. taller on a phone.
export function layout(graph, previous = null, { aspect = 1 } = {}) {
  const hubs = graph.nodes.filter((node) => node.kind === 'hub');
  hubs.sort((a, b) => compare(a.label, b.label) || compare(a.id, b.id));
  const positions = new Map();
  const sphere = HUB_SPACING * Math.sqrt(hubs.length);
  const stretch = clamp(Number.isFinite(aspect) && aspect > 0 ? aspect : 1, ASPECT_RANGE[0], ASPECT_RANGE[1]);
  const across = stretch ** -ASPECT_SHARE[0];
  const tall = stretch ** ASPECT_SHARE[1];
  hubs.forEach((hub, i) => {
    const kept = previous?.get(hub.id);
    const point = fibonacciPoint(i, hubs.length, sphere);
    const at = kept ?? { x: point.x * across, y: point.y * tall, z: point.z * across };
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
      positions.set(point.id, { x: point.x, y: point.y, z: point.z, hubId: hub.id, fresh: fresh.includes(point) });
    }
  }
  // Then across clusters: a new task may land on a neighbouring cluster's node. Hubs and kept
  // tasks stay put; only new tasks move.
  const radius = new Map(graph.nodes.map((node) => [node.id, node.radius]));
  const fixedPoints = [];
  const freshPoints = [];
  for (const [id, p] of positions) {
    (p.fresh ? freshPoints : fixedPoints).push({ id, x: p.x, y: p.y, z: p.z, r: radius.get(id) ?? 0, hubId: p.hubId });
  }
  if (freshPoints.length) relax([...fixedPoints, ...freshPoints], fixedPoints.length);
  for (const point of [...fixedPoints, ...freshPoints]) {
    positions.set(point.id, { x: point.x, y: point.y, z: point.z, hubId: point.hubId });
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

// Camera-space coordinates of the visible nodes, relative to the camera's target: `sx` right and
// `sy` up (world units) and `sz` towards the back. `flat` is the static tier's top-down view.
function cameraSpace(camera, positions, nodes, flat) {
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const { target } = camera;
  const out = [];
  for (const node of nodes) {
    const p = positions.get(node.id);
    if (!p) continue;
    const x = p.x - target.x;
    const y = p.y - target.y;
    const z = p.z - target.z;
    if (flat) {
      out.push({ sx: x, sy: -z, sz: 0, r: node.radius });
      continue;
    }
    const x1 = x * cosYaw - z * sinYaw;
    const z1 = x * sinYaw + z * cosYaw;
    out.push({ sx: x1, sy: y * cosPitch - z1 * sinPitch, sz: y * sinPitch + z1 * cosPitch, r: node.radius });
  }
  return out;
}

// The smallest distance at which every circle sits inside the viewport with `padding` px to
// spare around its drawn edge (drawn radius clamps to MIN_SCREEN_RADIUS), the target in the
// middle. Perspective: screen offset = s * focal / (distance + sz), solved for distance.
function fitDistance(points, focal, halfW, halfH, padding) {
  let distance = DISTANCE.min;
  for (const { sx, sy, sz, r } of points) {
    for (const [extentPx, half] of [[Math.abs(sx), halfW], [Math.abs(sy), halfH]]) {
      const room = half - padding;
      if (room <= MIN_SCREEN_RADIUS) continue;
      distance = Math.max(distance, ((extentPx + r) * focal) / room - sz, (extentPx * focal) / (room - MIN_SCREEN_RADIUS) - sz);
    }
  }
  return distance;
}

// Fit the camera to the projected layout: the target moves so the circles' screen bounds are
// centred, and the distance is the closest at which every circle stays `padding` CSS px inside
// the viewport (so a node's centre is at least its radius + padding from each edge). Yaw and
// pitch stay as given. `positions` and `nodes` are from layout(); `viewport` is {width, height}.
export function fitCamera(camera, positions, nodes, viewport, padding = FIT_PADDING, { flat = false } = {}) {
  const focal = focalLength(viewport);
  const halfW = viewport.width / 2;
  const halfH = viewport.height / 2;
  if (!(halfW > 0) || !(halfH > 0)) return camera;
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  // World directions of screen right and screen up for this yaw/pitch (or the flat top view).
  const right = flat ? { x: 1, y: 0, z: 0 } : { x: cosYaw, y: 0, z: -sinYaw };
  const up = flat ? { x: 0, y: 0, z: -1 } : { x: -sinPitch * sinYaw, y: cosPitch, z: -sinPitch * cosYaw };
  let target = { ...camera.target };
  let distance = camera.distance;
  // Centre the screen bounds (a few passes: perspective makes each shift slightly off), then fit.
  for (let pass = 0; pass < 4; pass += 1) {
    const points = cameraSpace({ ...camera, target }, positions, nodes, flat);
    if (!points.length) return camera;
    distance = clamp(fitDistance(points, focal, halfW, halfH, padding), DISTANCE.min, DISTANCE.max);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { sx, sy, sz, r } of points) {
      const depth = flat ? distance : distance + sz;
      if (depth <= NEAR) continue;
      const scale = focal / depth;
      const rr = Math.max(MIN_SCREEN_RADIUS, r * scale);
      minX = Math.min(minX, sx * scale - rr);
      maxX = Math.max(maxX, sx * scale + rr);
      minY = Math.min(minY, sy * scale - rr);
      maxY = Math.max(maxY, sy * scale + rr);
    }
    const world = distance / focal; // world units per px at the target's depth
    const shiftX = ((minX + maxX) / 2) * world;
    const shiftY = ((minY + maxY) / 2) * world;
    if (!Number.isFinite(shiftX) || !Number.isFinite(shiftY) || Math.hypot(shiftX, shiftY) < 1e-3) break;
    target = {
      x: target.x + right.x * shiftX + up.x * shiftY,
      y: target.y + right.y * shiftX + up.y * shiftY,
      z: target.z + right.z * shiftX + up.z * shiftY,
    };
  }
  distance = clamp(
    fitDistance(cameraSpace({ ...camera, target }, positions, nodes, flat), focal, halfW, halfH, padding),
    DISTANCE.min, DISTANCE.max,
  );
  return { ...camera, target, distance };
}

// Projected circles closer than 2 × COLLISION_PAD px, as a count of pairs.
function screenOverlaps(projected, nodes) {
  let overlaps = 0;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = i * 4;
    if (!(projected[a + 2] > 0)) continue;
    const ra = drawnRadius(nodes[i].radius, projected[a + 2]);
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = j * 4;
      if (!(projected[b + 2] > 0)) continue;
      const rb = drawnRadius(nodes[j].radius, projected[b + 2]);
      if (Math.hypot(projected[a] - projected[b], projected[a + 1] - projected[b + 1]) < ra + rb + 2 * COLLISION_PAD) overlaps += 1;
    }
  }
  return overlaps;
}

export const FRAME_YAWS = 12; // starting angles tried by frameCamera
export const FRAME_PITCHES = [-0.35, -0.6, -0.15];


// The starting camera: of a fixed set of yaw/pitch angles, the one that fills the viewport best
// (the closest fitted distance, e.g. a tall view on a phone), each pair of circles closer than
// 2 × COLLISION_PAD px on screen costing OVERLAP_COST of that. Deterministic; ties keep the
// earlier angle.
export const OVERLAP_COST = 0.3;
export function frameCamera(positions, nodes, viewport, padding = FIT_PADDING, { flat = false } = {}) {
  const base = createCamera(extent(positions, nodes));
  if (flat) return fitCamera(base, positions, nodes, viewport, padding, { flat });
  let best = null;
  let bestScore = Infinity;
  for (const pitch of FRAME_PITCHES) {
    for (let k = 0; k < FRAME_YAWS; k += 1) {
      const yaw = base.yaw + (2 * Math.PI * k) / FRAME_YAWS;
      const camera = fitCamera({ ...base, yaw, pitch }, positions, nodes, viewport, padding);
      const overlaps = screenOverlaps(project(positions, nodes, camera, viewport), nodes);
      const score = camera.distance * (1 + OVERLAP_COST * overlaps);
      if (score < bestScore - 1e-9) {
        best = camera;
        bestScore = score;
      }
    }
  }
  return best;
}

// The first view without overlaps: tasks whose circles come within 2 × COLLISION_PAD px of
// another circle on screen are pushed apart in the screen plane (world directions of screen right
// and up), hubs staying put. Returns a new positions Map; at most LAYOUT_ITERATIONS passes, summed
// then applied, so the result is deterministic. Refit the camera afterwards.
export function spreadOnScreen(positions, nodes, camera, viewport, { flat = false, maxIterations = LAYOUT_ITERATIONS } = {}) {
  const out = new Map([...positions].map(([id, p]) => [id, { ...p }]));
  const focal = focalLength(viewport);
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  const right = flat ? { x: 1, y: 0, z: 0 } : { x: cosYaw, y: 0, z: -sinYaw };
  const up = flat ? { x: 0, y: 0, z: -1 } : { x: -sinPitch * sinYaw, y: cosPitch, z: -sinPitch * cosYaw };
  const n = nodes.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  let projected = null;
  for (let pass = 0; pass < maxIterations; pass += 1) {
    projected = (flat ? projectFlat : project)(out, nodes, camera, viewport, projected);
    dx.fill(0);
    dy.fill(0);
    let moved = false;
    for (let i = 0; i < n; i += 1) {
      const a = i * 4;
      if (!(projected[a + 2] > 0)) continue;
      const ra = drawnRadius(nodes[i].radius, projected[a + 2]);
      for (let j = i + 1; j < n; j += 1) {
        const b = j * 4;
        if (!(projected[b + 2] > 0)) continue;
        const ia = nodes[i].kind === 'hub';
        const ib = nodes[j].kind === 'hub';
        if (ia && ib) continue;
        const want = ra + drawnRadius(nodes[j].radius, projected[b + 2]) + 2 * COLLISION_PAD;
        let ex = projected[b] - projected[a];
        let ey = projected[b + 1] - projected[a + 1];
        let d = Math.hypot(ex, ey);
        if (d >= want) continue;
        moved = true;
        if (d < 1e-6) {
          [ex, ey] = [Math.cos(i + j), Math.sin(i + j)];
          d = 1;
        }
        const push = (want - d) / d;
        // Screen px, split between the two (all to the task when the other is a hub).
        const shareA = ia ? 0 : ib ? 1 : 0.5;
        const shareB = 1 - shareA;
        dx[i] -= ex * push * shareA;
        dy[i] -= ey * push * shareA;
        dx[j] += ex * push * shareB;
        dy[j] += ey * push * shareB;
      }
    }
    if (!moved) break;
    for (let i = 0; i < n; i += 1) {
      if (!dx[i] && !dy[i]) continue;
      const p = out.get(nodes[i].id);
      const world = 1 / projected[i * 4 + 2]; // world units per px at the node's depth
      const sx = dx[i] * world;
      const sy = -dy[i] * world; // screen y runs down, `up` runs up
      p.x += right.x * sx + up.x * sy;
      p.y += right.y * sx + up.y * sy;
      p.z += right.z * sx + up.z * sy;
    }
  }
  return out;
}

// The static tier: the same layout seen from straight above, without perspective. Same output
// shape as project(); depth is height, so higher nodes draw on top.
export function projectFlat(positions, nodes, camera, viewport, out = null) {
  const result = out && out.length === nodes.length * 4 ? out : new Float32Array(nodes.length * 4);
  const scale = focalLength(viewport) / camera.distance;
  for (let i = 0; i < nodes.length; i += 1) {
    const p = positions.get(nodes[i].id);
    const k = i * 4;
    if (!p) {
      result[k] = result[k + 1] = result[k + 2] = 0;
      result[k + 3] = Infinity;
      continue;
    }
    result[k] = viewport.width / 2 + (p.x - camera.target.x) * scale;
    result[k + 1] = viewport.height / 2 + (p.z - camera.target.z) * scale;
    result[k + 2] = scale;
    result[k + 3] = -p.y;
  }
  return result;
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

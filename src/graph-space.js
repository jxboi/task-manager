// The graph view's geometry, without the DOM: a deterministic 3D layout, an orbit camera,
// perspective projection, depth order and picking. Pure; positions are in world units.

export const LAYOUT_ITERATIONS = 40; // hard cap on the sibling-repulsion passes
export const FOV = 0.5; // vertical field of view, radians: narrow, so near and far circles differ gently
export const PITCH_LIMIT = 1.4;
export const DISTANCE = { initial: 600, min: 40, max: 2400 };
export const ORBIT_RADIANS_PER_PX = 0.006;
export const MIN_SCREEN_RADIUS = 3; // CSS px; drawn circles and hit testing clamp to at least this
export const HUB_RING = 1.5; // CSS px; stroke centred on the hub's drawn radius

// On-screen radius in CSS px for a node with positive projection `scale`.
export function drawnRadius(radius, scale) {
  return scale > 0 ? Math.max(MIN_SCREEN_RADIUS, radius * scale) : 0;
}

// Layout collision radius = node radius + COLLISION_PAD, so two circles keep 2 × pad between them.
export const COLLISION_PAD = 6;
export const FIT_PADDING = 24; // CSS px between the fitted circles and the canvas edges
export const MAX_FIT_SCALE = 2.5; // CSS px per world unit: the closest a fit will come
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
// `labels` (optional): Map<node id, label extents> (see fitCamera), carried as `ext`.
function cameraSpace(camera, positions, nodes, flat, labels = null) {
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
    const ext = labels?.get(node.id) ?? null;
    if (flat) {
      out.push({ sx: x, sy: -z, sz: 0, r: node.radius, ext });
      continue;
    }
    const x1 = x * cosYaw - z * sinYaw;
    const z1 = x * sinYaw + z * cosYaw;
    out.push({ sx: x1, sy: y * cosPitch - z1 * sinPitch, sz: y * sinPitch + z1 * cosPitch, r: node.radius, ext });
  }
  return out;
}

// The smallest distance at which every circle sits inside the viewport with `padding` px to
// spare around its drawn edge (drawn radius clamps to MIN_SCREEN_RADIUS), the target in the
// middle. Perspective: screen offset = s * focal / (distance + sz), solved for distance.
function fitDistance(points, focal, halfW, halfH, padding) {
  // Never closer than MAX_FIT_SCALE px per world unit at the target: a small graph (or the static
  // tier's top view of a tall layout) shouldn't balloon into huge circles.
  let distance = Math.max(DISTANCE.min, focal / MAX_FIT_SCALE);
  for (const { sx, sy, sz, r, ext } of points) {
    for (const [extentPx, half] of [[Math.abs(sx), halfW], [Math.abs(sy), halfH]]) {
      const room = half - padding;
      if (room <= MIN_SCREEN_RADIUS) continue;
      distance = Math.max(distance, ((extentPx + r) * focal) / room - sz, (extentPx * focal) / (room - MIN_SCREEN_RADIUS) - sz);
    }
    if (!ext) continue;
    // A label edge sits at (sPos + k * r) * scale + c px from the target (or sPos * scale + k * MIN_SCREEN_RADIUS + c when clamped).
    labelEdges(sx, sy, ext, (sigma, k, sPos, c, axis) => {
      const room = (axis === 'x' ? halfW : halfH) - padding;
      const freeUnclamped = room - sigma * c;
      const aUnclamped = sPos + k * r;
      if (sigma * aUnclamped > 0 && freeUnclamped > 0) {
        distance = Math.max(distance, (sigma * aUnclamped * focal) / freeUnclamped - sz);
      }
      const freeClamped = room - sigma * (c + k * MIN_SCREEN_RADIUS);
      if (sigma * sPos > 0 && freeClamped > 0) {
        distance = Math.max(distance, (sigma * sPos * focal) / freeClamped - sz);
      }
    });
  }
  return distance;
}

// Calls fn(σ, k, sPos, c, axis) for each outer edge of a label box: screen offset from target
// is sPos * scale + k * drawnRadius + c (screen y down), and σ is −1 for left/top, +1 for right/bottom.
function labelEdges(sx, sy, ext, fn) {
  const [[kl, cl], [kr, cr], [kt, ct], [kb, cb]] = ext;
  fn(-1, kl, sx, cl, 'x');
  fn(1, kr, sx, cr, 'x');
  fn(-1, kt, -sy, ct, 'y');
  fn(1, kb, -sy, cb, 'y');
}

// World directions of screen right, screen up and view depth for the camera's yaw/pitch (or the flat top view).
function screenAxes(camera, flat) {
  if (flat) return { right: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 0, z: -1 }, forward: { x: 0, y: -1, z: 0 } };
  const cosYaw = Math.cos(camera.yaw);
  const sinYaw = Math.sin(camera.yaw);
  const cosPitch = Math.cos(camera.pitch);
  const sinPitch = Math.sin(camera.pitch);
  return {
    right: { x: cosYaw, y: 0, z: -sinYaw },
    up: { x: -sinPitch * sinYaw, y: cosPitch, z: -sinPitch * cosYaw },
    forward: { x: cosPitch * sinYaw, y: sinPitch, z: cosPitch * cosYaw },
  };
}

// Fit the camera to the projected layout: the target moves so the circles' screen bounds are
// centred, and the distance is the closest at which every circle stays `padding` CSS px inside
// the viewport (so a node's centre is at least its radius + padding from each edge). Yaw and
// pitch stay as given. `positions` and `nodes` are from layout(); `viewport` is {width, height}.
//
// `labels` (optional): Map<node id, [[k, c] × left, right, top, bottom]> of each label box's
// edges relative to its node's centre as k × drawn radius + c px (screen y down; graph-draw.js
// sideExtents()): those boxes are kept inside the padding too and count in the centring.
export function fitCamera(camera, positions, nodes, viewport, padding = FIT_PADDING, { flat = false, labels = null } = {}) {
  const focal = focalLength(viewport);
  const halfW = viewport.width / 2;
  const halfH = viewport.height / 2;
  if (!(halfW > 0) || !(halfH > 0)) return camera;
  const { right, up } = screenAxes(camera, flat);
  let target = { ...camera.target };
  let distance = camera.distance;
  // Centre the screen bounds (a few passes: perspective makes each shift slightly off), then fit.
  for (let pass = 0; pass < 4; pass += 1) {
    const points = cameraSpace({ ...camera, target }, positions, nodes, flat, labels);
    if (!points.length) return camera;
    distance = clamp(fitDistance(points, focal, halfW, halfH, padding), DISTANCE.min, DISTANCE.max);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const { sx, sy, sz, r, ext } of points) {
      const depth = flat ? distance : distance + sz;
      if (depth <= NEAR) continue;
      const scale = focal / depth;
      const rr = Math.max(MIN_SCREEN_RADIUS, r * scale);
      minX = Math.min(minX, sx * scale - rr);
      maxX = Math.max(maxX, sx * scale + rr);
      minY = Math.min(minY, sy * scale - rr);
      maxY = Math.max(maxY, sy * scale + rr);
      if (!ext) continue;
      // Label boxes, in the same up-positive y as the circles.
      labelEdges(sx, sy, ext, (_sigma, k, sPos, c, axis) => {
        const at = sPos * scale + k * rr + c;
        if (axis === 'x') {
          minX = Math.min(minX, at);
          maxX = Math.max(maxX, at);
        } else {
          minY = Math.min(minY, -at);
          maxY = Math.max(maxY, -at);
        }
      });
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
    fitDistance(cameraSpace({ ...camera, target }, positions, nodes, flat, labels), focal, halfW, halfH, padding),
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

// Moves nodes in the screen plane: `moves` is Map<node index, [dx, dy]> in CSS px (y down) at the
// node's depth. Returns a new positions Map.
export function shiftOnScreen(positions, nodes, camera, viewport, moves, { flat = false } = {}) {
  const out = new Map([...positions].map(([id, p]) => [id, { ...p }]));
  const projected = (flat ? projectFlat : project)(positions, nodes, camera, viewport);
  const { right, up } = screenAxes(camera, flat);
  for (const [i, [dx, dy]] of moves) {
    const scale = projected[i * 4 + 2];
    const p = out.get(nodes[i]?.id);
    if (!p || !(scale > 0)) continue;
    const sx = dx / scale;
    const sy = -dy / scale;
    p.x += right.x * sx + up.x * sy;
    p.y += right.y * sx + up.y * sy;
    p.z += right.z * sx + up.z * sy;
  }
  return out;
}

export const GROUP_GAP = 28; // CSS px between neighbouring categories' boxes on screen

// Each category its own group on screen: every hub gets a reserved spot, a cell of a grid shaped
// to the viewport (as many columns as fill it best, then spread to its aspect), and moves there
// with all its tasks, rigidly in 3D (one world shift per category, at the hub's depth). A
// category's box is its circles plus, per node, a label of `labelWidth(node)` px on the side
// away from its hub. Hubs are assigned to cells in their current screen order (rows by y, then
// x), so the view changes as little as it can. Deterministic, no iteration. Returns a new
// positions Map; refit the camera afterwards.
export function groupOnScreen(positions, nodes, camera, viewport, {
  flat = false, padding = FIT_PADDING, labelWidth = () => 0, gap = GROUP_GAP, labelGap = 4,
} = {}) {
  const projected = (flat ? projectFlat : project)(positions, nodes, camera, viewport);
  const groups = new Map();
  nodes.forEach((node, i) => {
    if (node.kind === 'hub' && projected[i * 4 + 2] > 0) groups.set(node.id, { hub: i, members: [i] });
  });
  if (groups.size < 2) return new Map([...positions].map(([id, p]) => [id, { ...p }]));
  nodes.forEach((node, i) => {
    if (node.kind === 'task' && projected[i * 4 + 2] > 0) groups.get(node.hubId)?.members.push(i);
  });
  let maxW = 0;
  let maxH = 0;
  for (const group of groups.values()) {
    const hx = projected[group.hub * 4];
    let [left, right, top, bottom] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const i of group.members) {
      const k = i * 4;
      const x = projected[k];
      const y = projected[k + 1];
      const r = drawnRadius(nodes[i].radius, projected[k + 2]);
      const w = labelWidth(nodes[i]);
      const toRight = i === group.hub || x >= hx;
      left = Math.min(left, x - r - (toRight ? 0 : labelGap + w));
      right = Math.max(right, x + r + (toRight ? labelGap + w : 0));
      top = Math.min(top, y - Math.max(r, 6));
      bottom = Math.max(bottom, y + Math.max(r, 6));
    }
    const gw = right - left;
    const gh = bottom - top;
    Object.assign(group, { cx: (left + right) / 2, cy: (top + bottom) / 2, w: gw, h: gh });
    maxW = Math.max(maxW, gw);
    maxH = Math.max(maxH, gh);
  }
  const cellW = maxW + gap;
  const cellH = maxH + gap;
  const count = groups.size;
  const availW = Math.max(1, viewport.width - 2 * padding);
  const availH = Math.max(1, viewport.height - 2 * padding);
  let cols = 1;
  let bestFill = -Infinity;
  for (let c = 1; c <= count; c += 1) {
    const rows = Math.ceil(count / c);
    if (c > 1 && rows === Math.ceil(count / (c - 1))) continue; // a column more, no row fewer
    const fill = Math.min(availW / (c * cellW), availH / (rows * cellH));
    if (fill > bestFill + 1e-9) {
      bestFill = fill;
      cols = c;
    }
  }
  const rows = Math.ceil(count / cols);
  const sorted = [...groups.values()].sort((a, b) => a.cy - b.cy || a.hub - b.hub);
  const grid = [];
  const rowH = [];
  const colW = new Array(cols).fill(0);
  for (let r = 0; r < rows; r += 1) {
    const line = sorted.slice(r * cols, r * cols + cols).sort((a, b) => a.cx - b.cx || a.hub - b.hub);
    grid.push(line);
    rowH.push(Math.max(...line.map((g) => g.h)));
    if (line.length === cols) line.forEach((g, c) => { colW[c] = Math.max(colW[c], g.w); });
  }
  for (let c = 0; c < cols; c += 1) if (!colW[c]) colW[c] = maxW;
  // Expand gap spacing so the grid fills the padded viewport evenly at MAX_FIT_SCALE, while
  // keeping sparse 2-group layouts from drifting to opposite corners of a wide screen.
  const scales = [...groups.values()].map((g) => projected[g.hub * 4 + 2]).sort((a, b) => a - b);
  const ratio = scales[scales.length >> 1] / MAX_FIT_SCALE;
  const targetW = availW * ratio;
  const targetH = availH * ratio;
  const sumH = rowH.reduce((a, b) => a + b, 0);
  const sumW = colW.reduce((a, b) => a + b, 0);
  const extraY = Math.max(0, targetH - (sumH + (rows - 1) * gap));
  const extraX = Math.max(0, targetW - (sumW + (cols - 1) * gap));
  const gapY = rows > 1 ? gap + (count > 2 ? extraY / (rows - 1) : Math.min(extraY, 1.5 * maxH)) : 0;
  const gapX = cols > 1 ? gap + (count > 2 ? extraX / (cols - 1) : Math.min(extraX, 1.5 * maxW)) : 0;
  const totalH = sumH + (rows - 1) * gapY;
  const totalW = sumW + (cols - 1) * gapX;
  const { right, up, forward } = screenAxes(camera, flat);
  const meanDepth = [...groups.values()].reduce((s, g) => s + projected[g.hub * 4 + 3], 0) / groups.size;
  const out = new Map([...positions].map(([id, p]) => [id, { ...p }]));
  let curY = viewport.height / 2 - totalH / 2;
  for (let row = 0; row < rows; row += 1) {
    const line = grid[row];
    const spotY = curY + rowH[row] / 2;
    curY += rowH[row] + gapY;
    const lineW = line.reduce((a, g) => a + g.w, 0) + (line.length - 1) * gapX;
    let curX = line.length === cols ? viewport.width / 2 - totalW / 2 : viewport.width / 2 - lineW / 2;
    line.forEach((group, col) => {
      const cw = line.length === cols ? colW[col] : group.w;
      const spotX = curX + cw / 2;
      curX += cw + gapX;
      const scale = projected[group.hub * 4 + 2];
      const sx = (spotX - group.cx) / scale;
      const sy = -(spotY - group.cy) / scale;
      // Gently pull hubs towards their mean depth so no cluster looms over another, while keeping 3D depth.
      const sz = flat ? 0 : 0.65 * (meanDepth - projected[group.hub * 4 + 3]);
      const shift = {
        x: right.x * sx + up.x * sy + forward.x * sz,
        y: right.y * sx + up.y * sy + forward.y * sz,
        z: right.z * sx + up.z * sy + forward.z * sz,
      };
      // The hub's tasks in the layout (even off screen) move with it.
      const hubId = nodes[group.hub].id;
      for (const node of nodes) {
        if (node.id !== hubId && node.hubId !== hubId) continue;
        const p = out.get(node.id);
        if (!p) continue;
        p.x += shift.x;
        p.y += shift.y;
        p.z += shift.z;
      }
    });
  }
  return out;
}

// Nudges task nodes on screen when a label covers another circle or overlaps another label.
// Deterministic and capped at `maxIterations` passes; hubs stay put when a task can move, and
// nodes stay inside the padded viewport.
export function nudgeLabels(positions, nodes, camera, viewport, planFn, {
  flat = false, padding = FIT_PADDING, maxIterations = 12,
} = {}) {
  let current = new Map([...positions].map(([id, p]) => [id, { ...p }]));
  const projectFn = flat ? projectFlat : project;
  const pad = 1;
  for (let pass = 0; pass < maxIterations; pass += 1) {
    const projected = projectFn(current, nodes, camera, viewport);
    const order = depthOrder(projected);
    const plan = planFn(projected, order);
    const moves = new Map();
    const addMove = (idx, dx, dy) => {
      const prev = moves.get(idx) ?? [0, 0];
      moves.set(idx, [prev[0] + dx, prev[1] + dy]);
    };
    for (const entry of plan) {
      if (!entry.covers?.length) continue;
      for (const cIdx of entry.covers) {
        const moveIdx = nodes[entry.index].kind === 'task' ? entry.index
          : nodes[cIdx].kind === 'task' ? cIdx : -1;
        if (moveIdx < 0) continue;
        const otherIdx = moveIdx === entry.index ? cIdx : entry.index;
        const sign = moveIdx === entry.index ? 1 : -1;
        const myY = projected[moveIdx * 4 + 1];
        const cy = projected[cIdx * 4 + 1];
        const cr = drawnRadius(nodes[cIdx].radius, projected[cIdx * 4 + 2]);
        // Vertical shift to clear the circle with a horizontal label (avoiding opposite-side flip oscillation).
        const down = (cy + cr + pad + 8) - myY;
        const up = (cy - cr - pad - 8) - myY;
        const dyClear = myY < cy ? up : down;
        if (Math.abs(dyClear) <= 44) {
          addMove(moveIdx, 0, sign * dyClear);
        } else {
          const dx = projected[moveIdx * 4] - projected[otherIdx * 4];
          const dy = projected[moveIdx * 4 + 1] - projected[otherIdx * 4 + 1];
          const d = Math.hypot(dx, dy) || 1;
          addMove(moveIdx, (dx / d) * 16, (dy / d) * 16);
        }
      }
    }
    for (let a = 0; a < plan.length; a += 1) {
      const ba = plan[a];
      for (let b = a + 1; b < plan.length; b += 1) {
        const bb = plan[b];
        if (!(ba.left - pad < bb.right && bb.left - pad < ba.right
          && ba.top - pad < bb.bottom && bb.top - pad < ba.bottom)) continue;
        const ta = nodes[ba.index].kind === 'task';
        const tb = nodes[bb.index].kind === 'task';
        if (!ta && !tb) continue;
        const [topBox, botBox] = ba.y <= bb.y ? [ba, bb] : [bb, ba];
        const need = (topBox.bottom + pad + 2) - botBox.top;
        const push = clamp(need, 4, 24);
        if (ta && tb) {
          addMove(topBox.index, 0, -push * 0.55);
          addMove(botBox.index, 0, push * 0.55);
        } else {
          const moveIdx = tb ? bb.index : ba.index;
          const sign = moveIdx === botBox.index ? 1 : -1;
          addMove(moveIdx, 0, sign * push);
        }
      }
    }
    if (!moves.size) break;
    for (const [idx, [dx, dy]] of moves) {
      const len = Math.hypot(dx, dy);
      let mx = len > 20 ? (dx / len) * 20 : dx;
      let my = len > 20 ? (dy / len) * 20 : dy;
      const px = projected[idx * 4];
      const py = projected[idx * 4 + 1];
      const r = drawnRadius(nodes[idx].radius, projected[idx * 4 + 2]);
      const minX = Math.min(viewport.width / 2, padding + r);
      const maxX = Math.max(viewport.width / 2, viewport.width - padding - r);
      const minY = Math.min(viewport.height / 2, padding + r);
      const maxY = Math.max(viewport.height / 2, viewport.height - padding - r);
      mx = clamp(px + mx, minX, maxX) - px;
      my = clamp(py + my, minY, maxY) - py;
      moves.set(idx, [mx, my]);
    }
    current = shiftOnScreen(current, nodes, camera, viewport, moves, { flat });
    current = spreadOnScreen(current, nodes, camera, viewport, { flat, maxIterations: 8 });
  }
  return current;
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

// factor > 1 moves away. With an `anchor` {x, y, viewport, flat} (CSS px on the canvas), the
// target slides in the screen plane so whatever is under that point stays under it: a point at
// screen offset o from the centre is at o × (distance + depth) / focal from the target's line of
// sight, so shifting the target by o × (old − new distance) / focal keeps it at o, at any depth.
// `toX`/`toY` (a pinch whose midpoint moved) carry that point there instead: exact at `depth`
// (project()'s depth of the node under the fingers; the target's own depth without one) and
// off by the parallax at other depths.
export function zoom(camera, factor, anchor = null) {
  if (!(factor > 0) || !Number.isFinite(factor)) return camera;
  const distance = clamp(camera.distance * factor, DISTANCE.min, DISTANCE.max);
  const viewport = anchor?.viewport;
  if (!viewport || !(viewport.width > 0) || !(viewport.height > 0)
    || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
    return { ...camera, distance };
  }
  const toX = Number.isFinite(anchor.toX) ? anchor.toX : anchor.x;
  const toY = Number.isFinite(anchor.toY) ? anchor.toY : anchor.y;
  if (distance === camera.distance && toX === anchor.x && toY === anchor.y) return { ...camera, distance };
  const focal = focalLength(viewport);
  const halfW = viewport.width / 2;
  const halfH = viewport.height / 2;
  // Screen y runs down, `up` runs up.
  // The anchored point's depth beyond the target's plane (0 in the flat view: no perspective).
  const behind = !anchor.flat && Number.isFinite(anchor.depth) && anchor.depth > NEAR ? anchor.depth - camera.distance : 0;
  const ox = ((anchor.x - halfW) * (camera.distance + behind) - (toX - halfW) * (distance + behind)) / focal;
  const oy = ((halfH - anchor.y) * (camera.distance + behind) - (halfH - toY) * (distance + behind)) / focal;
  const { right, up } = screenAxes(camera, Boolean(anchor.flat));
  const { target } = camera;
  return {
    ...camera,
    distance,
    target: {
      x: target.x + right.x * ox + up.x * oy,
      y: target.y + right.y * ox + up.y * oy,
      z: target.z + right.z * ox + up.z * oy,
    },
  };
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

function hitDistance(node, scale, dx, dy) {
  const fromEdge = Math.hypot(dx, dy) - drawnRadius(node.radius, scale);
  return node.kind === 'hub' ? Math.abs(fromEdge) - HUB_RING / 2 : fromEdge;
}

// The front-most exact task hit takes priority. Other hits use depth order.
export function pick(projected, nodes, x, y, slopPx = 0) {
  let best = null;
  let bestDepth = Infinity;
  let exactTask = null;
  let exactTaskDepth = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const node = nodes[i];
    const dist = hitDistance(node, scale, projected[k] - x, projected[k + 1] - y);
    const depth = projected[k + 3];
    if (node.kind !== 'hub' && dist <= 0) {
      if (depth < exactTaskDepth) {
        exactTask = node.id;
        exactTaskDepth = depth;
      }
    } else if (dist <= slopPx && depth < bestDepth) {
      best = node.id;
      bestDepth = depth;
    }
  }
  return exactTask ?? best;
}

// After an exact miss, pick the nearest visible circle or ring within `slopPx`.
export function pickNearest(projected, nodes, x, y, slopPx) {
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const k = i * 4;
    const scale = projected[k + 2];
    if (!(scale > 0)) continue;
    const dist = hitDistance(nodes[i], scale, projected[k] - x, projected[k + 1] - y);
    if (dist <= slopPx && dist < bestDist) {
      best = nodes[i].id;
      bestDist = dist;
    }
  }
  return best;
}

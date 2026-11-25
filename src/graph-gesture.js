// The graph view's pointer gestures, without the DOM: one pointer orbits or taps, two pinch, the
// wheel zooms. Pure; inputs are plain {pointerId, pointerType, clientX, clientY, timeStamp}
// objects (a PointerEvent fits), and each call returns an intent or null:
//   {type: 'orbit', dx, dy}            drag, CSS px since the last intent
//   {type: 'zoom', factor, cx, cy}     factor > 1 moves away (graph-space.js zoom) about client
//                                      px cx/cy; a pinch adds fromX/fromY, the midpoint before
//   {type: 'tap', x, y, pointerType}   client px where the pointer came up
//   {type: 'release', vx, vy}          an orbit ended; px per ms over the last moments

export const TAP_SLOP = { mouse: 4, touch: 10, pen: 6 }; // CSS px a tap may wander
export const TAP_MS = 600; // longer is a press, not a tap
export const WHEEL_SPEED = 0.0015; // zoom per wheel px
export const WHEEL_STEP = { line: 16, page: 800, max: 400 }; // px per line and page; per-event cap
export const PINCH_WHEEL_BOOST = 6; // trackpad pinch arrives as small ctrl+wheel deltas
const VELOCITY_MS = 80; // the moves that count for the release speed

const slopFor = (pointerType) => TAP_SLOP[pointerType] ?? TAP_SLOP.mouse;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createGesture() {
  const pointers = new Map(); // pointerId -> {x, y, startX, startY, startT, type}
  let mode = 'idle'; // 'press' (could still be a tap) | 'orbit' | 'pinch'
  let spread = 0; // last distance between the two pinch pointers
  let samples = []; // recent orbit positions, for the release speed

  const pair = () => [...pointers.values()].slice(0, 2);
  const distance = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
  const reset = () => {
    pointers.clear();
    mode = 'idle';
    spread = 0;
    samples = [];
  };
  const sample = (p, t) => {
    samples.push({ x: p.x, y: p.y, t });
    while (samples.length > 2 && t - samples[0].t > VELOCITY_MS) samples.shift();
  };

  return {
    get active() { return pointers.size > 0; },
    get mode() { return mode; },

    down(e) {
      if (e.pointerType === 'mouse' && e.button != null && e.button !== 0) return null;
      if (pointers.has(e.pointerId) || pointers.size >= 2) return null;
      pointers.set(e.pointerId, {
        x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, startT: e.timeStamp, type: e.pointerType,
      });
      if (pointers.size === 1) {
        mode = 'press';
        samples = [];
      } else {
        // A second finger: a pinch, and from here the gesture can never be a tap.
        mode = 'pinch';
        spread = distance(pair());
      }
      return null;
    },

    move(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return null;
      const lastX = p.x;
      const lastY = p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (mode === 'pinch') {
        const now = distance(pair());
        if (!(now > 0) || !(spread > 0)) {
          spread = now;
          return null;
        }
        // Fingers apart (now > spread) zoom in, which is a factor below 1.
        const factor = spread / now;
        spread = now;
        const [a, b] = pair();
        // The midpoint before this move (`fromX`/`fromY`) and after it (cx/cy): what was under the
        // fingers follows them.
        const other = a === p ? b : a;
        return {
          type: 'zoom', factor, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, fromX: (lastX + other.x) / 2, fromY: (lastY + other.y) / 2,
        };
      }
      if (mode === 'press') {
        if (Math.hypot(p.x - p.startX, p.y - p.startY) <= slopFor(p.type)) return null;
        // Past the slop: an orbit, counted from where the press began so no movement is lost.
        mode = 'orbit';
        sample({ x: p.startX, y: p.startY }, p.startT);
        sample(p, e.timeStamp);
        return { type: 'orbit', dx: p.x - p.startX, dy: p.y - p.startY };
      }
      if (mode === 'orbit') {
        sample(p, e.timeStamp);
        return { type: 'orbit', dx: p.x - lastX, dy: p.y - lastY };
      }
      return null;
    },

    up(e) {
      const p = pointers.get(e.pointerId);
      if (!p) return null;
      pointers.delete(e.pointerId);
      if (mode === 'pinch') {
        // One finger left: it carries on as an orbit from where it is, never as a tap.
        if (pointers.size === 1) {
          mode = 'orbit';
          samples = [];
        } else reset();
        return null;
      }
      const was = mode;
      const recent = samples;
      reset();
      if (was === 'press') {
        const still = Math.hypot(e.clientX - p.startX, e.clientY - p.startY) <= slopFor(p.type);
        const quick = e.timeStamp - p.startT <= TAP_MS;
        return still && quick ? { type: 'tap', x: e.clientX, y: e.clientY, pointerType: p.type } : null;
      }
      if (was === 'orbit') {
        const first = recent[0];
        const last = recent[recent.length - 1];
        // A pause before lifting the finger is a stop, not a flick.
        const dt = last ? last.t - first.t : 0;
        const fresh = last && e.timeStamp - last.t <= VELOCITY_MS;
        return fresh && dt > 0
          ? { type: 'release', vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
          : { type: 'release', vx: 0, vy: 0 };
      }
      return null;
    },

    cancel() {
      reset();
      return null;
    },

    // deltaMode 0 is pixels, 1 lines, 2 pages; a ctrl+wheel is a trackpad pinch.
    wheel(e) {
      const unit = e.deltaMode === 1 ? WHEEL_STEP.line : e.deltaMode === 2 ? WHEEL_STEP.page : 1;
      const px = clamp((Number(e.deltaY) || 0) * unit, -WHEEL_STEP.max, WHEEL_STEP.max);
      if (px === 0) return null;
      const factor = Math.exp(px * WHEEL_SPEED * (e.ctrlKey ? PINCH_WHEEL_BOOST : 1));
      return { type: 'zoom', factor, cx: e.clientX, cy: e.clientY };
    },
  };
}

// Keeps the task sheet inside the visual viewport, so the iOS keyboard (and its accessory bar)
// never covers the field being typed in.
//
// iOS Safari doesn't shrink the layout viewport for the keyboard: a `position: fixed` bottom
// sheet stays at the bottom of the layout viewport, behind the keyboard. While the sheet is open
// this mirrors `visualViewport` (its height and offsetTop) into CSS variables on the layer, which
// the stylesheet uses for the layer's top and height and the sheet's max-height. Without
// `visualViewport`, nothing is set and the CSS falls back to the full viewport.
//
// A focused field is scrolled into view inside the sheet body (block: 'nearest' semantics), by
// setting the body's scrollTop: Element.scrollIntoView would also scroll the page behind.
// It runs at once, again when the visual viewport next changes (the keyboard arriving) and once
// more after the keyboard animation has settled.

export const SETTLE_MS = 350; // the iOS keyboard animates in for about 250ms
export const REVEAL_WINDOW_MS = 1000; // how long a focus waits for the keyboard's resize
export const REVEAL_MARGIN = 12; // room kept between the field and the visible edge

const FIELD = /^(input|textarea|select)$/i;

// The part of the visual viewport the layer should cover, in layout-viewport (client) px.
export function viewportBox(win) {
  const vv = win?.visualViewport;
  if (!vv || !(vv.height > 0)) return null;
  return { top: Math.max(0, vv.offsetTop || 0), height: vv.height };
}

// How far `container` must scroll for `box` to sit inside `visible` (both { top, height }), with
// block: 'nearest' semantics: no scroll when it already fits; otherwise the least scroll that
// shows it, its top winning when it is taller than the room.
export function nearestDelta(box, visible, margin = REVEAL_MARGIN) {
  const top = visible.top + margin;
  const bottom = visible.top + visible.height - margin;
  if (bottom <= top) return 0;
  const boxBottom = box.top + box.height;
  if (box.top < top) return box.top - top;
  if (boxBottom > bottom) return Math.min(boxBottom - bottom, box.top - top);
  return 0;
}

// Scrolls `body` so `element` is visible within both the body and the visual viewport.
// Returns the scroll applied.
export function revealIn(body, element, win = globalThis, margin = REVEAL_MARGIN) {
  if (!body?.contains?.(element)) return 0;
  const box = element.getBoundingClientRect();
  const view = body.getBoundingClientRect();
  let top = view.top;
  let bottom = view.top + view.height;
  const vv = viewportBox(win);
  if (vv) {
    top = Math.max(top, vv.top);
    bottom = Math.min(bottom, vv.top + vv.height);
  }
  const delta = nearestDelta({ top: box.top, height: box.height }, { top, height: bottom - top }, margin);
  if (delta !== 0) body.scrollTop += delta;
  return delta;
}

// `layer` gets the CSS variables and the focusin listener; `body` is the sheet's scroller.
export function createSheetViewport({
  win = globalThis,
  doc = globalThis.document,
  layer,
  body,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  now = () => Date.now(),
}) {
  let active = false;
  let vv = null;
  let pending = null; // the field waiting for the keyboard
  let pendingUntil = 0;
  let timer = null;

  function apply() {
    const box = viewportBox(win);
    if (!box) return;
    layer.style.setProperty('--vv-top', `${box.top}px`);
    layer.style.setProperty('--vvh', `${box.height}px`);
  }

  function revealPending() {
    if (!pending) return;
    if (now() > pendingUntil || doc?.activeElement !== pending) {
      pending = null;
      return;
    }
    revealIn(body, pending, win);
  }

  function onViewport() {
    apply();
    revealPending();
  }

  function onFocusIn(event) {
    const field = event.target;
    if (!FIELD.test(field?.tagName ?? '')) return;
    revealIn(body, field, win);
    pending = field;
    pendingUntil = now() + REVEAL_WINDOW_MS;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      revealPending();
    }, SETTLE_MS);
  }

  return {
    get active() { return active; },
    start() {
      if (active) return;
      active = true;
      vv = win?.visualViewport ?? null;
      vv?.addEventListener('resize', onViewport);
      vv?.addEventListener('scroll', onViewport);
      layer.addEventListener('focusin', onFocusIn);
      apply();
    },
    stop() {
      if (!active) return;
      active = false;
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      vv = null;
      layer.removeEventListener('focusin', onFocusIn);
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = null;
      layer.style.removeProperty?.('--vv-top');
      layer.style.removeProperty?.('--vvh');
    },
  };
}

// Swipe left to delete, as pure logic: the axis lock and release thresholds of one gesture, and
// the one deferred delete waiting behind the Undo toast. src/app.js does the DOM.

export const LOCK_PX = 10; // movement before the gesture picks an axis
export const DELETE_FRACTION = 0.35; // of the row's width, past which a release deletes
export const FLICK_SPEED = 0.6; // px/ms: a fast flick left deletes even when short...
export const FLICK_MIN_PX = 40; // ...once it has gone this far
export const UNDO_MS = 5000; // how long the Undo toast stays

// One gesture from where the pointer went down. phase: 'tracking' until it moves LOCK_PX, then
// 'horizontal' (the row follows, left only) or 'vertical' (left to the page: it scrolls).
export function createSwipe(width, startX, startY, startTime) {
  let phase = 'tracking';
  let dx = 0;
  // The last two samples, for the release speed.
  let last = { x: startX, time: startTime };
  let previous = last;
  return {
    get phase() { return phase; },
    get offset() { return phase === 'horizontal' ? Math.min(0, dx) : 0; },
    move(x, y, time) {
      dx = x - startX;
      const dy = y - startY;
      if (phase === 'tracking') {
        if (Math.abs(dx) > LOCK_PX && Math.abs(dx) > Math.abs(dy)) phase = 'horizontal';
        else if (Math.abs(dy) > LOCK_PX) phase = 'vertical';
      }
      previous = last;
      last = { x, time };
      return phase;
    },
    // 'delete' (slide out), 'back' (spring back) or 'none' (never locked horizontal).
    end(time) {
      if (phase !== 'horizontal') return 'none';
      const distance = -Math.min(0, dx);
      if (distance >= width * DELETE_FRACTION) return 'delete';
      const elapsed = Math.max(1, (time ?? last.time) - previous.time);
      const speed = (previous.x - last.x) / elapsed;
      return distance >= FLICK_MIN_PX && speed >= FLICK_SPEED ? 'delete' : 'back';
    },
  };
}

// The one delete waiting for its Undo toast to run out. `commit(entry)` sends it. A new delete
// commits the earlier one first; undo() hands it back unsent; drop() forgets it unsent (another
// session's view must never send it).
export function createPendingDelete({ commit, setTimer = setTimeout, clearTimer = clearTimeout, ms = UNDO_MS }) {
  let entry = null;
  let timer = null;
  function take() {
    const taken = entry;
    entry = null;
    clearTimer(timer);
    timer = null;
    return taken;
  }
  function flush() {
    const taken = take();
    if (taken) commit(taken);
    return taken;
  }
  return {
    get id() { return entry?.id ?? null; },
    get entry() { return entry; },
    start(next) {
      flush();
      entry = next;
      timer = setTimer(flush, ms);
    },
    undo: take,
    flush,
    drop: take,
  };
}

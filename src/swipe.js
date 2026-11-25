// Swipe left to delete, as pure logic: the axis lock and release thresholds of one gesture, which
// row has its Delete button revealed, and the one deferred delete waiting behind the Undo toast.
// src/app.js does the DOM.

export const LOCK_PX = 10; // movement before the gesture picks an axis
export const REVEAL_PX = 76; // an open row's card offset: gap + Delete button + edge (styles.css .todo-delete)
export const FULL_FRACTION = 0.65; // of the row's width, past which a release deletes at once
export const FLICK_SPEED = 0.6; // px/ms: a fast flick left deletes...
export const FLICK_MIN_PX = REVEAL_PX; // ...once it is past the open position (a quick reveal only opens)

// One gesture from where the pointer went down. phase: 'tracking' until it moves LOCK_PX, then
// 'horizontal' (the card follows, left only) or 'vertical' (left to the page: it scrolls).
// `open`: the row's Delete button was showing when the press began, so the card starts at -REVEAL_PX.
export function createSwipe(width, startX, startY, startTime, { open = false } = {}) {
  const start = open ? -REVEAL_PX : 0;
  let phase = 'tracking';
  let dx = 0;
  // The last two samples, for the release speed.
  let last = { x: startX, time: startTime };
  let previous = last;
  return {
    get phase() { return phase; },
    get open() { return open; },
    get offset() { return phase === 'horizontal' ? Math.min(0, start + dx) : start; },
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
    // 'delete' (slide out), 'open' (hold the Delete button), 'back' (spring closed) or 'none'
    // (never locked horizontal: a tap, or a scroll).
    end(time) {
      if (phase !== 'horizontal') return 'none';
      const distance = -Math.min(0, start + dx);
      const elapsed = Math.max(1, (time ?? last.time) - previous.time);
      const speed = (previous.x - last.x) / elapsed; // > 0: moving left
      if (speed <= -FLICK_SPEED) return 'back'; // flicked back right
      if (speed > 0 && distance >= width * FULL_FRACTION) return 'delete';
      // The flick counts the gesture's own leftward travel, never the offset an open row already has.
      if (speed >= FLICK_SPEED && -dx > FLICK_MIN_PX) return 'delete';
      return distance >= REVEAL_PX / 2 ? 'open' : 'back';
    },
  };
}

// Which row has its Delete button revealed: one at most. A press anywhere decides what happens to
// it: press(id, part) with the pressed row's id (or null) and part ('delete', 'handle' or 'card').
//   'none'   nothing is open
//   'keep'   the open row's Delete button: its click deletes
//   'resume' the open row's card: a swipe starts from open; a plain tap just closes it
//   'close'  anything else (another row, its own handle, outside the list): close it now
export function createReveal() {
  let openId = null;
  return {
    get openId() { return openId; },
    // Opens `id`; returns the row that was open before it, to close, if it was another.
    open(id) {
      const before = openId;
      openId = id;
      return before !== null && before !== id ? before : null;
    },
    // Closes the open row (only if it is `id`, when given); returns the id closed, or null.
    close(id) {
      if (openId === null || (id !== undefined && id !== openId)) return null;
      const closed = openId;
      openId = null;
      return closed;
    },
    press(id, part) {
      if (openId === null) return 'none';
      if (id !== openId || part === 'handle') return 'close';
      return part === 'delete' ? 'keep' : 'resume';
    },
  };
}

export const UNDO_MS = 5000; // how long the Undo toast stays

// The one delete waiting for its Undo toast to run out. `commit(entry)` sends it. A new delete
// commits the earlier one first; undo() hands it back unsent; drop() forgets it unsent (another
// session's view must never send it). pause() stops the clock (the toast is hovered or focused);
// resume() runs it again for the time that was left.
export function createPendingDelete({
  commit, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, ms = UNDO_MS,
}) {
  let entry = null;
  let timer = null;
  let deadline = 0;
  let left = null; // ms left while paused
  function take() {
    const taken = entry;
    entry = null;
    clearTimer(timer);
    timer = null;
    left = null;
    return taken;
  }
  function flush() {
    const taken = take();
    if (taken) commit(taken);
    return taken;
  }
  function arm(wait) {
    deadline = now() + wait;
    timer = setTimer(flush, wait);
  }
  return {
    get id() { return entry?.id ?? null; },
    get entry() { return entry; },
    get paused() { return left !== null; },
    start(next) {
      flush();
      entry = next;
      arm(ms);
    },
    pause() {
      if (!entry || left !== null) return;
      clearTimer(timer);
      timer = null;
      left = Math.max(0, deadline - now());
    },
    resume() {
      if (!entry || left === null) return;
      const wait = left;
      left = null;
      arm(wait);
    },
    undo: take,
    flush,
    drop: take,
  };
}

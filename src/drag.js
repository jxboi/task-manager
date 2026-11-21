// Drag-to-reorder without the DOM. The page measures the rows that can be reordered (the visible,
// non-overdue rows: overdue tasks stay on top by due time), feeds in pointer positions and asks
// where the row will land. Every move is expressed as sync.move()'s (anchorId, side) on a visible
// row, so rows hidden by a tag filter keep their order.

// `rows`: [{ id, top, height }] in display order, page coordinates, contiguous. `id`: the row
// being dragged. `y`: the pointer's page Y when the drag started.
export function createDrag(rows, id, y) {
  const from = rows.findIndex((row) => row.id === id);
  if (from < 0) throw new Error('The dragged row must be one of the rows.');
  const dragged = rows[from];
  const others = rows.filter((row) => row !== dragged);
  const first = rows[0];
  const last = rows.at(-1);
  // The lifted row stays within the reorderable rows.
  const minOffset = first.top - dragged.top;
  const maxOffset = last.top + last.height - (dragged.top + dragged.height);
  let offset = 0;
  let index = from;

  return {
    id,
    from,
    get offset() {
      return offset;
    },
    // The landing index among the other rows (0 to others.length). `from` means "where it was".
    get index() {
      return index;
    },
    // Moves the pointer to page Y `pointerY`; returns the new landing index.
    move(pointerY) {
      offset = Math.min(maxOffset, Math.max(minOffset, pointerY - y));
      const center = dragged.top + offset + dragged.height / 2;
      // Pushed against either end, the row goes to that end, even when it is taller than the
      // row there (its center could then never pass that row's).
      if (offset === minOffset) index = 0;
      else if (offset === maxOffset) index = others.length;
      else index = others.filter((row) => row.top + row.height / 2 < center).length;
      return index;
    },
    // How far each other row slides to open the gap: { [id]: px }.
    shifts() {
      const result = {};
      others.forEach((row, i) => {
        // `i` is the row's index without the dragged one; its original index is i or i + 1.
        const original = i < from ? i : i + 1;
        let shift = 0;
        if (index > from && original > from && i < index) shift = -dragged.height;
        if (index < from && original < from && i >= index) shift = dragged.height;
        result[row.id] = shift;
      });
      return result;
    },
    // The page Y where the gap (the landing slot) starts.
    slotTop() {
      if (index <= from) return rows[index].top;
      const above = rows[index]; // others[index - 1], which sits at original index `index`
      return above.top + above.height - dragged.height;
    },
    // The move to send, or null when the row lands where it was.
    target() {
      return targetAt(others, from, index);
    },
  };
}

function targetAt(others, from, index) {
  if (index === from) return null;
  if (index < others.length) return { anchorId: others[index].id, side: 'before' };
  return { anchorId: others.at(-1).id, side: 'after' };
}

// Keyboard reorder on the handle. `ids`: the reorderable rows in display order. Returns
// { anchorId, side, index } (index: the new 0-based place) or null when the key does nothing
// (not a reorder key, or already at that end).
export function keyboardTarget(ids, id, key) {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = { ArrowUp: from - 1, ArrowDown: from + 1, Home: 0, End: ids.length - 1 }[key];
  if (to === undefined || to < 0 || to >= ids.length || to === from) return null;
  return { anchorId: ids[to], side: to < from ? 'before' : 'after', index: to };
}

// Auto-scroll while dragging near the top or bottom of the viewport: px per frame, negative up.
// Grows from 0 at `edge` px from the edge to `max` at the edge (or beyond it).
export function autoScrollStep(clientY, viewportHeight, edge = 64, max = 14) {
  const fromTop = clientY;
  const fromBottom = viewportHeight - clientY;
  if (fromTop < edge) return -Math.ceil(max * Math.min(1, (edge - fromTop) / edge));
  if (fromBottom < edge) return Math.ceil(max * Math.min(1, (edge - fromBottom) / edge));
  return 0;
}

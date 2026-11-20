// Vertical placement of the desktop reminder popover, in viewport coordinates. It opens 6px below
// the opener; if that would cross the viewport bottom (8px margin) and there is room above, it opens
// above instead. It never asks the page to scroll: with no room either way it stays below.
export const POPOVER_GAP = 6;
export const VIEWPORT_MARGIN = 8;

export function popoverTop(openerTop, openerBottom, popoverHeight, viewportHeight) {
  const below = openerBottom + POPOVER_GAP;
  const above = openerTop - POPOVER_GAP - popoverHeight;
  if (below + popoverHeight > viewportHeight - VIEWPORT_MARGIN && above >= VIEWPORT_MARGIN) return above;
  return below;
}

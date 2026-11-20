import assert from 'node:assert/strict';
import { test } from 'node:test';
import { popoverTop } from '../src/popover.js';

// Viewport 800px tall; the popover is 300px tall.

test('popover opens 6px below the opener when it fits', () => {
  assert.equal(popoverTop(100, 122, 300, 800), 128);
});

test('popover opens below when it ends exactly at the 8px bottom margin', () => {
  // 486 + 6 + 300 = 792 = 800 - 8
  assert.equal(popoverTop(464, 486, 300, 800), 492);
});

test('popover flips above the opener when it would cross the bottom and there is room above', () => {
  assert.equal(popoverTop(600, 622, 300, 800), 294);
});

test('popover flips above when it lands exactly on the 8px top margin', () => {
  // 314 - 6 - 300 = 8
  assert.equal(popoverTop(314, 336, 300, 600), 8);
});

test('popover stays below when there is no room above either (the page is never scrolled)', () => {
  assert.equal(popoverTop(200, 222, 300, 400), 228);
});

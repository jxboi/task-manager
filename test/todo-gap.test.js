// Each .todo card's 8px gap is a transparent border-bottom with background-clip: padding-box.
// The `background` shorthand resets the clip to border-box, so a state fill set with it paints
// into the gap. State rules must set background-color instead.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const css = (await readFile(new URL('../styles.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

// Declaration blocks (innermost braces) whose selector or keyframe stop matches.
function blocks(match) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => match(selector.trim()))
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));
}

test('done, overdue and fired card fills do not reset background-clip', () => {
  const rules = blocks((s) => /^\.todo\.is-(done|overdue)$/.test(s));
  const pulse = css.match(/@keyframes reminder-pulse\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/);
  assert.ok(pulse, 'reminder-pulse keyframes exist');
  for (const [, stop, body] of pulse[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) rules.push({ selector: `reminder-pulse ${stop.trim()}`, body });
  assert.ok(rules.length >= 4, 'found the state rules and both pulse stops');
  for (const { selector, body } of rules) {
    assert.doesNotMatch(body, /(^|[;\s])background\s*:/, `${selector} must use background-color, not the shorthand`);
  }
  assert.ok(rules.some(({ body }) => /background-color\s*:/.test(body)));
});

test('the card base keeps the padding-box clip over its transparent border', () => {
  const base = blocks((s) => s === '.todo').map(({ body }) => body).join('\n');
  assert.match(base, /border-bottom-width:\s*8px/);
  assert.match(base, /background-clip:\s*padding-box/);
});

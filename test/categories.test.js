import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeCategory, parseTodoInput, categoryColor, PALETTE_SIZE } from '../src/categories.js';

test('normalizeCategory trims, strips one #, lowercases and turns inner spaces into -', () => {
  assert.equal(normalizeCategory('  Work '), 'work');
  assert.equal(normalizeCategory('#work'), 'work');
  assert.equal(normalizeCategory('WORK'), 'work');
  assert.equal(normalizeCategory(' #Work '), 'work');
  assert.equal(normalizeCategory('due today'), 'due-today');
  assert.equal(normalizeCategory('due   to\tday'), 'due-to-day');
});

test('normalizeCategory rejects empty, whitespace-only and over-long tags', () => {
  for (const raw of ['', '   ', '#', ' # ', 'a'.repeat(25), `#${'a'.repeat(25)}`]) {
    assert.equal(normalizeCategory(raw), null, JSON.stringify(raw));
  }
});

test('normalizeCategory strips only one #: a tag that still starts with # is invalid', () => {
  for (const raw of ['##work', ' ## work', '# #work', '#\t#work']) {
    assert.equal(normalizeCategory(raw), null, JSON.stringify(raw));
  }
  assert.equal(normalizeCategory('c#'), 'c#');
  assert.equal(normalizeCategory('#a#b'), 'a#b');
});

test('normalizeCategory is idempotent: a normalized tag normalizes to itself', () => {
  const samples = [
    '  Work ', '#work', 'WORK', 'due today', ' # Due  Today ', 'c#', '#a#b', 'ÉTÉ', 'İstanbul',
    'Straße', 'ΟΔΟΣ', '日本語', '😀 party', 'x'.repeat(24), `#${'Y'.repeat(24)}`, '##work', '#',
  ];
  for (const raw of samples) {
    const once = normalizeCategory(raw);
    if (once !== null) assert.equal(normalizeCategory(once), once, JSON.stringify(raw));
  }
});

test('normalizeCategory accepts 1 and 24 characters', () => {
  assert.equal(normalizeCategory('a'), 'a');
  assert.equal(normalizeCategory('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(normalizeCategory(`#${'a'.repeat(24)}`), 'a'.repeat(24));
});

test('parseTodoInput takes the first #word as the category and keeps the rest as text', () => {
  assert.deepEqual(parseTodoInput('Pay rent #home'), { text: 'Pay rent', category: 'home' });
  assert.deepEqual(parseTodoInput('Pay rent #home #money'), { text: 'Pay rent #money', category: 'home' });
});

test('parseTodoInput handles a category mid-text and collapses the leftover space', () => {
  assert.deepEqual(parseTodoInput('Call #work Sam today'), { text: 'Call Sam today', category: 'work' });
  assert.deepEqual(parseTodoInput('#urgent fix the build'), { text: 'fix the build', category: 'urgent' });
});

test('parseTodoInput normalizes the category', () => {
  assert.deepEqual(parseTodoInput('Report #Work'), { text: 'Report', category: 'work' });
});

test('parseTodoInput leaves things that are not categories in the text', () => {
  for (const raw of ['Learn C#', 'Reply to email#1', 'Item # 5', 'Lone #', '# work']) {
    assert.deepEqual(parseTodoInput(raw), { text: raw, category: null }, raw);
  }
});

test('parseTodoInput skips an over-long token and takes the next valid one', () => {
  const long = `#${'a'.repeat(25)}`;
  assert.deepEqual(parseTodoInput(`Plan ${long} #ok`), { text: `Plan ${long}`, category: 'ok' });
});

test('parseTodoInput keeps the original "#" rules: a category stops at the next "#"', () => {
  assert.deepEqual(parseTodoInput('#ref#42'), { text: '#42', category: 'ref' });
  assert.deepEqual(parseTodoInput('Review #ref#42'), { text: 'Review #42', category: 'ref' });
  assert.deepEqual(parseTodoInput('Fix ##work'), { text: 'Fix ##work', category: null });
});

test('parseTodoInput with only a category gives empty text', () => {
  assert.deepEqual(parseTodoInput('#home'), { text: '', category: 'home' });
});

test('parseTodoInput uses the selected category unless one is typed', () => {
  assert.deepEqual(parseTodoInput('call Sam', 'work'), { text: 'call Sam', category: 'work' });
  assert.deepEqual(parseTodoInput('call Sam #Phone', 'work'), { text: 'call Sam', category: 'phone' });
  assert.deepEqual(parseTodoInput('call Sam', null), { text: 'call Sam', category: null });
});

test('categoryColor returns an integer slot in range for a spread of tags', () => {
  for (const tag of ['a', 'z', 'x'.repeat(24), 'due-today', 'café', '日本', '🚀', 'naïve-ünïcode']) {
    const slot = categoryColor(tag);
    assert.ok(Number.isInteger(slot), tag);
    assert.ok(slot >= 0 && slot < PALETTE_SIZE, `${tag}: ${slot}`);
  }
});

test('categoryColor is deterministic', () => {
  for (const tag of ['work', 'home', 'café']) {
    assert.equal(categoryColor(tag), categoryColor(tag));
  }
});

test('categoryColor goldens (FNV-1a 32-bit mod 8) so a refactor cannot silently recolor categories', () => {
  assert.equal(PALETTE_SIZE, 8);
  assert.equal(categoryColor('work'), 0);
  assert.equal(categoryColor('home'), 6);
  assert.equal(categoryColor('errands'), 2);
  assert.equal(categoryColor('money'), 7);
});

test('categoryColor spreads 50 distinct tags over at least 6 of 8 slots', () => {
  const tags = [
    'work', 'home', 'errands', 'money', 'urgent', 'blocked', 'dev', 'health', 'phone', 'email',
    'shopping', 'family', 'school', 'travel', 'garden', 'car', 'bills', 'gym', 'reading', 'music',
    'design', 'review', 'bug', 'feature', 'meeting', 'call', 'later', 'today', 'tomorrow', 'weekend',
    'ideas', 'kids', 'pets', 'cleaning', 'cooking', 'taxes', 'insurance', 'doctor', 'dentist', 'birthday',
    'gifts', 'friends', 'side-project', 'learning', 'writing', 'admin', 'office', 'client', 'invoice', 'q4',
  ];
  assert.equal(new Set(tags).size, 50);
  const slots = new Set(tags.map(categoryColor));
  assert.ok(slots.size >= 6, `only ${slots.size} slots used`);
});

test('PALETTE_SIZE matches the data-color rules in styles.css', () => {
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const slots = [...css.matchAll(/\[data-color="(\d+)"\]\s*\{/g)].map((match) => Number(match[1]));
  assert.equal(slots.length, PALETTE_SIZE);
  assert.deepEqual(
    slots.toSorted((a, b) => a - b),
    Array.from({ length: PALETTE_SIZE }, (_, i) => i),
  );
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeTag, parseTodoInput, tagColor, PALETTE_SIZE } from '../src/tags.js';

test('normalizeTag trims, strips one #, lowercases and turns inner spaces into -', () => {
  assert.equal(normalizeTag('  Work '), 'work');
  assert.equal(normalizeTag('#work'), 'work');
  assert.equal(normalizeTag('WORK'), 'work');
  assert.equal(normalizeTag(' #Work '), 'work');
  assert.equal(normalizeTag('due today'), 'due-today');
  assert.equal(normalizeTag('due   to\tday'), 'due-to-day');
});

test('normalizeTag rejects empty, whitespace-only and over-long tags', () => {
  for (const raw of ['', '   ', '#', ' # ', 'a'.repeat(25), `#${'a'.repeat(25)}`]) {
    assert.equal(normalizeTag(raw), null, JSON.stringify(raw));
  }
});

test('normalizeTag strips only one #: a tag that still starts with # is invalid', () => {
  for (const raw of ['##work', ' ## work', '# #work', '#\t#work']) {
    assert.equal(normalizeTag(raw), null, JSON.stringify(raw));
  }
  assert.equal(normalizeTag('c#'), 'c#');
  assert.equal(normalizeTag('#a#b'), 'a#b');
});

test('normalizeTag is idempotent: a normalized tag normalizes to itself', () => {
  const samples = [
    '  Work ', '#work', 'WORK', 'due today', ' # Due  Today ', 'c#', '#a#b', 'ÉTÉ', 'İstanbul',
    'Straße', 'ΟΔΟΣ', '日本語', '😀 party', 'x'.repeat(24), `#${'Y'.repeat(24)}`, '##work', '#',
  ];
  for (const raw of samples) {
    const once = normalizeTag(raw);
    if (once !== null) assert.equal(normalizeTag(once), once, JSON.stringify(raw));
  }
});

test('normalizeTag accepts 1 and 24 characters', () => {
  assert.equal(normalizeTag('a'), 'a');
  assert.equal(normalizeTag('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(normalizeTag(`#${'a'.repeat(24)}`), 'a'.repeat(24));
});

test('parseTodoInput pulls trailing tags out of the text', () => {
  assert.deepEqual(parseTodoInput('Pay rent #home #money'), { text: 'Pay rent', tags: ['home', 'money'] });
});

test('parseTodoInput handles a tag mid-text and collapses the leftover space', () => {
  assert.deepEqual(parseTodoInput('Call #work Sam today'), { text: 'Call Sam today', tags: ['work'] });
  assert.deepEqual(parseTodoInput('#urgent fix the build'), { text: 'fix the build', tags: ['urgent'] });
});

test('parseTodoInput normalizes tags', () => {
  assert.deepEqual(parseTodoInput('Buy milk #home #Errands'), { text: 'Buy milk', tags: ['home', 'errands'] });
  assert.deepEqual(parseTodoInput('Report #Work').tags, ['work']);
});

test('parseTodoInput leaves things that are not tags in the text', () => {
  for (const raw of ['Learn C#', 'Reply to email#1', 'Item # 5', 'Lone #', '# work']) {
    assert.deepEqual(parseTodoInput(raw), { text: raw, tags: [] }, raw);
  }
});

test('parseTodoInput keeps an over-long token in the text', () => {
  const long = `#${'a'.repeat(25)}`;
  assert.deepEqual(parseTodoInput(`Plan ${long} #ok`), { text: `Plan ${long}`, tags: ['ok'] });
});

test('parseTodoInput collapses duplicate tags and removes every copy', () => {
  assert.deepEqual(parseTodoInput('Ship it #work #WORK'), { text: 'Ship it', tags: ['work'] });
});

test('parseTodoInput keeps at most 10 tags; the 11th stays in the text', () => {
  const tags = Array.from({ length: 11 }, (_, i) => `t${i + 1}`);
  const result = parseTodoInput(`Big ${tags.map((tag) => `#${tag}`).join(' ')}`);
  assert.deepEqual(result.tags, tags.slice(0, 10));
  assert.equal(result.text, 'Big #t11');
});

test('parseTodoInput with only tags gives empty text', () => {
  assert.deepEqual(parseTodoInput('#home'), { text: '', tags: ['home'] });
  assert.deepEqual(parseTodoInput('  #home  #work '), { text: '', tags: ['home', 'work'] });
});

test('parseTodoInput puts base (active filter) tags first and counts them toward the cap', () => {
  assert.deepEqual(parseTodoInput('call Sam #phone', ['urgent', 'work']), {
    text: 'call Sam',
    tags: ['urgent', 'work', 'phone'],
  });
  assert.deepEqual(parseTodoInput('call Sam #Work', ['work']), { text: 'call Sam', tags: ['work'] });

  const active = Array.from({ length: 9 }, (_, i) => `a${i}`);
  assert.deepEqual(parseTodoInput('x #one #two', active), { text: 'x #two', tags: [...active, 'one'] });
});

test('tagColor returns an integer slot in range for a spread of tags', () => {
  for (const tag of ['a', 'z', 'x'.repeat(24), 'due-today', 'café', '日本', '🚀', 'naïve-ünïcode']) {
    const slot = tagColor(tag);
    assert.ok(Number.isInteger(slot), tag);
    assert.ok(slot >= 0 && slot < PALETTE_SIZE, `${tag}: ${slot}`);
  }
});

test('tagColor is deterministic', () => {
  for (const tag of ['work', 'home', 'café']) {
    assert.equal(tagColor(tag), tagColor(tag));
  }
});

test('tagColor goldens (FNV-1a 32-bit mod 8) so a refactor cannot silently recolor tags', () => {
  assert.equal(PALETTE_SIZE, 8);
  assert.equal(tagColor('work'), 0);
  assert.equal(tagColor('home'), 6);
  assert.equal(tagColor('errands'), 2);
  assert.equal(tagColor('money'), 7);
});

test('tagColor spreads 50 distinct tags over at least 6 of 8 slots', () => {
  const tags = [
    'work', 'home', 'errands', 'money', 'urgent', 'blocked', 'dev', 'health', 'phone', 'email',
    'shopping', 'family', 'school', 'travel', 'garden', 'car', 'bills', 'gym', 'reading', 'music',
    'design', 'review', 'bug', 'feature', 'meeting', 'call', 'later', 'today', 'tomorrow', 'weekend',
    'ideas', 'kids', 'pets', 'cleaning', 'cooking', 'taxes', 'insurance', 'doctor', 'dentist', 'birthday',
    'gifts', 'friends', 'side-project', 'learning', 'writing', 'admin', 'office', 'client', 'invoice', 'q4',
  ];
  assert.equal(new Set(tags).size, 50);
  const slots = new Set(tags.map(tagColor));
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

test('parseTodoInput takes a "#" inside a tag but not one that starts it', () => {
  assert.deepEqual(parseTodoInput('Fix #ref#42'), { text: 'Fix', tags: ['ref#42'] });
  assert.deepEqual(parseTodoInput('Fix ##work'), { text: 'Fix ##work', tags: [] });
});

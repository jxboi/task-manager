import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInput, foldTags, readEdit } from '../server/todo-input.js';

const id = '0b7f2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';

test('foldTags appends tags in order as #words and skips NULLs', () => {
  assert.equal(foldTags('Meeting', ['home', null, 'urgent']), 'Meeting #home #urgent');
  assert.equal(foldTags('Meeting', []), 'Meeting');
});

test('foldTags appends whole tags while the title fits in 2,000 code points, then stops', () => {
  assert.equal(foldTags('x'.repeat(1994), ['cdef']), `${'x'.repeat(1994)} #cdef`);
  assert.equal(foldTags('x'.repeat(1990), ['ab', 'toolong12', 'c']), `${'x'.repeat(1990)} #ab`);
  // Code points, not UTF-16 units: 1,996 emoji plus " #é" is exactly 2,000.
  assert.equal(foldTags('😀'.repeat(1996), ['é', 'z']), `${'😀'.repeat(1996)} #é`);
  assert.equal(foldTags('😀'.repeat(2000), ['a']), '😀'.repeat(2000));
});

test('create and edit accept a missing tags field, which new clients omit', () => {
  assert.deepEqual(createInput({ id, text: ' Pay rent ', tags: ['#Home', 'bills'] }),
    { id, text: 'Pay rent', tags: ['home', 'bills'] });
  assert.deepEqual(createInput({ id, text: 'Pay rent' }), { id, text: 'Pay rent', tags: [] });
  const edit = { action: 'edit', revision: 1, text: 'Plan', due: null, repeat: 'none' };
  assert.deepEqual(readEdit(edit), { text: 'Plan', tags: [], due: null, repeat: 'none', categoryId: undefined });
});

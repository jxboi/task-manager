import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCategoryInput, readCategoryId, readName, readQueryRevision, renameCategoryInput,
} from '../server/category-input.js';

const id = '0b7f2a3e-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
const rejects = (fn) => assert.throws(fn, { status: 400, code: 'INVALID_INPUT' });

test('names are trimmed and keep their display case', () => {
  assert.equal(readName('  Work Stuff  '), 'Work Stuff');
  assert.equal(readName('ÉCOLE'), 'ÉCOLE');
});

test('name length counts Unicode code points, 1 to 48', () => {
  assert.equal(readName('a'), 'a');
  assert.equal(readName('😀'.repeat(48)), '😀'.repeat(48));
  assert.equal(readName(` ${'x'.repeat(48)} `), 'x'.repeat(48));
  rejects(() => readName('😀'.repeat(49)));
  rejects(() => readName('x'.repeat(49)));
  rejects(() => readName(''));
  rejects(() => readName('   '));
});

test('names reject control characters, NUL, malformed strings and non-strings', () => {
  for (const value of ['a\0b', 'a\nb', 'tab\there', 'del\u007f', 'c1\u0085', '\ud800x', 1, null, undefined, ['a'], {}]) {
    rejects(() => readName(value));
  }
  // Surrounding newlines are whitespace and trim away.
  assert.equal(readName('\nWork\n'), 'Work');
});

test('category IDs must be UUIDs and are lowercased', () => {
  assert.equal(readCategoryId(id.toUpperCase()), id);
  for (const value of ['', 'not-a-uuid', `${id}x`, 42, null, undefined]) rejects(() => readCategoryId(value));
});

test('create accepts only id and name', () => {
  assert.deepEqual(createCategoryInput({ id, name: ' Home ' }), { id, name: 'Home' });
  rejects(() => createCategoryInput({ id, name: 'Home', userId: 'someone' }));
  rejects(() => createCategoryInput({ id, name: 'Home', revision: 1 }));
  rejects(() => createCategoryInput({ name: 'Home' }));
  rejects(() => createCategoryInput({ id: 'bad', name: 'Home' }));
});

test('rename accepts only name and an in-range integer revision', () => {
  assert.deepEqual(renameCategoryInput({ name: 'home', revision: 3 }), { name: 'home', revision: 3 });
  rejects(() => renameCategoryInput({ name: 'home', revision: 1, id }));
  rejects(() => renameCategoryInput({ name: 'home', revision: 1, user_id: 'x' }));
  for (const revision of [0, -1, 1.5, '1', null, undefined, 2147483648]) {
    rejects(() => renameCategoryInput({ name: 'home', revision }));
  }
});

test('query revisions are positive decimal integers within int4', () => {
  assert.equal(readQueryRevision('7'), 7);
  assert.equal(readQueryRevision('2147483647'), 2147483647);
  for (const value of [null, '', '0', '01', '-1', '1.0', '1e3', ' 1', '2147483648']) {
    rejects(() => readQueryRevision(value));
  }
});

// The category rules in src/categories.js: the list filter, the name check and error messages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALL, categoryErrorText, filterByCategory, keepFilter, readCategoryName, UNCATEGORIZED,
} from '../src/categories.js';
import { sortByUrgency } from '../src/todos.js';

const HOME = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const WORK = '0f8fad5b-d9cb-469f-a165-70867728950e';
const todos = [
  { id: 'a', categoryId: HOME, due: null },
  { id: 'b', categoryId: null, due: null },
  { id: 'c', categoryId: WORK, due: 5 },
  { id: 'd', due: null }, // a row from before categories: no link
  { id: 'e', categoryId: HOME, due: 1 },
];
const ids = (list) => list.map(({ id }) => id);

test('All shows every task, Uncategorized the unlinked ones, a category only its own', () => {
  assert.equal(filterByCategory(todos, ALL), todos);
  assert.deepEqual(ids(filterByCategory(todos, UNCATEGORIZED)), ['b', 'd']);
  assert.deepEqual(ids(filterByCategory(todos, HOME)), ['a', 'e']);
  assert.deepEqual(ids(filterByCategory(todos, WORK)), ['c']);
  assert.deepEqual(filterByCategory(todos, '00000000-0000-4000-8000-000000000000'), []);
});

test('a filtered list keeps urgency first, then position order', () => {
  assert.deepEqual(ids(sortByUrgency(filterByCategory(todos, HOME), 10)), ['e', 'a']);
});

test('the filter falls back to All when its category is deleted or the catalog is missing', () => {
  const catalog = [{ id: HOME, name: 'Home', revision: 1 }];
  assert.equal(keepFilter(HOME, catalog), HOME);
  assert.equal(keepFilter(WORK, catalog), ALL, 'deleted here or in another tab');
  assert.equal(keepFilter(UNCATEGORIZED, catalog), UNCATEGORIZED);
  assert.equal(keepFilter(UNCATEGORIZED, []), UNCATEGORIZED);
  assert.equal(keepFilter(HOME, null), ALL, 'no catalog (signed out, another account, an older server)');
  assert.equal(keepFilter(UNCATEGORIZED, null), ALL);
  assert.equal(keepFilter(ALL, catalog), ALL);
});

test('a name is trimmed and 1 to 48 characters with no control characters', () => {
  assert.deepEqual(readCategoryName('  Home  '), { name: 'Home', error: null });
  assert.equal(readCategoryName('   ').error, 'empty');
  assert.equal(readCategoryName('😀'.repeat(48)).error, null);
  assert.equal(readCategoryName('😀'.repeat(49)).error, 'invalid');
  assert.equal(readCategoryName('a\tb').error, 'invalid');
  assert.equal(readCategoryName('#travel').error, null, 'a # is just text');
});

test('failed writes read as something the user can act on', () => {
  assert.equal(categoryErrorText({ status: 409, code: 'CATEGORY_LIMIT' }, true),
    'You can have up to 50 categories. Delete one to add another.');
  assert.equal(categoryErrorText({ status: 409, code: 'DUPLICATE_NAME' }, true), 'A category with that name already exists.');
  assert.equal(categoryErrorText({ status: 409, code: 'REVISION_CONFLICT' }, true),
    'This category changed in another tab or device. The list is up to date now. Try again if needed.');
  assert.equal(categoryErrorText({ status: 404, code: 'NOT_FOUND' }, false),
    'This category changed in another tab or device. Try again if needed.');
  assert.equal(categoryErrorText({ status: 400, code: 'INVALID_INPUT' }, false), 'Use 1 to 48 characters for the name.');
  assert.match(categoryErrorText({ status: 0, code: 'NETWORK' }, true), /^Couldn't save the category\. The list is up to date now\./);
});

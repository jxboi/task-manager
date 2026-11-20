import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTodo,
  toggleTodo,
  removeTodo,
  addTag,
  removeTag,
  allTags,
  filterByTags,
  setReminder,
  clearReminder,
  markNotified,
  dueReminders,
  nextFireTime,
  sortByUrgency,
} from '../src/todos.js';
import { isCompleted, nextOccurrence } from '../src/reminders.js';

function deepFreeze(todos) {
  for (const todo of todos) {
    if (todo.tags) Object.freeze(todo.tags);
    Object.freeze(todo);
  }
  return Object.freeze(todos);
}

function makeTodos() {
  return deepFreeze([
    { id: 'a', text: 'First', completed: false, createdAt: 1 },
    { id: 'b', text: 'Second', completed: true, createdAt: 2 },
    { id: 'c', text: 'Third', completed: false, createdAt: 3 },
  ]);
}

test('addTodo appends a new incomplete todo at the end', () => {
  const todos = makeTodos();
  const result = addTodo(todos, 'Fourth');

  assert.equal(result.length, 4);
  assert.deepEqual(result.slice(0, 3), todos);
  const added = result[3];
  assert.equal(added.text, 'Fourth');
  assert.equal(added.completed, false);
  assert.equal(typeof added.id, 'string');
  assert.ok(added.id.length > 0);
  assert.equal(typeof added.createdAt, 'number');
});

function makeTagged() {
  return deepFreeze([
    { id: 'a', text: 'Set up the repo', completed: true, createdAt: 1, tags: ['work', 'dev'] },
    { id: 'b', text: 'Review preview', completed: false, createdAt: 2, tags: ['work', 'blocked'] },
    { id: 'c', text: 'Dentist', completed: false, createdAt: 3, tags: ['home'] },
    { id: 'd', text: 'Draft email', completed: false, createdAt: 4, tags: [] },
  ]);
}

const ids = (todos) => todos.map((todo) => todo.id);

test('addTodo without tags gives tags: []', () => {
  const [added] = addTodo([], 'Plain');
  assert.deepEqual(added.tags, []);
});

test('addTodo keeps tags in the given order (active filter tags first), deduped', () => {
  const [added] = addTodo([], 'call Sam', ['urgent', 'work', 'phone', 'work']);
  assert.deepEqual(added.tags, ['urgent', 'work', 'phone']);
});

test('addTodo normalizes tags and caps them at 10', () => {
  const tags = ['#Work', 'WORK', '  ', ...Array.from({ length: 12 }, (_, i) => `t${i}`)];
  const [added] = addTodo([], 'Many', tags);
  assert.deepEqual(added.tags, ['work', 't0', 't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);
});

test('addTodo trims surrounding whitespace', () => {
  const [added] = addTodo([], '   Buy milk \n');
  assert.equal(added.text, 'Buy milk');
});

test('addTodo ignores empty and whitespace-only text', () => {
  const todos = makeTodos();
  for (const text of ['', ' ', '   \t\n ']) {
    assert.equal(addTodo(todos, text), todos);
  }
});

test('addTodo gives each todo a unique id', () => {
  const todos = addTodo(addTodo(addTodo([], 'one'), 'two'), 'three');
  assert.equal(new Set(todos.map((todo) => todo.id)).size, 3);
});

test('toggleTodo flips completed for the matching id only', () => {
  const todos = makeTodos();
  const result = toggleTodo(todos, 'a');

  assert.deepEqual(result, [
    { id: 'a', text: 'First', completed: true, createdAt: 1 },
    { id: 'b', text: 'Second', completed: true, createdAt: 2 },
    { id: 'c', text: 'Third', completed: false, createdAt: 3 },
  ]);
  assert.equal(toggleTodo(result, 'a')[0].completed, false);
});

test('toggleTodo with an unknown id leaves todos unchanged', () => {
  const todos = makeTodos();
  assert.deepEqual(toggleTodo(todos, 'missing'), todos);
});

test('removeTodo removes only the matching todo', () => {
  const todos = makeTodos();
  assert.deepEqual(
    removeTodo(todos, 'b').map((todo) => todo.id),
    ['a', 'c'],
  );
  assert.deepEqual(removeTodo(todos, 'missing'), todos);
});

test('functions return new arrays and never mutate their input', () => {
  const todos = makeTodos();
  const snapshot = structuredClone(todos);

  const added = addTodo(todos, 'New');
  const toggled = toggleTodo(todos, 'a');
  const removed = removeTodo(todos, 'a');

  assert.notEqual(added, todos);
  assert.notEqual(toggled, todos);
  assert.notEqual(removed, todos);
  assert.notEqual(toggled[0], todos[0]);
  assert.deepEqual(todos, snapshot);

  const tagged = makeTagged();
  const taggedSnapshot = structuredClone(tagged);

  const withTags = addTodo(tagged, 'New', ['x']);
  const addedTag = addTag(tagged, 'c', 'health');
  const removedTag = removeTag(tagged, 'a', 'work');
  allTags(tagged);
  const filtered = filterByTags(tagged, ['work']);

  assert.notEqual(withTags, tagged);
  assert.notEqual(addedTag, tagged);
  assert.notEqual(removedTag, tagged);
  assert.notEqual(filtered, tagged);
  assert.notEqual(addedTag[2], tagged[2]);
  assert.notEqual(removedTag[0].tags, tagged[0].tags);
  assert.deepEqual(tagged, taggedSnapshot);

  const reminders = makeReminders();
  const remindersSnapshot = structuredClone(reminders);

  const set = setReminder(reminders, 'none', NOW + HOUR, 'weekly');
  const cleared = clearReminder(reminders, 'later');
  const marked = markNotified(reminders, ['old', 'newer']);
  const due = dueReminders(reminders, NOW);
  nextFireTime(reminders, NOW);
  const sorted = sortByUrgency(reminders, NOW);
  const rolled = toggleTodo(reminders, 'daily', NOW);
  const completed = toggleTodo(reminders, 'old', NOW);

  for (const result of [set, cleared, marked, due, sorted, rolled, completed]) assert.notEqual(result, reminders);
  assert.notEqual(set[1], reminders[1]);
  assert.notEqual(cleared[0], reminders[0]);
  assert.notEqual(marked[2], reminders[2]);
  assert.notEqual(rolled[5], reminders[5]);
  assert.deepEqual(reminders, remindersSnapshot);
});

test('ids are stable across toggle and remove', () => {
  const todos = makeTodos();
  const afterRemove = removeTodo(todos, 'a');
  assert.deepEqual(afterRemove.map((todo) => todo.id), ['b', 'c']);

  const afterToggle = toggleTodo(afterRemove, 'c');
  assert.deepEqual(afterToggle.map((todo) => todo.id), ['b', 'c']);
  assert.equal(afterToggle[1].completed, true);
});

test('addTag adds a normalized tag to the matching todo only', () => {
  const todos = makeTagged();
  const result = addTag(todos, 'c', '  #Health ');
  assert.deepEqual(result[2].tags, ['home', 'health']);
  assert.deepEqual(result.filter((todo) => todo.id !== 'c'), todos.filter((todo) => todo.id !== 'c'));
});

test('addTag treats Work, #work and " work " as the same tag', () => {
  for (const raw of ['Work', '#work', ' work ']) {
    assert.deepEqual(addTag(makeTagged(), 'd', raw)[3].tags, ['work'], raw);
  }
});

test('addTag ignores duplicates, invalid input, the 11th tag and unknown ids', () => {
  const todos = makeTagged();
  for (const raw of ['work', 'WORK', '#Work', '', '   ', '#', '##work', 'x'.repeat(25)]) {
    assert.equal(addTag(todos, 'a', raw), todos, JSON.stringify(raw));
  }
  assert.equal(addTag(todos, 'missing', 'new'), todos);

  const full = deepFreeze([
    { id: 'f', text: 'Full', completed: false, createdAt: 1, tags: Array.from({ length: 10 }, (_, i) => `t${i}`) },
  ]);
  assert.equal(addTag(full, 'f', 'eleventh'), full);
});

test('removeTag removes the tag from the matching todo only', () => {
  const todos = makeTagged();
  const result = removeTag(todos, 'a', 'work');
  assert.deepEqual(result[0].tags, ['dev']);
  assert.deepEqual(result[1].tags, ['work', 'blocked']);
});

test('removeTag with an unknown tag or id is a no-op', () => {
  const todos = makeTagged();
  assert.equal(removeTag(todos, 'a', 'home'), todos);
  assert.equal(removeTag(todos, 'missing', 'work'), todos);
});

test('allTags lists tags in use A to Z with counts', () => {
  assert.deepEqual(allTags(makeTagged()), [
    { tag: 'blocked', count: 1 },
    { tag: 'dev', count: 1 },
    { tag: 'home', count: 1 },
    { tag: 'work', count: 2 },
  ]);
});

test('allTags omits tags no todo uses any more', () => {
  const todos = removeTag(removeTag(makeTagged(), 'a', 'work'), 'b', 'work');
  assert.deepEqual(allTags(todos).map(({ tag }) => tag), ['blocked', 'dev', 'home']);
  assert.deepEqual(allTags([]), []);
});

test('filterByTags with no active tags returns every todo', () => {
  const todos = makeTagged();
  assert.deepEqual(filterByTags(todos, []), todos);
});

test('filterByTags with one tag returns the todos carrying it', () => {
  assert.deepEqual(ids(filterByTags(makeTagged(), ['work'])), ['a', 'b']);
});

test('filterByTags with two tags returns todos with either (OR), each once, in order', () => {
  assert.deepEqual(ids(filterByTags(makeTagged(), ['home', 'work'])), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterByTags(makeTagged(), ['blocked', 'work'])), ['a', 'b']);
});

// Reminders. Instants are plain numbers here; local wall-clock math is covered in reminders.test.js.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 17); // a fixed "now"

const none = { due: null, repeat: 'none', notified: null };

function makeReminders() {
  return deepFreeze([
    { id: 'later', text: 'Upcoming', completed: false, createdAt: 1, tags: ['work'], due: NOW + HOUR, repeat: 'none', notified: null },
    { id: 'none', text: 'No reminder', completed: false, createdAt: 2, tags: ['home'], ...none },
    { id: 'newer', text: 'Overdue a little', completed: false, createdAt: 3, tags: ['home'], due: NOW - MINUTE, repeat: 'none', notified: null },
    { id: 'done', text: 'Done, past due', completed: true, createdAt: 4, tags: ['work'], due: NOW - DAY, repeat: 'none', notified: null },
    { id: 'old', text: 'Overdue a lot', completed: false, createdAt: 5, tags: ['work'], due: NOW - 3 * DAY, repeat: 'none', notified: null },
    { id: 'daily', text: 'Water the plants', completed: false, createdAt: 6, tags: ['home'], due: NOW - 3 * DAY, repeat: 'daily', notified: NOW - 3 * DAY },
    { id: 'soon', text: 'Very soon', completed: false, createdAt: 7, tags: [], due: NOW + MINUTE, repeat: 'weekly', notified: null },
  ]);
}

test('addTodo gives a new todo no reminder', () => {
  const [added] = addTodo([], 'Plain');
  assert.equal(added.due, null);
  assert.equal(added.repeat, 'none');
  assert.equal(added.notified, null);
});

test('setReminder sets due and repeat on the matching todo only and resets notified', () => {
  const todos = makeReminders();
  const result = setReminder(todos, 'daily', NOW + DAY, 'weekly');
  assert.deepEqual(result[5], { ...todos[5], due: NOW + DAY, repeat: 'weekly', notified: null });
  assert.deepEqual(result.filter((todo) => todo.id !== 'daily'), todos.filter((todo) => todo.id !== 'daily'));

  const added = setReminder(todos, 'none', NOW - HOUR, 'none');
  assert.deepEqual(added[1], { ...todos[1], due: NOW - HOUR, repeat: 'none', notified: null });
  assert.deepEqual(added[1].tags, ['home']);
  assert.equal(added[1].text, 'No reminder');
});

test('setReminder re-arms an already alerted reminder, even with the same time', () => {
  const todos = makeReminders();
  assert.equal(setReminder(todos, 'daily', todos[5].due, 'daily')[5].notified, null);
});

test('setReminder ignores an unknown id, a bad due and a bad repeat', () => {
  const todos = makeReminders();
  assert.equal(setReminder(todos, 'missing', NOW, 'none'), todos);
  for (const due of [NaN, Infinity, null, undefined, '1000', 1.5, 9e15]) {
    assert.equal(setReminder(todos, 'none', due, 'none'), todos, String(due));
  }
  for (const repeat of ['monthly', undefined, null, '', 'Daily', 'toString']) {
    assert.equal(setReminder(todos, 'none', NOW, repeat), todos, String(repeat));
  }
});

test('clearReminder resets due, repeat and notified on the matching todo only', () => {
  const todos = makeReminders();
  const result = clearReminder(todos, 'daily');
  assert.deepEqual(result[5], { ...todos[5], ...none });
  assert.deepEqual(result.filter((todo) => todo.id !== 'daily'), todos.filter((todo) => todo.id !== 'daily'));
  assert.equal(clearReminder(todos, 'missing'), todos);
});

test('markNotified sets notified = due for the listed ids only', () => {
  const todos = makeReminders();
  const result = markNotified(todos, ['old', 'newer']);
  assert.equal(result[4].notified, todos[4].due);
  assert.equal(result[2].notified, todos[2].due);
  for (const index of [0, 1, 3, 5, 6]) assert.equal(result[index], todos[index]);
  assert.equal(markNotified(todos, ['none'])[1].notified, null);
});

test('dueReminders returns overdue, un-alerted todos, most overdue first', () => {
  const todos = makeReminders();
  // 'daily' is overdue but already alerted; 'done' is completed; 'later', 'soon' are future; 'none' has none.
  assert.deepEqual(ids(dueReminders(todos, NOW)), ['old', 'newer']);
  assert.deepEqual(ids(dueReminders(markNotified(todos, ['old']), NOW)), ['newer']);
  assert.deepEqual(ids(dueReminders(todos, NOW + HOUR)), ['old', 'newer', 'soon', 'later']);
  assert.deepEqual(dueReminders(todos, NOW - 10 * DAY), []);
  assert.deepEqual(dueReminders([], NOW), []);
});

test('dueReminders includes a todo due exactly now', () => {
  assert.deepEqual(ids(dueReminders(makeReminders(), NOW + MINUTE)), ['old', 'newer', 'soon']);
});

test('nextFireTime is the smallest future due of an incomplete, un-alerted todo', () => {
  const todos = makeReminders();
  assert.equal(nextFireTime(todos, NOW), NOW + MINUTE);
  assert.equal(nextFireTime(todos, NOW + MINUTE), NOW + HOUR);
  assert.equal(nextFireTime(todos, NOW + HOUR), null);
  assert.equal(nextFireTime([], NOW), null);
});

test('nextFireTime ignores completed, alerted, past and no-reminder todos', () => {
  const base = { text: 'x', createdAt: 1, tags: [] };
  const todos = deepFreeze([
    { ...base, id: 'done', completed: true, due: NOW + MINUTE, repeat: 'none', notified: null },
    { ...base, id: 'alerted', completed: false, due: NOW + 2 * MINUTE, repeat: 'none', notified: NOW + 2 * MINUTE },
    { ...base, id: 'past', completed: false, due: NOW - MINUTE, repeat: 'daily', notified: null },
    { ...base, id: 'none', completed: false, ...none },
    { ...base, id: 'legacy', completed: false },
  ]);
  assert.equal(nextFireTime(todos, NOW), null);
  assert.equal(nextFireTime([...todos, { ...base, id: 'later', completed: false, due: NOW + DAY, repeat: 'none', notified: null }], NOW), NOW + DAY);
});

test('sortByUrgency puts overdue todos first by due, and keeps everything else in order', () => {
  const todos = makeReminders();
  // Overdue: old (-3d), daily (-3d, created later so it stays after old), newer (-1m).
  // Then the rest in their original order, including the completed one with a past due.
  assert.deepEqual(ids(sortByUrgency(todos, NOW)), ['old', 'daily', 'newer', 'later', 'none', 'done', 'soon']);
});

test('sortByUrgency keeps ties in their original order and leaves the input unchanged', () => {
  const base = { text: 'x', createdAt: 1, tags: [], completed: false, repeat: 'none', notified: null };
  const todos = deepFreeze([
    { ...base, id: 'b', due: NOW - HOUR },
    { ...base, id: 'a', due: NOW - HOUR },
    { ...base, id: 'c', due: NOW - 2 * HOUR },
    { ...base, id: 'd', due: null },
    { ...base, id: 'e', due: NOW + HOUR },
  ]);
  const snapshot = structuredClone(todos);
  assert.deepEqual(ids(sortByUrgency(todos, NOW)), ['c', 'b', 'a', 'd', 'e']);
  assert.deepEqual(todos, snapshot);
});

test('sortByUrgency with nothing overdue keeps the order; empty stays empty', () => {
  const todos = makeReminders();
  assert.deepEqual(ids(sortByUrgency(todos, NOW - 10 * DAY)), ids(todos));
  assert.deepEqual(sortByUrgency([], NOW), []);
  assert.deepEqual(ids(sortByUrgency(makeTodos(), NOW)), ['a', 'b', 'c']);
});

test('sortByUrgency after filterByTags keeps only the filtered todos, overdue first', () => {
  const todos = makeReminders();
  assert.deepEqual(ids(sortByUrgency(filterByTags(todos, ['work']), NOW)), ['old', 'later', 'done']);
  assert.deepEqual(ids(sortByUrgency(filterByTags(todos, ['home']), NOW)), ['daily', 'newer', 'none']);
});

test('toggleTodo keeps a daily todo checked while scheduling tomorrow', () => {
  const todos = makeReminders();
  const result = toggleTodo(todos, 'daily', NOW);
  const todo = result[5];
  assert.equal(todo.completed, true);
  assert.equal(todo.due, nextOccurrence(todos[5].due, 'daily', NOW));
  assert.ok(todo.due > NOW);
  assert.equal(todo.text, 'Water the plants');
  assert.deepEqual(todo.tags, ['home']);
  assert.equal(todo.repeat, 'daily');
  assert.equal(todo.notified, null);
  for (const index of [0, 1, 2, 3, 4, 6]) assert.equal(result[index], todos[index]);
});

test('a daily check skips an overdue cycle and reopens at midnight before the new alert', () => {
  const now = new Date(2026, 10, 20, 10).getTime();
  const due = new Date(2026, 10, 19, 16).getTime();
  const nextDay = new Date(2026, 10, 21).getTime();
  const nextDue = new Date(2026, 10, 21, 16).getTime();
  const [todo] = toggleTodo([{ id: 'daily', completed: false, due, repeat: 'daily', notified: due }], 'daily', now);

  assert.equal(todo.due, nextDue);
  assert.equal(todo.completedUntil, nextDay);
  assert.equal(isCompleted(todo, nextDay - 1), true);
  assert.equal(isCompleted(todo, nextDay), false);
  assert.equal(nextFireTime([todo], now), nextDay);
  assert.equal(nextFireTime([todo], nextDay), nextDue);
  assert.deepEqual(dueReminders([todo], nextDue), [todo]);

  const [unchecked] = toggleTodo([todo], 'daily', now);
  assert.equal(unchecked.completed, false);
  assert.equal(unchecked.due, nextDue);
  assert.deepEqual(toggleTodo([unchecked], 'daily', now), [todo]);
});

test('toggleTodo completing a weekly todo early moves it a week on', () => {
  const todos = makeReminders();
  const todo = toggleTodo(todos, 'soon', NOW)[6];
  assert.equal(todo.completed, true);
  assert.equal(todo.due, NOW + MINUTE + 7 * DAY);
  assert.equal(todo.due, nextOccurrence(NOW + MINUTE, 'weekly', NOW));
});

test('toggleTodo completing a non-repeating todo checks it and keeps its due', () => {
  const todos = makeReminders();
  const todo = toggleTodo(todos, 'old', NOW)[4];
  assert.equal(todo.completed, true);
  assert.equal(todo.due, todos[4].due);
  assert.equal(todo.notified, todos[4].notified);
  // Unchecking it again just uncompletes it.
  assert.deepEqual(toggleTodo([todo], 'old', NOW)[0], todos[4]);
});

test('toggleTodo on a completed repeating todo uncompletes it without advancing', () => {
  const todos = deepFreeze([{ ...makeReminders()[5], completed: true }]);
  const [todo] = toggleTodo(todos, 'daily', NOW);
  assert.equal(todo.completed, false);
  assert.equal(todo.due, todos[0].due);
});

test('toggleTodo on a todo without a reminder flips completed as before', () => {
  const todos = makeReminders();
  assert.deepEqual(toggleTodo(todos, 'none', NOW)[1], { ...todos[1], completed: true });
  assert.deepEqual(toggleTodo(makeTodos(), 'a', NOW)[0], { id: 'a', text: 'First', completed: true, createdAt: 1 });
});

test('toggleTodo defaults now to the current time', () => {
  const due = Date.now() - DAY - HOUR;
  const todos = deepFreeze([{ id: 'r', text: 'x', completed: false, createdAt: 1, tags: [], due, repeat: 'daily', notified: null }]);
  const before = Date.now();
  const [todo] = toggleTodo(todos, 'r');
  assert.ok(todo.due > before);
  assert.equal(todo.completed, true);
});

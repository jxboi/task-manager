// The composer's second line in src/app.js: which shelf a new task goes on, and a quick reminder
// (with its repeat) that is sent right after the task is created.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';

test('the composer adds a quick reminder to the next task', async (t) => {
  const server = createFakeApi();
  server.rows = [{
    id: '00000000-0000-4000-8000-0000000000c1', text: 'Old', category: 'work', completed: false,
    createdAt: 1, due: null, repeat: 'none', notified: null, revision: 1,
  }];
  const { byId } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  const form = byId('add-form');
  const input = byId('new-todo');
  const quick = byId('add-quick');
  const repeat = byId('add-repeat');
  const chip = (group, name, value) => group.children.find((item) => item.dataset[name] === value);
  const pressed = (group) => group.children.filter((item) => item.getAttribute('aria-pressed') === 'true')
    .map((item) => item.dataset.quick ?? item.dataset.repeat);
  const add = async (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    form.dispatchEvent(new Event('submit'));
    await settle();
  };

  byId('add-toggle').click();

  await t.test('no reminder by default, tomorrow is always offered, repeat waits for a reminder', () => {
    assert.deepEqual(pressed(quick), ['none']);
    assert.ok(chip(quick, 'quick', 'tomorrow'));
    assert.match(chip(quick, 'quick', 'tomorrow').textContent, /^Tomorrow /);
    assert.equal(repeat.hidden, true);
    assert.equal(byId('add-shelf').hidden, true);
  });

  await t.test('a selected shelf is named', () => {
    byId('filter-bar').children.find((item) => item.dataset.category === 'work').click();
    assert.equal(byId('add-shelf').hidden, false);
    assert.equal(byId('add-shelf').textContent, 'Adds to work');
  });

  await t.test('tomorrow + weekly is saved on the new task, then the choice resets', async () => {
    chip(quick, 'quick', 'tomorrow').click();
    assert.deepEqual(pressed(quick), ['tomorrow']);
    assert.equal(repeat.hidden, false);
    chip(repeat, 'repeat', 'weekly').click();
    assert.deepEqual(pressed(repeat), ['weekly']);
    await add('Plan sprint');
    const row = server.rows.find((item) => item.text === 'Plan sprint');
    const expected = new Date();
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    assert.equal(row.due, expected.getTime());
    assert.equal(row.repeat, 'weekly');
    assert.equal(row.category, 'work');
    assert.deepEqual(pressed(quick), ['none']);
    assert.equal(repeat.hidden, true);
  });

  await t.test('without a reminder only the create is sent', async () => {
    const before = server.requests.length;
    await add('Plain');
    const sent = server.requests.slice(before).filter((request) => request.method !== 'GET');
    assert.deepEqual(sent.map((request) => request.method), ['POST']);
    assert.equal(server.rows.find((item) => item.text === 'Plain').due, null);
  });

  // Signing out clears the reminder timer, so nothing keeps node:test alive.
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
});

// The + button next to the "Tasks" title: it reveals the new-task field in src/app.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installDom } from './dom.js';
import { createFakeApi, settle } from './fake-api.js';
import { markupAttributes } from './markup.js';

test('the + button opens the new-task field', async (t) => {
  const server = createFakeApi();
  const { byId, list } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  await import('../src/app.js');
  const toggle = byId('add-toggle');
  const form = byId('add-form');
  const input = byId('new-todo');
  const texts = () => list.children.map((item) => item.querySelector('.todo-text').textContent);
  const keydown = (target, key) => {
    const event = new Event('keydown', { cancelable: true });
    event.key = key;
    target.dispatchEvent(event);
    return event;
  };
  const type = (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await settle();

  await t.test('it has a name and starts closed', () => {
    const markup = markupAttributes('add-toggle');
    assert.equal(markup['aria-label'], 'Add task');
    assert.equal(markup['aria-controls'], 'add-form');
    assert.equal(markup['aria-expanded'], 'false');
    assert.equal(markup.type, 'button');
    assert.equal('hidden' in markupAttributes('add-form'), true);
    assert.equal(form.hidden, true);
    assert.equal(byId('empty-state').hidden, false);
  });

  await t.test('tapping it reveals and focuses the field; a #tag is saved as a tag', async () => {
    toggle.click();
    assert.equal(form.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, input);
    type('Buy milk #home');
    assert.equal(byId('add-button').disabled, false);
    form.dispatchEvent(new Event('submit'));
    await settle();
    assert.deepEqual(texts(), ['Buy milk']);
    assert.deepEqual(server.rows.at(-1).tags, ['home']);
    // The field stays open for the next task.
    assert.equal(form.hidden, false);
    assert.equal(input.value, '');
    assert.equal(document.activeElement, input);
  });

  await t.test('Escape in the field closes it and returns focus to +', () => {
    type('Half typed');
    const event = keydown(form, 'Escape'); // the fake DOM doesn't bubble: the form stands in for the field
    assert.equal(event.defaultPrevented, true);
    assert.equal(form.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(document.activeElement, toggle);
    // What was typed is kept for when it reopens.
    toggle.click();
    assert.equal(input.value, 'Half typed');
    type('');
  });

  await t.test('Escape on the Add button closes it; not during IME composition', () => {
    type('Draft');
    const composing = new Event('keydown', { cancelable: true });
    Object.assign(composing, { key: 'Escape', isComposing: true });
    form.dispatchEvent(composing);
    assert.equal(form.hidden, false);
    // The fake DOM doesn't bubble: the form stands in for a keydown from the Add button.
    assert.equal(keydown(form, 'Escape').defaultPrevented, true);
    assert.equal(form.hidden, true);
    toggle.click();
    type('');
  });

  await t.test('pressing + again closes it', () => {
    assert.equal(form.hidden, false);
    toggle.click();
    assert.equal(form.hidden, true);
    assert.equal(document.activeElement, toggle);
  });

  await t.test('a failed add reopens the field with the draft and says so', async () => {
    toggle.click();
    type('Call Sam #work');
    server.failNext = (method) => (method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
    form.dispatchEvent(new Event('submit'));
    toggle.click(); // closed while the save is on its way
    assert.equal(form.hidden, true);
    await settle();
    assert.equal(form.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(input.value, 'Call Sam #work');
    assert.equal(byId('sync-text').textContent, "Couldn't add “Call Sam”.");
    assert.equal(byId('sync-note').hidden, false);
    // Dismissing the note goes back to the open field.
    byId('sync-dismiss').click();
    assert.equal(document.activeElement, input);
  });

  const press = (type, pointerType = 'mouse') => {
    const event = new Event(type);
    event.button = 0;
    event.isPrimary = true;
    event.pointerType = pointerType;
    document.dispatchEvent(event);
  };
  // A mouse press: pointerdown … pointerup, then mousedown/mouseup and click in the same task.
  const mouseRelease = () => {
    press('pointerup');
    press('mouseup');
    press('click');
  };

  await t.test('a failed add arriving mid-press waits for the release before reopening', async () => {
    byId('sync-dismiss').click();
    type('Call Ana');
    server.failNext = (method) => (method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
    form.dispatchEvent(new Event('submit'));
    toggle.click(); // closed while the save is on its way
    press('pointerdown'); // the user is pressing a task control when the failure arrives
    await settle();
    assert.equal(form.hidden, true, 'the composer does not move the list mid-press');
    assert.equal(byId('sync-note').hidden, true);
    assert.equal(input.value, '');
    mouseRelease();
    await settle();
    assert.equal(form.hidden, false);
    assert.equal(input.value, 'Call Ana');
    assert.equal(byId('sync-text').textContent, "Couldn't add “Call Ana”.");
    assert.equal(byId('sync-note').hidden, false);
    byId('sync-dismiss').click();
    type('');
  });

  await t.test('a failed add arriving during a touch waits for its click, not the finger landing', async () => {
    type('Call Cy');
    server.failNext = (method) => (method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
    form.dispatchEvent(new Event('submit'));
    toggle.click();
    press('pointerdown', 'touch'); // the finger lands on a task control: no mouse events yet
    await settle();
    assert.equal(form.hidden, true, 'the composer does not move the list under the finger');
    assert.equal(byId('sync-note').hidden, true);
    press('pointerup', 'touch'); // the finger lifts; the synthesized mouse events and click follow later
    await settle();
    assert.equal(form.hidden, true, 'still held between pointerup and the synthesized click');
    assert.equal(byId('sync-note').hidden, true);
    press('mousedown');
    press('mouseup');
    press('click');
    await settle();
    assert.equal(form.hidden, false);
    assert.equal(input.value, 'Call Cy');
    assert.equal(byId('sync-text').textContent, "Couldn't add “Call Cy”.");
    assert.equal(byId('sync-note').hidden, false);
    byId('sync-dismiss').click();
    type('');
  });

  await t.test('a cancelled touch (a scroll) releases the held failure at once', async () => {
    type('Call Di');
    server.failNext = (method) => (method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
    form.dispatchEvent(new Event('submit'));
    toggle.click();
    press('pointerdown', 'touch');
    await settle();
    assert.equal(form.hidden, true);
    press('pointercancel', 'touch');
    await settle();
    assert.equal(form.hidden, false);
    assert.equal(input.value, 'Call Di');
    byId('sync-dismiss').click();
    type('');
  });

  await t.test('the too-long hint only shows while the field is open', () => {
    type('x'.repeat(2001));
    assert.equal(byId('hint-limit').hidden, false);
    toggle.click();
    assert.equal(byId('hint-limit').hidden, true);
    toggle.click();
    assert.equal(byId('hint-limit').hidden, false);
    type('');
  });

  await t.test('a held add failure is dropped if the session ends before the release', async () => {
    type('Call Bo');
    server.failNext = (method) => (method === 'POST' ? new Response('{}', { status: 500 }) : undefined);
    form.dispatchEvent(new Event('submit'));
    toggle.click();
    press('pointerdown');
    await settle();
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    await settle();
    mouseRelease();
    await settle();
    assert.equal(form.hidden, true);
    assert.equal(input.value, '');
    assert.equal(byId('sync-note').hidden, true);
  });

  await t.test('signing out closes the field', async () => {
    window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: null } }));
    await settle();
    assert.equal(form.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(input.value, '');
  });
});

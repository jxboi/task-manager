import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createFakeApi, settle as flush } from './fake-api.js';
import { installDom } from './dom.js';

const permissionInfo = 'When you save, your browser will ask to allow notifications. If you say no, due tasks are still highlighted on this page.';
const invalidDate = 'Enter a valid date and time.';
const pastTime = 'That time has passed. Saving will mark this task overdue and alert right away.';
const doneTask = "This task is done, so its reminder won't alert. Uncheck it to turn alerts back on.";
const notificationsBlocked = 'Notifications are blocked or unavailable. Due tasks will be highlighted on this page.';
const blockedNote = 'Notifications off. Reminders show only here.';
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const future = '2099-01-01T12:00';
const past = '2000-01-01T12:00';

test('reminder editor', async (t) => {
  const { byId, list, matchMedia, session } = installDom(t, { fetch: (...args) => server.fetch(...args) });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const lateDue = Date.parse('2001-01-01T09:00:00');
  const ids = {
    open: '00000000-0000-4000-8000-000000000001',
    done: '00000000-0000-4000-8000-000000000002',
    late: '00000000-0000-4000-8000-000000000003',
  };
  const base = { tags: [], due: null, repeat: 'none', notified: null, revision: 1 };
  const server = createFakeApi();
  server.rows = [
    { ...base, id: ids.open, text: 'Open task', completed: false, createdAt: 1 },
    { ...base, id: ids.done, text: 'Done task', completed: true, createdAt: 2 },
    // Overdue and not alerted yet: it fires when the app starts.
    { ...base, id: ids.late, text: 'Late task', completed: false, createdAt: 3, due: lateDue },
  ];
  await import('../src/app.js');
  // What the auth module sends once the session is known.
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active: server.session } }));
  await flush();

  const date = byId('reminder-when');
  const save = byId('reminder-save');
  const message = byId('reminder-message');
  const messageText = byId('reminder-message-text');
  const open = (id) => list.children.find((row) => row.dataset.id === ids[id]).querySelector('.reminder-add').click();
  const cancel = () => byId('reminder-cancel').click();
  const edit = (value) => {
    date.value = value;
    date.dispatchEvent(new Event('input'));
  };
  const visibleMessage = () => message.hidden ? null : messageText.textContent;
  const row = (id) => list.children.find((item) => item.dataset.id === ids[id]);
  const isFired = (id) => row(id).className.split(' ').includes('is-fired');
  const settle = () => new Promise((resolve) => setTimeout(resolve)); // renderSoon is deferred
  const dispatch = (target, type, props = {}) => {
    const event = Object.assign(new Event(type), props);
    Object.defineProperty(event, 'target', { value: target });
    return event;
  };
  // Saving a past time re-arms the alert, so the todo fires again (once the server has the
  // reminder and grants the claim): a fresh highlight.
  const fireAgain = async (id) => {
    row(id).querySelector('.reminder-chip').click();
    edit(past);
    save.click();
    await flush();
  };

  await t.test('opens empty with permission info when applicable and no invalid state or alert', () => {
    const cases = [
      ['open', 'default', permissionInfo],
      ['done', 'default', permissionInfo],
      ['open', 'granted', null],
      ['open', 'denied', null],
    ];
    for (const [id, permission, expected] of cases) {
      Notification.permission = permission;
      open(id);
      try {
        assert.equal(date.value, '');
        assert.equal(date.getAttribute('aria-invalid'), null);
        assert.equal(date.getAttribute('aria-describedby'), null);
        assert.equal(message.getAttribute('role'), null);
        assert.equal(save.getAttribute('aria-disabled'), 'true');
        assert.equal(visibleMessage(), expected, `${id}, ${permission}`);
        if (permission === 'denied') {
          edit(future);
          assert.equal(visibleMessage(), notificationsBlocked);
        }
      } finally {
        cancel();
      }
    }
  });

  await t.test('clearing an edited date shows an alert until the value parses', () => {
    Notification.permission = 'default';
    open('open');
    edit(future);
    assert.equal(visibleMessage(), permissionInfo);
    edit('');
    assert.equal(visibleMessage(), invalidDate);
    assert.equal(message.getAttribute('role'), 'alert');
    assert.equal(date.getAttribute('aria-invalid'), 'true');
    assert.equal(date.getAttribute('aria-describedby'), 'reminder-message');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    edit(future);
    assert.equal(visibleMessage(), permissionInfo);
    assert.equal(message.getAttribute('role'), null);
    assert.equal(date.getAttribute('aria-invalid'), null);
    assert.equal(date.getAttribute('aria-describedby'), null);
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    cancel();
  });

  await t.test('shows one message in priority order as the date changes', () => {
    Notification.permission = 'default';
    open('done');
    try {
      assert.equal(visibleMessage(), permissionInfo);
      edit(future);
      assert.equal(visibleMessage(), doneTask);
      edit(past);
      assert.equal(visibleMessage(), pastTime);
      assert.equal(save.getAttribute('aria-disabled'), 'false');
      edit('');
      assert.equal(visibleMessage(), invalidDate);
    } finally {
      cancel();
    }
  });

  await t.test('pressing aria-disabled Save reveals the error and focuses the empty input', () => {
    Notification.permission = 'default';
    open('open');
    assert.equal(visibleMessage(), permissionInfo);
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    save.focus();
    assert.equal(document.activeElement, save);
    save.click();
    assert.equal(visibleMessage(), invalidDate);
    assert.equal(document.activeElement, date);
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    assert.equal(byId('reminder-layer').hidden, false);
    cancel();
    open('open');
    assert.equal(visibleMessage(), permissionInfo);
    assert.equal(date.getAttribute('aria-invalid'), null);
    cancel();
  });

  await t.test('an overdue chip is one chip reading "Overdue · {due}" with a sensible name', () => {
    const chip = row('late').querySelector('.reminder-chip');
    assert.match(chip.className, /\bis-overdue\b/);
    // Another year: "{short date with year}, {time}", in the runtime's locale, as the app formats it.
    const format = (options) => new Intl.DateTimeFormat(undefined, options).format(new Date(lateDue));
    const when = `${format({ month: 'short', day: 'numeric', year: 'numeric' })}, ${format({ hour: 'numeric', minute: '2-digit' })}`;
    assert.equal(chip.querySelector('.reminder-when').textContent, `Overdue · ${when}`);
    assert.equal(chip.getAttribute('aria-label'), `Overdue, was due ${when}. Edit reminder for “Late task”`);
  });

  await t.test('a fired row has no "Got it" button', async () => {
    Notification.permission = 'granted';
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    assert.equal(row('late').querySelector('.reminder-got-it'), null);
  });

  await t.test('a tap or click anywhere in a fired row clears it', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late').querySelector('.todo-text'), 'click'));
    await settle();
    assert.equal(isFired('late'), false);
    assert.match(row('late').className, /\bis-overdue\b/); // still overdue, just settled
  });

  await t.test('focus moving into a fired row clears it', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late').querySelector('.todo-checkbox'), 'focusin'));
    await settle();
    assert.equal(isFired('late'), false);
  });

  await t.test('Esc clears a fired row', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    document.dispatchEvent(dispatch(document, 'keydown', { key: 'Escape' }));
    await settle();
    assert.equal(isFired('late'), false);
  });

  await t.test('the end of the pulses clears a fired row; other animations do not', async () => {
    await fireAgain('late');
    list.dispatchEvent(dispatch(row('late'), 'animationend', { animationName: 'something-else' }));
    await settle();
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late'), 'animationend', { animationName: 'reminder-pulse' }));
    await settle();
    assert.equal(isFired('late'), false);
  });

  await t.test('the pulse ending updates the row in place and keeps an open "+ tag" field', async () => {
    await fireAgain('late');
    row('open').querySelector('.tag-add').click();
    const field = row('open').querySelector('.tag-field');
    const lateRow = row('late');
    assert.ok(field);
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(lateRow, 'animationend', { animationName: 'reminder-pulse' }));
    await settle();
    assert.equal(row('late'), lateRow, 'the row was not re-rendered');
    assert.equal(lateRow.style.animationDelay, '');
    assert.equal(isFired('late'), false);
    assert.equal(row('open').querySelector('.tag-field'), field, 'the tag field was not replaced');
    assert.equal(document.activeElement, field);
    list.dispatchEvent(dispatch(field, 'keydown', { key: 'Escape', preventDefault() {} }));
  });

  // The real handler runs in the capture phase, before the field's own Esc handler.
  await t.test('Esc in an open "+ tag" field clears the pulses and still closes the field', async () => {
    await fireAgain('late');
    row('open').querySelector('.tag-add').click();
    const field = row('open').querySelector('.tag-field');
    const escape = dispatch(field, 'keydown', { key: 'Escape', preventDefault() { this.prevented = true; } });
    document.dispatchEvent(escape);
    list.dispatchEvent(escape);
    await settle();
    assert.equal(isFired('late'), false);
    assert.equal(escape.prevented, true);
    assert.equal(row('open').querySelector('.tag-field'), null);
  });

  await t.test('Esc in the reminder editor clears the pulses and still closes the editor', async () => {
    await fireAgain('late');
    row('open').querySelector('.reminder-add').click();
    assert.equal(byId('reminder-layer').hidden, false);
    const escape = dispatch(date, 'keydown', { key: 'Escape', preventDefault() {} });
    document.dispatchEvent(escape);
    byId('reminder-editor').dispatchEvent(escape);
    await settle();
    assert.equal(byId('reminder-layer').hidden, true);
    assert.equal(isFired('late'), false);
  });

  await t.test('reduced motion turned on mid-pulse leaves no fired state behind', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    reducedMotion.matches = true;
    try {
      reducedMotion.dispatchEvent(new Event('change'));
      assert.equal(isFired('late'), false);
    } finally {
      reducedMotion.matches = false;
      reducedMotion.dispatchEvent(new Event('change'));
    }
    byId('reminder-cancel').click(); // any render: the old pulse must not come back
    assert.equal(isFired('late'), false);
  });

  await t.test('the pulse starts and ends on the base overdue tint, so it shows on a hovered row', () => {
    const keyframes = styles.match(/@keyframes reminder-pulse \{([\s\S]*?)\n\}/)[1];
    assert.match(keyframes, /0%,\s*100% \{\s*background: var\(--color-over-bg\);/);
    assert.match(keyframes, /50% \{\s*background: var\(--color-over-bg-hover\);/);
  });

  // Saves a future time; the next test saves a past one again, so no timer keeps node:test alive.
  await t.test('editing the todo clears a fired row', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    row('late').querySelector('.reminder-chip').click();
    edit(future);
    save.click();
    assert.equal(isFired('late'), false);
  });

  await t.test('with reduced motion a fired row is just overdue (no pulse to wait for)', async () => {
    reducedMotion.matches = true;
    try {
      await fireAgain('late');
      assert.equal(isFired('late'), false);
      assert.match(row('late').className, /\bis-overdue\b/);
    } finally {
      reducedMotion.matches = false;
    }
  });

  await t.test('the blocked note, once dismissed, stays hidden for the session on later Saves', async () => {
    const banner = byId('banner');
    Notification.permission = 'denied';
    try {
      await fireAgain('late');
      assert.equal(banner.hidden, false);
      assert.match(banner.className, /\bis-note\b/);
      assert.equal(byId('banner-text').textContent, blockedNote);
      assert.equal(byId('banner-dismiss').hidden, false);

      byId('banner-dismiss').click();
      assert.equal(banner.hidden, true);
      assert.equal(session.get('task-manager.blocked-note-dismissed'), '1');

      await fireAgain('late');
      assert.equal(banner.hidden, true);
      await fireAgain('late');
      assert.equal(banner.hidden, true);
    } finally {
      Notification.permission = 'default';
    }
  });
});

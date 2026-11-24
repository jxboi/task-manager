import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createFakeApi, settle as flush } from './fake-api.js';
import { installDom } from './dom.js';

// The sheet's short messages (no helper text: the permission explainer is gone).
const invalidDate = 'Enter a valid date and time.';
const pastTime = 'That time has passed';
const doneTask = 'This task is done';
const notificationsBlocked = 'Notifications off';
const blockedNote = 'Notifications off';
const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const future = '2099-01-01T12:00';
const past = '2000-01-01T12:00';

test('task sheet reminder picker', async (t) => {
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

  const on = byId('reminder-on');
  const date = byId('reminder-date');
  const time = byId('reminder-time');
  const save = byId('reminder-save');
  const message = byId('reminder-message');
  const messageText = byId('reminder-message-text');
  const open = (id) => list.children.find((row) => row.dataset.id === ids[id]).querySelector('.todo-open').click();
  const cancel = () => byId('reminder-cancel').click();
  // "YYYY-MM-DDTHH:MM" turns the Reminder switch on and sets Date and Time; '' turns it off.
  const edit = (value) => {
    const [day = '', clock = ''] = value.split('T');
    if (on.checked !== (value !== '')) {
      on.checked = value !== '';
      on.dispatchEvent(new Event('change'));
    }
    date.value = day;
    time.value = clock;
    time.dispatchEvent(new Event('input'));
  };
  const clearTime = () => {
    time.value = '';
    time.dispatchEvent(new Event('input'));
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
  // Picks a day the way a user does: open the calendar, page to its month, press the day.
  const pickDay = (iso) => {
    const [year, month] = iso.split('-').map(Number);
    const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(new Date(year, month - 1, 1));
    if (byId('calendar').hidden) byId('reminder-date-button').click();
    for (let guard = 0; byId('cal-month').textContent !== label && guard < 2000; guard += 1) {
      const shown = byId('cal-days').children.find((cell) => cell.dataset.date)?.dataset.date.slice(0, 7);
      byId(shown > iso.slice(0, 7) ? 'cal-prev' : 'cal-next').click();
    }
    assert.equal(byId('cal-month').textContent, label);
    const cell = byId('cal-days').children.find((item) => item.dataset.date === iso);
    assert.ok(!cell.disabled, 'past days can be picked');
    cell.click();
  };
  // Saving a new past time re-arms the alert, so the todo fires again (once the server has the
  // reminder and grants the claim): a fresh highlight.
  // Each call saves a different past minute: the sheet sends nothing for an unchanged reminder.
  let firings = 0;
  const fireAgain = async (id) => {
    row(id).querySelector('.todo-open').click();
    firings += 1;
    if (!on.checked) {
      on.checked = true;
      on.dispatchEvent(new Event('change'));
    }
    pickDay('2000-01-01');
    time.value = `12:${String(firings % 60).padStart(2, '0')}`;
    time.dispatchEvent(new Event('input'));
    save.click();
    await flush();
  };

  await t.test('opens with the switch off, no invalid state and no message', () => {
    for (const permission of ['default', 'granted', 'denied']) {
      Notification.permission = permission;
      open('open');
      try {
        assert.equal(on.checked, false);
        assert.equal(byId('picker-detail').hidden, true);
        assert.equal(date.value, '');
        assert.equal(time.value, '');
        assert.equal(time.getAttribute('aria-invalid'), null);
        assert.equal(time.getAttribute('aria-describedby'), null);
        assert.equal(message.getAttribute('role'), null);
        assert.equal(save.getAttribute('aria-disabled'), 'false', 'no reminder is a valid choice');
        assert.equal(visibleMessage(), null, permission);
        if (permission === 'denied') {
          edit(future);
          assert.equal(visibleMessage(), notificationsBlocked);
        }
      } finally {
        cancel();
      }
    }
  });

  await t.test('turning the switch on starts at 9:00 AM on a day that has not passed, with the calendar open', () => {
    Notification.permission = 'granted';
    open('open');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    assert.equal(byId('picker-detail').hidden, false);
    assert.equal(byId('calendar').hidden, false);
    assert.equal(byId('reminder-date-button').getAttribute('aria-expanded'), 'true');
    assert.equal(time.value, '09:00');
    assert.match(date.value, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Date.parse(`${date.value}T09:00:00`) > Date.now(), 'the default is still ahead');
    assert.ok(['Today', 'Tomorrow'].includes(byId('reminder-date-value').textContent));
    assert.equal(visibleMessage(), null);
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    // Off again: no reminder, and the calendar closes.
    on.checked = false;
    on.dispatchEvent(new Event('change'));
    assert.equal(byId('picker-detail').hidden, true);
    assert.equal(byId('calendar').hidden, true);
    cancel();
  });

  await t.test('a reminder without a time shows an alert until it parses', () => {
    Notification.permission = 'default';
    open('open');
    edit(future);
    assert.equal(visibleMessage(), null);
    clearTime();
    assert.equal(visibleMessage(), invalidDate);
    assert.equal(message.getAttribute('role'), 'alert');
    assert.equal(time.getAttribute('aria-invalid'), 'true');
    assert.equal(time.getAttribute('aria-describedby'), 'reminder-message');
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    edit(future);
    assert.equal(visibleMessage(), null);
    assert.equal(message.getAttribute('role'), null);
    assert.equal(time.getAttribute('aria-invalid'), null);
    assert.equal(time.getAttribute('aria-describedby'), null);
    assert.equal(save.getAttribute('aria-disabled'), 'false');
    cancel();
  });

  await t.test('shows one message in priority order as the date changes', () => {
    Notification.permission = 'default';
    open('done');
    try {
      assert.equal(visibleMessage(), null);
      edit(future);
      assert.equal(visibleMessage(), doneTask);
      edit(past);
      assert.equal(visibleMessage(), pastTime);
      assert.equal(save.getAttribute('aria-disabled'), 'false');
      clearTime();
      assert.equal(visibleMessage(), invalidDate);
    } finally {
      cancel();
    }
  });

  await t.test('pressing aria-disabled Save reveals the error and focuses the empty time', () => {
    Notification.permission = 'default';
    open('open');
    on.checked = true;
    on.dispatchEvent(new Event('change'));
    time.value = ''; // emptied without an input event: nothing shown yet
    save.focus();
    assert.equal(document.activeElement, save);
    save.click();
    assert.equal(visibleMessage(), invalidDate);
    assert.equal(document.activeElement, time);
    assert.equal(save.getAttribute('aria-disabled'), 'true');
    assert.equal(byId('reminder-layer').hidden, false);
    cancel();
    open('open');
    assert.equal(visibleMessage(), null);
    assert.equal(time.getAttribute('aria-invalid'), null);
    cancel();
  });

  await t.test('an overdue stamp is one chip reading "Overdue · {due}" with a sensible name', () => {
    const chip = row('late').querySelector('.stamp');
    assert.match(chip.className, /\bis-overdue\b/);
    // Another year: "{short date with year}, {time}", in the runtime's locale, as the app formats it.
    const format = (options) => new Intl.DateTimeFormat(undefined, options).format(new Date(lateDue));
    const when = `${format({ month: 'short', day: 'numeric', year: 'numeric' })}, ${format({ hour: 'numeric', minute: '2-digit' })}`;
    assert.equal(chip.querySelector('.reminder-when').textContent, `Overdue · ${when}`);
    assert.equal(row('late').querySelector('.todo-open').getAttribute('aria-label'), `Late task. Overdue, was due ${when}. Edit task`);
  });

  await t.test('saving the same already-fired past time re-arms it, so it fires again', async () => {
    Notification.permission = 'granted';
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    // Let the pulse end: the reminder stays alerted (notified), overdue and quiet.
    list.dispatchEvent(dispatch(row('late'), 'animationend', { animationName: 'reminder-pulse' }));
    await settle();
    assert.equal(isFired('late'), false);
    const stored = server.rows.find((item) => item.id === ids.late);
    assert.equal(stored.notified, stored.due, 'the server has it as alerted');
    const patches = () => server.requests.filter((request) => request.method === 'PATCH' && /setReminder/.test(String(request.body ?? ''))).length;
    const before = patches();
    open('late'); // nothing edited: the same time
    save.click();
    await flush();
    assert.equal(isFired('late'), true, 'saved again at the same time, it alerts again');
    assert.equal(server.rows.find((item) => item.id === ids.late).due, stored.due);
    assert.equal(patches(), before + 1, 'one setReminder re-arm was sent');
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
    list.dispatchEvent(dispatch(row('late'), 'click'));
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

  await t.test('the pulse ending updates the row in place and keeps focus in the sheet\'s title field', async () => {
    await fireAgain('late');
    open('open');
    const field = byId('edit-text');
    const lateRow = row('late');
    assert.equal(document.activeElement, field);
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(lateRow, 'animationend', { animationName: 'reminder-pulse' }));
    await settle();
    assert.equal(row('late'), lateRow, 'the row was not re-rendered');
    assert.equal(lateRow.style.animationDelay, '');
    assert.equal(isFired('late'), false);
    assert.equal(document.activeElement, field);
    cancel();
  });

  await t.test('Esc in the task sheet clears the pulses and still closes the sheet', async () => {
    await fireAgain('late');
    open('open');
    assert.equal(byId('reminder-layer').hidden, false);
    const escape = dispatch(time, 'keydown', { key: 'Escape', preventDefault() {} });
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
    assert.match(keyframes, /0%,\s*100% \{\s*background-color: var\(--over-bg\);/);
    assert.match(keyframes, /50% \{\s*background-color: var\(--over-peak\);/);
  });

  // Saves a future time; the next test saves a past one again, so no timer keeps node:test alive.
  await t.test('editing the todo clears a fired row', async () => {
    await fireAgain('late');
    assert.equal(isFired('late'), true);
    row('late').querySelector('.todo-open').click();
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

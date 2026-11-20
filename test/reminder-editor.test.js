import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const permissionInfo = 'When you save, your browser will ask to allow notifications. If you say no, due tasks are still highlighted on this page.';
const invalidDate = 'Enter a valid date and time.';
const pastTime = 'That time has passed. Saving will mark this task overdue and alert right away.';
const doneTask = "This task is done, so its reminder won't alert. Uncheck it to turn alerts back on.";
const notificationsBlocked = 'Notifications are blocked or unavailable. Due tasks will be highlighted on this page.';
const future = '2099-01-01T12:00';
const past = '2000-01-01T12:00';
const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Supply the DOM operations used by the editor so its event handlers can run in node:test.
class Element extends EventTarget {
  attributes = new Map();
  children = [];
  dataset = {};
  className = '';
  classList = {
    add: (name) => this.classList.toggle(name, true),
    contains: (name) => this.className.split(/\s+/).includes(name),
    toggle: (name, enabled) => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) classes.add(name);
      else classes.delete(name);
      this.className = [...classes].join(' ');
    },
  };
  style = {};
  value = '';
  hidden = false;

  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  focus() { document.activeElement = this; }
  cloneNode() { return new Element(); }

  append(...children) {
    for (const child of children) {
      if (child instanceof Element) {
        this.children.push(child);
        child.parent = this;
      }
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  matches(selector) {
    if (selector === 'button') return this.tagName === 'button';
    if (selector === '[data-focus-key]') return this.dataset.focusKey !== undefined;
    return selector.split(', ').some((part) => this.className.split(' ').includes(part.slice(1)));
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }

  click() {
    if (this.disabled) return;
    this.focus();
    const event = new Event('click');
    Object.defineProperty(event, 'target', { value: this });
    for (let element = this; element; element = element.parent) element.dispatchEvent(event);
  }
}

test('reminder editor', async (t) => {
  const elements = new Map(Array.from(markup.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g), ([html, tag, id]) => {
    const element = new Element();
    element.tagName = tag;
    element.hidden = /\shidden\b/.test(html);
    if (tag === 'template') element.content = { firstElementChild: new Element() };
    return [id, element];
  }));
  const byId = (id) => elements.get(id);
  const app = new Element();
  const list = byId('todo-list');
  app.append(list, byId('filter-bar'));
  const queries = new Map();
  const matchMedia = (query) => {
    if (!queries.has(query)) {
      queries.set(query, Object.assign(new EventTarget(), { matches: !query.includes('reduced-motion') }));
    }
    return queries.get(query);
  };
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const tasks = [
    { id: 'open', text: 'Open task', completed: false, createdAt: 1 },
    { id: 'done', text: 'Done task', completed: true, createdAt: 2 },
    // Overdue and not alerted yet: it fires when the app starts.
    { id: 'late', text: 'Late task', completed: false, createdAt: 3, due: Date.parse('2001-01-01T09:00:00'), repeat: 'none', notified: null },
  ];
  const session = new Map();
  const globals = {
    document: Object.assign(new EventTarget(), {
      querySelector: () => app,
      getElementById: byId,
      createElement: (tagName) => Object.assign(new Element(), { tagName }),
    }),
    window: Object.assign(new EventTarget(), { matchMedia }),
    localStorage: { getItem: () => JSON.stringify(tasks), setItem: () => {} },
    sessionStorage: {
      getItem: (name) => session.get(name) ?? null,
      setItem: (name, value) => session.set(name, String(value)),
    },
    Notification: { permission: 'default' },
  };
  const previous = Object.getOwnPropertyDescriptors(globalThis);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const name of Object.keys(globals)) {
      if (previous[name]) Object.defineProperty(globalThis, name, previous[name]);
      else delete globalThis[name];
    }
  });
  await import('../src/app.js');

  const date = byId('reminder-when');
  const save = byId('reminder-save');
  const message = byId('reminder-message');
  const messageText = byId('reminder-message-text');
  const open = (id) => list.children.find((row) => row.dataset.id === id).querySelector('.reminder-add').click();
  const cancel = () => byId('reminder-cancel').click();
  const edit = (value) => {
    date.value = value;
    date.dispatchEvent(new Event('input'));
  };
  const visibleMessage = () => message.hidden ? null : messageText.textContent;
  const row = (id) => list.children.find((item) => item.dataset.id === id);
  const isFired = (id) => row(id).className.split(' ').includes('is-fired');
  const settle = () => new Promise((resolve) => setTimeout(resolve)); // renderSoon is deferred
  const dispatch = (target, type, props = {}) => {
    const event = Object.assign(new Event(type), props);
    Object.defineProperty(event, 'target', { value: target });
    return event;
  };
  // Saving a past time re-arms the alert, so the todo fires again: a fresh highlight.
  const fireAgain = (id) => {
    row(id).querySelector('.reminder-chip').click();
    edit(past);
    save.click();
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
    assert.match(chip.querySelector('.reminder-when').textContent, /^Overdue · Jan 1, 2001, 9:00\sAM$/);
    assert.match(chip.getAttribute('aria-label'), /^Overdue, was due Jan 1, 2001, 9:00\sAM\. Edit reminder for “Late task”$/);
  });

  await t.test('a fired row has no "Got it" button', () => {
    Notification.permission = 'granted';
    fireAgain('late');
    assert.equal(isFired('late'), true);
    assert.equal(row('late').querySelector('.reminder-got-it'), null);
  });

  await t.test('a tap or click anywhere in a fired row clears it', async () => {
    fireAgain('late');
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late').querySelector('.todo-text'), 'click'));
    await settle();
    assert.equal(isFired('late'), false);
    assert.match(row('late').className, /\bis-overdue\b/); // still overdue, just settled
  });

  await t.test('focus moving into a fired row clears it', async () => {
    fireAgain('late');
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late').querySelector('.todo-checkbox'), 'focusin'));
    await settle();
    assert.equal(isFired('late'), false);
  });

  await t.test('Esc clears a fired row', async () => {
    fireAgain('late');
    assert.equal(isFired('late'), true);
    document.dispatchEvent(dispatch(document, 'keydown', { key: 'Escape' }));
    await settle();
    assert.equal(isFired('late'), false);
  });

  await t.test('the end of the pulses clears a fired row; other animations do not', async () => {
    fireAgain('late');
    list.dispatchEvent(dispatch(row('late'), 'animationend', { animationName: 'something-else' }));
    await settle();
    assert.equal(isFired('late'), true);
    list.dispatchEvent(dispatch(row('late'), 'animationend', { animationName: 'reminder-pulse' }));
    await settle();
    assert.equal(isFired('late'), false);
  });

  // Saves a future time; the next test saves a past one again, so no timer keeps node:test alive.
  await t.test('editing the todo clears a fired row', async () => {
    fireAgain('late');
    assert.equal(isFired('late'), true);
    row('late').querySelector('.reminder-chip').click();
    edit(future);
    save.click();
    assert.equal(isFired('late'), false);
  });

  await t.test('with reduced motion a fired row is just overdue (no pulse to wait for)', () => {
    reducedMotion.matches = true;
    try {
      fireAgain('late');
      assert.equal(isFired('late'), false);
      assert.match(row('late').className, /\bis-overdue\b/);
    } finally {
      reducedMotion.matches = false;
    }
  });

  await t.test('the blocked note, once dismissed, stays hidden for the session on later Saves', () => {
    const banner = byId('banner');
    Notification.permission = 'denied';
    try {
      fireAgain('late');
      assert.equal(banner.hidden, false);
      assert.match(banner.className, /\bis-note\b/);
      assert.equal(byId('banner-text').textContent, notificationsBlocked);
      assert.equal(byId('banner-dismiss').hidden, false);

      byId('banner-dismiss').click();
      assert.equal(banner.hidden, true);
      assert.equal(session.get('task-manager.blocked-note-dismissed'), '1');

      fireAgain('late');
      assert.equal(banner.hidden, true);
      fireAgain('late');
      assert.equal(banner.hidden, true);
    } finally {
      Notification.permission = 'default';
    }
  });
});

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
  const matchMedia = () => Object.assign(new EventTarget(), { matches: true });
  const tasks = [
    { id: 'open', text: 'Open task', completed: false, createdAt: 1 },
    { id: 'done', text: 'Done task', completed: true, createdAt: 2 },
  ];
  const globals = {
    document: Object.assign(new EventTarget(), {
      querySelector: () => app,
      getElementById: byId,
      createElement: (tagName) => Object.assign(new Element(), { tagName }),
    }),
    window: Object.assign(new EventTarget(), { matchMedia }),
    localStorage: { getItem: () => JSON.stringify(tasks) },
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
});

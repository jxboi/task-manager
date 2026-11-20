// A minimal DOM for running src/app.js in node:test: one element per id in index.html, and the
// globals the app reads. Shared by the browser-module tests.
import { readFileSync } from 'node:fs';

const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Supply the DOM operations used by the editor so its event handlers can run in node:test.
export class Element extends EventTarget {
  attributes = new Map();
  children = [];
  dataset = {};
  className = '';
  classList = {
    add: (name) => this.classList.toggle(name, true),
    remove: (name) => this.classList.toggle(name, false),
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

export function installDom(t, { fetch }) {
  const elements = new Map(Array.from(markup.matchAll(/<(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g), ([html, tag, id]) => {
    const element = new Element();
    element.tagName = tag;
    element.id = id;
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
  const session = new Map();
  const globals = {
    document: Object.assign(new EventTarget(), {
      querySelector: () => app,
      getElementById: byId,
      createElement: (tagName) => Object.assign(new Element(), { tagName }),
    }),
    window: Object.assign(new EventTarget(), { matchMedia }),
    fetch,
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
  return { byId, app, list, matchMedia, session };
}

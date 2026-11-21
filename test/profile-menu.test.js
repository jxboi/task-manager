// The profile button in the header and its menu (the account's name and Sign out), in src/auth.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Element, installDom } from './dom.js';
import { settle } from './fake-api.js';
import { markupAttributes } from './markup.js';

const ana = { user: { name: 'Ana', email: 'ana@example.test' }, csrfToken: 'token-a' };

test('profile menu', async (t) => {
  let signOutStatus = 500;
  const signOuts = [];
  const fetch = async (path, init) => {
    if (path === '/api/auth/sign-out') {
      signOuts.push(init);
      return new Response(null, { status: signOutStatus });
    }
    assert.equal(new URL(path, 'http://localhost').pathname, '/api/session');
    return new Response(JSON.stringify(ana), { status: 200 });
  };
  const { byId, matchMedia } = installDom(t, { fetch });
  globalThis.matchMedia = matchMedia;
  t.after(() => delete globalThis.matchMedia);
  const radios = ['signin', 'signup'].map((value) => Object.assign(new Element(), { tagName: 'input', value, checked: false }));
  byId('auth-view').querySelectorAll = () => radios;
  byId('auth-submit').querySelector = () => new Element();
  byId('auth-loading').firstElementChild = new Element();
  document.visibilityState = 'visible';
  globalThis.BroadcastChannel = class extends EventTarget {
    postMessage() {}
  };
  t.after(() => delete globalThis.BroadcastChannel);

  // Nest the header the way index.html does, so "inside the menu" can be told apart.
  const account = byId('account');
  const button = byId('profile-button');
  const menu = byId('profile-menu');
  const name = byId('account-name');
  const signOut = byId('account-sign-out');
  account.append(button, menu);
  menu.append(name, signOut);

  const dispatch = (target, type, props = {}) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
    target.dispatchEvent(event);
    return event;
  };
  const isOpen = () => {
    // Until the app first sets it, aria-expanded is index.html's "false".
    assert.equal(button.getAttribute('aria-expanded') ?? markupAttributes('profile-button')['aria-expanded'], String(!menu.hidden));
    return !menu.hidden;
  };

  await import('../src/auth.js');
  await settle();

  await t.test('signed in: the profile button shows; the name and Sign out wait in its menu', () => {
    assert.equal(byId('task-view').hidden, false);
    assert.equal(account.hidden, false);
    assert.equal(byId('add-toggle').hidden, false);
    const markup = { button: markupAttributes('profile-button'), menu: markupAttributes('profile-menu') };
    assert.equal(markup.button['aria-haspopup'], 'menu');
    assert.equal(markup.button['aria-controls'], 'profile-menu');
    assert.equal(markup.button['aria-expanded'], 'false');
    assert.equal(markup.menu.role, 'menu');
    assert.equal(markup.menu['aria-labelledby'], 'account-name');
    assert.equal('hidden' in markup.menu, true);
    assert.equal(markupAttributes('account-sign-out').role, 'menuitem');
    assert.equal(button.getAttribute('aria-label'), 'Account, Ana');
    assert.equal(name.textContent, 'Ana');
    assert.equal(isOpen(), false);
  });

  await t.test('tapping it opens the menu and focuses Sign out; tapping again closes it', () => {
    button.click();
    assert.equal(isOpen(), true);
    assert.equal(document.activeElement, signOut);
    button.click();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
  });

  await t.test('Escape closes it and returns focus to the button', () => {
    button.click();
    const event = dispatch(document, 'keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    // Closed, Escape is left alone for others.
    assert.equal(dispatch(document, 'keydown', { key: 'Escape' }).defaultPrevented, false);
  });

  await t.test('keyboard: Down on the button opens it; arrows keep focus on the item', () => {
    dispatch(button, 'keydown', { key: 'ArrowDown' });
    assert.equal(isOpen(), true);
    assert.equal(document.activeElement, signOut);
    dispatch(menu, 'keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, signOut);
    // Tab out of the menu closes it.
    dispatch(account, 'focusout', { relatedTarget: byId('app-title') });
    assert.equal(isOpen(), false);
  });

  await t.test('a tap outside closes it; a tap inside does not', () => {
    button.click();
    dispatch(document, 'pointerdown', { target: name });
    assert.equal(isOpen(), true);
    dispatch(document, 'pointerdown', { target: byId('todo-list') });
    assert.equal(isOpen(), false);
  });

  await t.test('a failed sign-out keeps the session, closes the menu and says so', async () => {
    button.click();
    signOut.click();
    await settle();
    assert.equal(signOuts.length, 1);
    assert.equal(byId('task-view').hidden, false);
    assert.equal(byId('auth-signout-note').hidden, false);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    assert.equal(signOut.textContent, 'Sign out');
    byId('auth-dismiss-note').click();
    assert.equal(byId('auth-signout-note').hidden, true);
    assert.equal(document.activeElement, button);
  });

  await t.test('Sign out from the menu signs out and hides the header controls', async () => {
    signOutStatus = 204;
    button.click();
    signOut.click();
    await settle();
    assert.equal(signOuts.length, 2);
    assert.equal(byId('auth-view').hidden, false);
    assert.equal(byId('task-view').hidden, true);
    assert.equal(account.hidden, true);
    assert.equal(byId('add-toggle').hidden, true);
    assert.equal(isOpen(), false);
    assert.equal(name.textContent, '');
    assert.equal(button.getAttribute('aria-label'), 'Account');
  });
});

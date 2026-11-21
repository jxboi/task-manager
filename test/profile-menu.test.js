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

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  await t.test('Escape in the menu closes it and returns focus to the button', () => {
    button.click();
    const event = dispatch(menu, 'keydown', { key: 'Escape' });
    assert.equal(event.defaultPrevented, true);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    // Closed, Escape is left alone for others.
    assert.equal(dispatch(document, 'keydown', { key: 'Escape' }).defaultPrevented, false);
  });

  await t.test('another tab switching accounts closes the open menu', async () => {
    button.click();
    assert.equal(document.activeElement, signOut);
    ana.user = { name: 'Bo', email: 'bo@example.test' };
    ana.csrfToken = 'token-b';
    dispatch(globalThis.window ?? document, 'focus');
    await settle();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    assert.equal(name.textContent, 'Bo');
    ana.user = { name: 'Ana', email: 'ana@example.test' };
    ana.csrfToken = 'token-a';
    dispatch(globalThis.window ?? document, 'focus');
    await settle();
  });

  await t.test('an account switch leaves focus on a control the user moved to', async () => {
    button.click();
    const other = byId('new-todo');
    other.focus(); // no focusout yet: the menu is still open when the switch lands
    assert.equal(isOpen(), true);
    ana.user = { name: 'Bo', email: 'bo@example.test' };
    ana.csrfToken = 'token-b';
    dispatch(globalThis.window ?? document, 'focus');
    await settle();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, other);
    ana.user = { name: 'Ana', email: 'ana@example.test' };
    ana.csrfToken = 'token-a';
    dispatch(globalThis.window ?? document, 'focus');
    await settle();
  });

  await t.test('keyboard: Down on the button opens it; arrows keep focus on the item', () => {
    dispatch(button, 'keydown', { key: 'ArrowDown' });
    assert.equal(isOpen(), true);
    assert.equal(document.activeElement, signOut);
    dispatch(menu, 'keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, signOut);
    dispatch(menu, 'focusout', { relatedTarget: byId('app-title') });
    assert.equal(isOpen(), false);
  });

  // Models the browser's Tab: focus moves (natively), then the menu gets focusout.
  const tabTo = (target, shiftKey = false) => {
    const key = dispatch(menu, 'keydown', { key: 'Tab', shiftKey });
    assert.equal(key.defaultPrevented, false, 'native focus navigation is kept');
    if (target) target.focus();
    dispatch(menu, 'focusout', { relatedTarget: target });
  };

  await t.test('Tab and Shift+Tab out of the menu close it, including back onto the button', () => {
    for (const [target, shiftKey] of [[byId('todo-list'), false], [button, true]]) {
      dispatch(button, 'keydown', { key: 'ArrowDown' });
      assert.equal(document.activeElement, signOut);
      tabTo(target, shiftKey);
      assert.equal(isOpen(), false, shiftKey ? 'Shift+Tab onto the button' : 'Tab');
      assert.equal(document.activeElement, target, 'focus stays where Tab put it');
    }
    // Focus moving within the menu keeps it open.
    button.click();
    dispatch(menu, 'focusout', { relatedTarget: signOut });
    assert.equal(isOpen(), true);
    button.click();
  });

  await t.test('Tab out to the browser chrome (no relatedTarget) closes it without moving focus', () => {
    dispatch(button, 'keydown', { key: 'ArrowDown' });
    tabTo(null);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, signOut);
  });

  await t.test('pressing the name or the menu keeps focus on Sign out, so Tab and Escape still work', () => {
    button.click();
    assert.equal(dispatch(menu, 'mousedown', { target: name }).defaultPrevented, true);
    assert.equal(dispatch(menu, 'mousedown', { target: menu }).defaultPrevented, true);
    assert.equal(dispatch(menu, 'mousedown', { target: signOut }).defaultPrevented, false);
    dispatch(document, 'pointerdown', { target: name }); // inside the menu: stays open
    assert.equal(isOpen(), true);
    assert.equal(document.activeElement, signOut);
    tabTo(byId('todo-list'));
    assert.equal(isOpen(), false);
  });

  await t.test('pressing the button while open closes it, even when the click comes in a later task', async () => {
    button.click();
    dispatch(button, 'pointerdown');
    assert.equal(dispatch(button, 'mousedown').defaultPrevented, true, 'focus stays in the menu');
    assert.equal(isOpen(), true);
    await tick(); // a touch's click can arrive later
    await tick();
    button.click();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    // Closed, the press is ordinary and the click opens it.
    assert.equal(dispatch(button, 'mousedown').defaultPrevented, false);
    button.click();
    assert.equal(isOpen(), true);
    button.click();
  });

  await t.test('a press outside closes it without moving focus, then or after the tap', async () => {
    button.click();
    dispatch(document, 'pointerdown', { target: byId('todo-list') });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, signOut, 'the press itself moves no focus');
    document.activeElement = null; // the hidden item dropped focus; blank space takes none
    await settle();
    assert.equal(document.activeElement, null, 'no later focus jump to the header');
    button.click();
    const other = byId('new-todo');
    dispatch(document, 'pointerdown', { target: other });
    other.focus();
    await settle();
    assert.equal(document.activeElement, other);
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

  await t.test('a late sign-out failure does not steal focus once the menu is dismissed', async () => {
    signOutStatus = 500;
    button.click();
    signOut.click();
    byId('new-todo').focus();
    dispatch(menu, 'focusout', { relatedTarget: byId('new-todo') });
    await settle();
    assert.equal(byId('auth-signout-note').hidden, false);
    assert.equal(document.activeElement, byId('new-todo'));
    byId('auth-dismiss-note').click();
  });

  await t.test('a sign-out failure leaves focus on a control the user moved to while the menu was open', async () => {
    signOutStatus = 500;
    button.click();
    signOut.click();
    const other = byId('new-todo');
    other.focus(); // no focusin yet: the menu is still open when the failure lands
    await settle();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, other);
    byId('auth-dismiss-note').click();
  });

  await t.test('a sign-out failure with the menu already closed and focus on the body leaves focus alone', async () => {
    signOutStatus = 500;
    button.click();
    signOut.click();
    document.activeElement = document.body ?? null;
    menu.hidden = true; // dismissed (e.g. by Tab out) before the failure lands
    button.setAttribute('aria-expanded', 'false');
    await settle();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, document.body ?? null);
    byId('auth-dismiss-note').click();
  });

  await t.test('Sign out from the menu signs out and hides the header controls', async () => {
    signOutStatus = 204;
    const before = signOuts.length;
    button.click();
    signOut.click();
    await settle();
    assert.equal(signOuts.length, before + 1);
    assert.equal(byId('auth-view').hidden, false);
    assert.equal(byId('task-view').hidden, true);
    assert.equal(account.hidden, true);
    assert.equal(byId('add-toggle').hidden, true);
    assert.equal(isOpen(), false);
    assert.equal(name.textContent, '');
    assert.equal(button.getAttribute('aria-label'), 'Account');
  });
});

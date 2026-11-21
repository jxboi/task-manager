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

  await t.test('Escape returns focus to the button even when focus fell to the body', () => {
    button.click();
    document.activeElement = document.body ?? null; // clicking the name label blurred Sign out
    if (document.activeElement === button || menu.contains(document.activeElement)) document.activeElement = null;
    assert.equal(isOpen(), true);
    dispatch(document, 'keydown', { key: 'Escape' });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
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

  await t.test('keyboard: Down on the button opens it; arrows keep focus on the item', () => {
    dispatch(button, 'keydown', { key: 'ArrowDown' });
    assert.equal(isOpen(), true);
    assert.equal(document.activeElement, signOut);
    dispatch(menu, 'keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement, signOut);
    // Tab out of the menu closes it.
    dispatch(menu, 'focusout', { relatedTarget: byId('app-title') });
    assert.equal(isOpen(), false);
  });

  await t.test('Tab and Shift+Tab out of the menu both close it, including back onto the button', () => {
    button.click();
    dispatch(menu, 'focusout', { relatedTarget: byId('app-title') });
    assert.equal(isOpen(), false);
    button.click();
    button.focus();
    dispatch(menu, 'focusout', { relatedTarget: button });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    // Focus moving between items inside the menu keeps it open.
    button.click();
    dispatch(menu, 'focusout', { relatedTarget: signOut });
    assert.equal(isOpen(), true);
    button.click();
  });

  await t.test('focusin outside the menu closes it, in both Tab directions, without moving focus', () => {
    button.click();
    signOut.focus();
    button.focus();
    dispatch(document, 'focusin', { target: button });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    button.click();
    const next = byId('todo-list');
    next.focus();
    dispatch(document, 'focusin', { target: next });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, next);
  });

  await t.test('a blur with no destination (the name label) still closes on the next focusin', () => {
    button.click();
    dispatch(menu, 'focusout', { relatedTarget: null });
    assert.equal(isOpen(), true);
    dispatch(document, 'focusin', { target: signOut });
    assert.equal(isOpen(), true);
    const task = byId('new-todo');
    task.focus();
    dispatch(document, 'focusin', { target: task });
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, task);
  });

  // Models the browser: moving focus fires focusout on the menu (if it had focus) and focusin.
  const focusTo = (target) => {
    const previous = document.activeElement;
    target.focus();
    if (previous && menu.contains(previous) && !menu.contains(target)) dispatch(menu, 'focusout', { relatedTarget: target });
    dispatch(document, 'focusin', { target });
  };
  const keyboardClick = () => dispatch(button, 'click', { detail: 0 });
  const pointerClick = () => dispatch(button, 'click', { detail: 1 });
  const openMenuFromKeyboard = () => {
    focusTo(button);
    keyboardClick();
  };

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  await t.test('Tab and Shift+Tab on Sign out close it after the browser moves focus, which stays put', async () => {
    for (const shiftKey of [false, true]) {
      openMenuFromKeyboard();
      assert.equal(document.activeElement, signOut);
      const key = dispatch(menu, 'keydown', { key: 'Tab', shiftKey });
      assert.equal(key.defaultPrevented, false);
      // Shift+Tab lands on the profile button, inside the account wrapper but outside the menu.
      const target = shiftKey ? button : byId('todo-list');
      focusTo(target);
      await tick();
      assert.equal(isOpen(), false);
      assert.equal(document.activeElement, target);
    }
  });

  await t.test('Tab out to the browser chrome (no relatedTarget, no focusin) still closes it', async () => {
    openMenuFromKeyboard();
    const key = dispatch(menu, 'keydown', { key: 'Tab' });
    assert.equal(key.defaultPrevented, false);
    dispatch(menu, 'focusout', { relatedTarget: null });
    assert.equal(isOpen(), true);
    await tick();
    assert.equal(isOpen(), false);
    // Focus is not pulled back to the profile button.
    assert.equal(document.activeElement, signOut);
  });

  await t.test('Shift+Tab with no focus events (WebKit-style) still closes it, without moving focus', async () => {
    openMenuFromKeyboard();
    dispatch(menu, 'keydown', { key: 'Tab', shiftKey: true });
    await tick();
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, signOut);
  });

  await t.test('a cancelled press does not swallow the next activation', () => {
    openMenuFromKeyboard();
    assert.equal(isOpen(), true);
    dispatch(button, 'pointerdown'); // remembers "open"
    focusTo(button); // the press moves focus, closing the menu
    assert.equal(isOpen(), false);
    dispatch(button, 'pointercancel');
    keyboardClick();
    assert.equal(isOpen(), true, 'keyboard click opens the closed menu');
    keyboardClick();
    assert.equal(isOpen(), false);
    // Same again, then a pointer click that has no press of its own: stale state would close.
    openMenuFromKeyboard();
    dispatch(button, 'pointerdown');
    focusTo(button);
    dispatch(button, 'pointercancel');
    pointerClick();
    assert.equal(isOpen(), true, 'a later pointer click does not read the cancelled press');
    keyboardClick();
  });

  await t.test('a dragged-off press does not swallow the next activation', async () => {
    openMenuFromKeyboard();
    dispatch(button, 'pointerdown');
    focusTo(button);
    assert.equal(isOpen(), false);
    dispatch(document, 'pointerup'); // released elsewhere: no click on the button
    await new Promise((resolve) => setTimeout(resolve, 5));
    keyboardClick();
    assert.equal(isOpen(), true);
    keyboardClick();
    openMenuFromKeyboard();
    dispatch(button, 'pointerdown');
    focusTo(button);
    dispatch(document, 'pointerup');
    await new Promise((resolve) => setTimeout(resolve, 5));
    pointerClick();
    assert.equal(isOpen(), true, 'a later pointer click does not read the dragged-off press');
    keyboardClick();
  });

  await t.test('a press on the button while open closes it instead of reopening', () => {
    button.click();
    dispatch(button, 'pointerdown');
    button.focus();
    dispatch(menu, 'focusout', { relatedTarget: button });
    button.click();
    assert.equal(isOpen(), false);
  });

  await t.test('a click on blank space restores focus to the button; on a control it leaves focus', async () => {
    button.click();
    dispatch(document, 'pointerdown', { target: byId('todo-list') });
    document.activeElement = null; // the hidden item dropped focus
    await settle(1);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, button);
    button.click();
    const other = byId('new-todo');
    dispatch(document, 'pointerdown', { target: other });
    other.focus();
    await settle(1);
    assert.equal(document.activeElement, other);
  });

  await t.test('after a click on the name drops focus to the body, a tap on blank space restores it', async () => {
    const body = document.body ?? null;
    button.click();
    assert.equal(document.activeElement, signOut);
    dispatch(document, 'pointerdown', { target: name }); // inside the menu: stays open
    document.activeElement = body; // the name label took focus from Sign out, to no one
    dispatch(menu, 'focusout', { relatedTarget: null });
    assert.equal(isOpen(), true);
    dispatch(document, 'pointerdown', { target: byId('todo-list') }); // blank space
    assert.equal(isOpen(), false);
    await settle(1);
    assert.equal(document.activeElement, button);
    // The same, but the tap lands on a control, which keeps the focus it gets.
    button.click();
    document.activeElement = body;
    const other = byId('new-todo');
    dispatch(document, 'pointerdown', { target: other });
    other.focus();
    await settle(1);
    assert.equal(isOpen(), false);
    assert.equal(document.activeElement, other);
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

  await t.test('Sign out from the menu signs out and hides the header controls', async () => {
    signOutStatus = 204;
    button.click();
    signOut.click();
    await settle();
    assert.equal(signOuts.length, 3);
    assert.equal(byId('auth-view').hidden, false);
    assert.equal(byId('task-view').hidden, true);
    assert.equal(account.hidden, true);
    assert.equal(byId('add-toggle').hidden, true);
    assert.equal(isOpen(), false);
    assert.equal(name.textContent, '');
    assert.equal(button.getAttribute('aria-label'), 'Account');
  });
});

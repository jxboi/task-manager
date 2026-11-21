import { authRequest, readSession, setToken } from './storage.js';

const byId = (id) => document.getElementById(id);
const title = byId('app-title');
const authView = byId('auth-view');
const taskView = byId('task-view');
const loading = byId('auth-loading');
const retry = byId('auth-retry');
const retryButton = byId('auth-retry-button');
const heading = byId('auth-heading');
const info = byId('auth-info');
const status = byId('auth-status');
const form = byId('auth-form');
const radios = Array.from(authView.querySelectorAll('input[type=radio]'));
const name = byId('auth-name');
const email = byId('auth-email');
const password = byId('auth-password');
const hint = byId('auth-password-hint');
const showPassword = byId('auth-show');
const submit = byId('auth-submit');
const submitText = byId('auth-submit-text');
const spinner = submit.querySelector('.auth-spinner');
const errorSlot = byId('auth-error');
const errorText = byId('auth-error-text');
const errorButton = byId('auth-error-action');
const alertIcon = byId('alert-icon');
const account = byId('account');
const profileButton = byId('profile-button');
const profileMenu = byId('profile-menu');
const accountName = byId('account-name');
const signOut = byId('account-sign-out');
const addToggle = byId('add-toggle');
const signOutNote = byId('auth-signout-note');
const touch = matchMedia('(hover: none)');
const inputs = [name, email, password];
const touched = new Set();
const networkMessage = "Can't reach the server. Check your connection and try again.";

let creating = false;
let busy = false;
let checking = false;
let currentSession = null;
let errorAction;

function announce(message) {
  status.textContent = message;
}

function passwordVisible(visible) {
  password.type = visible ? 'text' : 'password';
  showPassword.textContent = visible ? 'Hide' : 'Show';
  showPassword.setAttribute('aria-pressed', String(visible));
}

function setSummary(message = '', actionLabel, action) {
  errorSlot.classList.toggle('is-visible', Boolean(message));
  errorText.replaceChildren();
  if (message) errorText.append(alertIcon.content.cloneNode(true), message);
  errorButton.textContent = actionLabel ?? '';
  errorButton.hidden = !actionLabel;
  errorAction = action;
}

function fieldMessage(input) {
  const value = input.value;
  if (input === name) return value.trim() ? '' : 'Enter your name.';
  if (input === email) {
    const address = value.trim();
    if (!address) return 'Enter your email address.';
    return /^[^\s@]+@[^\s@]+$/.test(address) ? '' : 'Enter a valid email address.';
  }
  if (creating && value.length < 12) return 'Use at least 12 characters.';
  return value ? '' : 'Enter your password.';
}

function setFieldError(input, message = '') {
  const error = byId(`${input.id}-error`);
  error.replaceChildren();
  if (message) error.append(alertIcon.content.cloneNode(true), message);
  error.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  const ids = [input === password && creating ? hint.id : '', message ? error.id : ''].filter(Boolean);
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
}

function setMode(signup, { keepEmail = true, announceMode = false } = {}) {
  creating = signup;
  radios[0].checked = !signup;
  radios[1].checked = signup;
  byId('auth-name-field').hidden = !signup;
  name.disabled = !signup;
  // The rule is screen-reader only (no helper text on screen): the hint is referenced by the
  // password field's aria-describedby while creating an account.
  hint.hidden = !signup;
  if (signup) password.setAttribute('minlength', '12');
  else password.removeAttribute('minlength');
  password.autocomplete = signup ? 'new-password' : 'current-password';
  name.value = '';
  password.value = '';
  if (!keepEmail) email.value = '';
  passwordVisible(false);
  touched.clear();
  for (const input of inputs) setFieldError(input);
  setSummary();
  info.textContent = '';
  heading.textContent = signup ? 'Create account' : 'Sign in';
  submitText.textContent = heading.textContent;
  if (announceMode) announce(heading.textContent);
}

function setSubmitting(active) {
  busy = active;
  spinner.hidden = !active;
  submit.setAttribute('aria-disabled', String(active));
  submit.setAttribute('aria-busy', String(active));
  form.setAttribute('aria-busy', String(active));
  for (const input of inputs) input.readOnly = active;
  for (const radio of radios) radio.disabled = active;
  submitText.textContent = active ? (creating ? 'Creating account…' : 'Signing in…') : heading.textContent;
}

// Tells the task view which session it shows: a session object, or null when signed out.
// The task view resets whenever the session's CSRF token changes.
function announceSession(active) {
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active } }));
}

function setAccount(active) {
  // Another tab switched accounts: the open menu's Sign out would now act on the new account.
  const switched = currentSession && (currentSession.csrfToken !== active.csrfToken || currentSession.user.email !== active.user.email);
  if (switched && !profileMenu.hidden) {
    const owned = menuOwnsFocus();
    setMenuOpen(false);
    if (owned) profileButton.focus();
  }
  currentSession = active;
  setToken(active.csrfToken);
  const label = active.user.name || active.user.email;
  accountName.textContent = label;
  accountName.title = label;
  profileButton.setAttribute('aria-label', `Account, ${label}`);
  signOut.setAttribute('aria-label', `Sign out ${label}`);
}

function showSignedIn(active, focus = false) {
  setAccount(active);
  for (const element of [account, addToggle, taskView]) element.hidden = false;
  for (const element of [authView, loading, retry]) element.hidden = true;
  setMode(false, { keepEmail: false });
  announceSession(active);
  if (focus) (touch.matches ? title : addToggle).focus();
}

function showSignedOut({ focus = false, expired = false } = {}) {
  currentSession = null;
  setToken(null);
  announceSession(null);
  if (!byId('reminder-layer').hidden) byId('reminder-cancel').click();
  setMenuOpen(false);
  for (const element of [account, addToggle, taskView, loading, retry, signOutNote]) element.hidden = true;
  accountName.textContent = '';
  accountName.removeAttribute('title');
  profileButton.setAttribute('aria-label', 'Account');
  signOut.removeAttribute('aria-label');
  authView.hidden = false;
  setMode(false, { keepEmail: false });
  if (expired) info.textContent = 'Your session ended. Sign in again to continue.';
  if (focus) heading.focus();
}

function showRetry() {
  loading.hidden = true;
  authView.hidden = true;
  retry.hidden = false;
  retryButton.focus();
}

async function loadSession({ focus = false } = {}) {
  if (checking) return;
  checking = true;
  retry.hidden = true;
  loading.hidden = false;
  loading.firstElementChild.hidden = true;
  announce('Loading');
  const delay = setTimeout(() => { loading.firstElementChild.hidden = false; }, 1000);
  try {
    const active = await readSession();
    announce('');
    if (active.user) showSignedIn(active, focus);
    else showSignedOut({ focus });
  } catch {
    announce('');
    showRetry();
  } finally {
    clearTimeout(delay);
    checking = false;
  }
}

// Bumped on local auth changes and when another tab reports one. In-flight session reads may
// describe the previous session, so their results are discarded.
let invalidations = 0;
let following = false;

// Re-reads the session after another tab changed it (or a request was refused), until a read
// completes with no newer change behind it, then shows that session. This runs whatever the
// earlier reads returned: a sign-out read that arrives late can't strand the tab at sign-in
// when another account has signed in since.
async function followSession() {
  if (following) return;
  following = true;
  try {
    let active;
    let seen;
    do {
      seen = invalidations;
      try {
        active = await readSession();
      } catch {
        active = undefined;
      }
    } while (seen !== invalidations);
    if (busy) return; // this tab is signing in or out itself and shows the result
    if (active === undefined) {
      // Unknown session: show nothing of the old one, offer Try again.
      if (currentSession) {
        currentSession = null;
        setToken(null);
        announceSession(null);
        setMenuOpen(false);
        for (const element of [account, addToggle, taskView, signOutNote]) element.hidden = true;
      }
      showRetry();
    } else if (active.user) {
      showSignedIn(active);
    } else if (currentSession) {
      showSignedOut({ focus: true, expired: true });
    }
  } finally {
    following = false;
  }
}

async function refreshSession() {
  if (!currentSession || busy || checking || following || document.visibilityState !== 'visible') return;
  const previous = currentSession;
  const seen = invalidations;
  checking = true;
  try {
    const active = await readSession();
    if (busy || currentSession !== previous || seen !== invalidations || following) return;
    if (active.user) {
      // The task view reloads (same session) or resets for the account now signed in.
      setAccount(active);
      announceSession(active);
    } else {
      showSignedOut({ focus: true, expired: true });
    }
  } catch {
    // Keep the current view during temporary connectivity failures.
  } finally {
    checking = false;
  }
}

// Other tabs of this browser share the session cookie. When one signs in, up or out, the rest
// hide their lists at once (nothing of the old account stays on screen or answers late) and
// re-read the session.
const authChannel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('task-manager-auth') : null;

function broadcastAuthChange() {
  invalidations++;
  try {
    authChannel?.postMessage('session-changed');
  } catch {
    // The other tabs catch up when they next check the session.
  }
}

authChannel?.addEventListener('message', () => {
  invalidations++;
  // A tab already on the sign-in form stays there; one showing tasks (or still following an
  // earlier change) hides them and follows the session.
  if (!currentSession && !following) return;
  window.dispatchEvent(new CustomEvent('tasks:invalidate'));
  followSession();
});

function handleAuthError(response, code) {
  if (creating && ['USER_ALREADY_EXISTS', 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL'].includes(code)) {
    setSummary('An account with this email already exists.', 'Sign in instead', () => {
      setMode(false, { announceMode: true });
      password.focus();
    });
  } else if (response.status === 403) {
    setSummary('This request was blocked. Reload the page and try again.', 'Reload', () => location.reload());
  } else if (response.status === 429 || (!creating && response.status === 401)) {
    password.value = '';
    setSummary(response.status === 429
      ? 'Too many attempts. Wait a minute, then try again.'
      : 'Email or password is incorrect.');
    password.focus();
  } else if (response.status < 500) {
    password.value = '';
    setSummary("We couldn't use those details. Check them and try again.");
    (creating ? name : email).focus();
  } else {
    setSummary('Something went wrong on our side. Try again in a moment.');
    submit.focus();
  }
}

for (const radio of radios) {
  radio.addEventListener('change', () => setMode(radio.value === 'signup', { announceMode: true }));
}
for (const input of inputs) {
  input.addEventListener('input', () => {
    touched.add(input);
    if (input.hasAttribute('aria-invalid')) setFieldError(input, fieldMessage(input));
  });
  input.addEventListener('blur', (event) => {
    // Submit validates the fields itself. Adding a message here can move the button
    // between pointerdown and click.
    if (!busy && event.relatedTarget !== submit && touched.has(input)) {
      setFieldError(input, fieldMessage(input));
    }
  });
  input.addEventListener('focus', () => {
    if (touch.matches) input.scrollIntoView({ block: 'center' });
  });
}
showPassword.addEventListener('click', () => {
  if (!busy) passwordVisible(password.type === 'password');
});
errorButton.addEventListener('click', () => errorAction?.());
retryButton.addEventListener('click', () => loadSession({ focus: true }));
byId('auth-dismiss-note').addEventListener('click', () => {
  signOutNote.hidden = true;
  profileButton.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  setSummary();
  info.textContent = '';
  passwordVisible(false);

  let firstInvalid;
  for (const input of inputs) {
    if (input.disabled) continue;
    const message = fieldMessage(input);
    setFieldError(input, message);
    if (message) firstInvalid ??= input;
  }
  if (firstInvalid) {
    setSummary('Fix the highlighted fields and try again.');
    firstInvalid.focus();
    return;
  }

  const body = { email: email.value.trim(), password: password.value };
  if (creating) body.name = name.value.trim();
  setSubmitting(true);
  let response;
  let errorCode;
  try {
    response = await authRequest(creating ? 'sign-up/email' : 'sign-in/email', body);
    errorCode = response.code;
  } catch {
    setSummary(networkMessage);
    submit.focus();
  } finally {
    setSubmitting(false);
  }
  if (!response) return;
  if (!response.ok) {
    handleAuthError(response, errorCode);
    return;
  }
  password.value = '';
  authView.hidden = true;
  broadcastAuthChange();
  await loadSession({ focus: true });
});

signOut.addEventListener('click', async () => {
  if (busy || !currentSession) return;
  busy = true;
  signOutNote.hidden = true;
  signOut.textContent = 'Signing out…';
  signOut.setAttribute('aria-disabled', 'true');
  try {
    const response = await authRequest('sign-out', {}, { csrf: true });
    if (!response.ok && response.status !== 401) throw new Error('Sign out failed');
    showSignedOut({ focus: true });
    broadcastAuthChange();
    announce('Signed out.');
  } catch {
    // The note is in the task view; the menu closes so it isn't covered, and Sign out is one tap
    // away again under the profile button.
    // Focus goes back to the button only if the menu still owns it (or it fell to the body from
    // the menu); the user may have moved on.
    const owned = !profileMenu.hidden && menuOwnsFocus();
    signOutNote.hidden = false;
    setMenuOpen(false);
    if (owned) profileButton.focus();
  } finally {
    signOut.textContent = 'Sign out';
    signOut.removeAttribute('aria-disabled');
    busy = false;
  }
});

// --- The profile menu: the account's name and Sign out, under the header's profile button ---

// Whether focus belongs to the open menu: in it, or on the body, where a tap on the name label
// (which blurs Sign out) leaves it. Focus on any other control is the user's.
function menuOwnsFocus() {
  const active = document.activeElement;
  return !active || active === document.body || profileMenu.contains(active);
}

function setMenuOpen(open) {
  profileMenu.hidden = !open;
  profileButton.setAttribute('aria-expanded', String(open));
}

// Closing returns focus to the profile button when it was in the menu.
function closeMenu() {
  if (profileMenu.hidden) return;
  const inside = profileMenu.contains(document.activeElement);
  setMenuOpen(false);
  if (inside) profileButton.focus();
}

function openMenu() {
  setMenuOpen(true);
  signOut.focus();
}

// A pointer press on the button moves focus to it, which closes the open menu (focus left it)
// before the click arrives; remember whether it was open at the press so the click closes it
// rather than reopening it. The memory belongs to that press only: a cancelled press, or one
// released elsewhere (dragged off the button), clears it, and a keyboard click never reads it.
let openAtPress = null;
const forgetPress = () => {
  openAtPress = null;
};
profileButton.addEventListener('pointerdown', () => {
  openAtPress = !profileMenu.hidden;
});
profileButton.addEventListener('pointercancel', forgetPress);
// The click, when there is one, follows the release; clear after it has had its turn.
document.addEventListener('pointerup', () => setTimeout(forgetPress, 0));
profileButton.addEventListener('click', (event) => {
  const wasOpen = openAtPress !== null && event.detail !== 0 ? openAtPress : !profileMenu.hidden;
  openAtPress = null;
  if (wasOpen) closeMenu();
  else openMenu();
});

// The menu button pattern: Down or Up on the button opens it, on the one item keeps focus there.
profileButton.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  openMenu();
});
profileMenu.addEventListener('keydown', (event) => {
  // Tab or Shift+Tab always leaves the one-item menu, possibly for the browser's own controls
  // (Sign out is last when the composer is closed), which fires no focusin and a focusout with
  // no relatedTarget. Let the browser move focus, then close without moving it.
  if (event.key === 'Tab') {
    setTimeout(() => setMenuOpen(false), 0);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  signOut.focus();
});

// Escape closes it from anywhere; so does a tap or click outside, or Tab moving focus out of it.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !profileMenu.hidden) {
    event.preventDefault();
    // Focus may be on the body (a click on the name label blurred Sign out); Escape returns it.
    setMenuOpen(false);
    profileButton.focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (profileMenu.hidden || account.contains(event.target)) return;
  // Focus on the body while the menu is open came from the menu too (a click on the name label
  // blurred Sign out), so it is restored the same way.
  const owned = menuOwnsFocus();
  setMenuOpen(false);
  // Let the press move focus to the control it landed on; if the menu had focus and nothing took
  // it (blank space), put it back on the profile button rather than the document body.
  if (owned) {
    setTimeout(() => {
      if (menuOwnsFocus()) profileButton.focus();
    }, 0);
  }
});
// Focus leaving the menu for anywhere else closes it, including Shift+Tab back onto the profile
// button: the test is the menu, not the account wrapper that also holds the button.
profileMenu.addEventListener('focusout', (event) => {
  if (event.relatedTarget && !profileMenu.contains(event.relatedTarget)) setMenuOpen(false);
});
// A blur with no destination (a click on the name label) sends no useful focusout later, so
// check where focus lands next. Focus stays where it went.
document.addEventListener('focusin', (event) => {
  if (!profileMenu.hidden && !profileMenu.contains(event.target)) setMenuOpen(false);
});

// From the task view: its session ended (401), or a request was refused because the session
// changed in another tab.
window.addEventListener('tasks:expired', () => {
  if (currentSession) showSignedOut({ focus: true, expired: true });
});
window.addEventListener('tasks:revalidate', () => followSession());

document.addEventListener('visibilitychange', () => refreshSession());
window.addEventListener('focus', () => refreshSession());
window.addEventListener('pageshow', () => refreshSession());
loadSession();

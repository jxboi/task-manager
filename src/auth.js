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
const demoButton = byId('auth-demo');
const demoAlt = byId('auth-alt');
const demoSpinner = byId('auth-demo-spinner');
const demoText = byId('auth-demo-text');
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
let demoLoginEnabled = false;
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
  demoButton.hidden = signup || !demoLoginEnabled;
  demoAlt.hidden = demoButton.hidden;
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

function setSubmitting(active, trigger = submit) {
  busy = active;
  const demo = trigger === demoButton;
  demoButton.disabled = active;
  demoButton.setAttribute('aria-busy', String(active && demo));
  demoSpinner.hidden = !(active && demo);
  demoText.textContent = active && demo ? 'Signing in…' : 'Continue as demo';
  spinner.hidden = !(active && !demo);
  submit.setAttribute('aria-disabled', String(active));
  submit.setAttribute('aria-busy', String(active && !demo));
  form.setAttribute('aria-busy', String(active));
  for (const input of inputs) input.readOnly = active;
  for (const radio of radios) radio.disabled = active;
  submitText.textContent = active && !demo ? (creating ? 'Creating account…' : 'Signing in…') : heading.textContent;
}

// Tells the task view which session it shows: a session object, or null when signed out.
// The task view resets whenever the session's CSRF token changes.
function announceSession(active) {
  window.dispatchEvent(new CustomEvent('tasks:session', { detail: { active } }));
}

function setAccount(active) {
  // Another tab switched accounts: the open menu's Sign out would now act on the new account.
  const switched = currentSession && (currentSession.csrfToken !== active.csrfToken || currentSession.user.email !== active.user.email);
  if (switched) closeMenu();
  currentSession = active;
  setToken(active.csrfToken);
  const label = active.user.name || active.user.email;
  accountName.textContent = label;
  accountName.title = label;
  profileButton.setAttribute('aria-label', `Account, ${label}`);
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
    demoLoginEnabled = active.demoLoginEnabled === true;
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

form.addEventListener('submit', (event) => {
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
  return submitAuth(creating ? 'sign-up/email' : 'sign-in/email', body, submit);
});

demoButton.addEventListener('click', () => {
  if (busy || creating || !demoLoginEnabled || authView.hidden) return;
  setSummary();
  info.textContent = '';
  return submitAuth('demo', {}, demoButton);
});

async function submitAuth(path, body, trigger) {
  setSubmitting(true, trigger);
  let response;
  try {
    response = await authRequest(path, body);
  } catch {
    setSummary(networkMessage);
  } finally {
    setSubmitting(false);
  }
  if (!response) {
    trigger.focus();
    return;
  }
  if (!response.ok) {
    if (trigger === demoButton) {
      setSummary(response.status === 429
        ? 'Too many attempts. Wait a minute, then try again.'
        : "Couldn't sign in as demo. Try again.");
      demoButton.focus();
    } else {
      handleAuthError(response, response.code);
    }
    return;
  }
  password.value = '';
  authView.hidden = true;
  broadcastAuthChange();
  await loadSession({ focus: true });
}

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
    // Focus goes back to the button only if it is still in the menu; the user may have moved on.
    signOutNote.hidden = false;
    closeMenu();
  } finally {
    signOut.textContent = 'Sign out';
    signOut.removeAttribute('aria-disabled');
    busy = false;
  }
});

// --- The profile menu: the account's name and Sign out, under the header's profile button ---
// A plain disclosure menu: the button toggles it, Escape closes it (focus back to the button), a
// press outside closes it without moving focus, and focus leaving it closes it. While it is open
// focus stays on Sign out: presses on the rest of the menu, or on the button, don't move focus.

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

// Pressing the name label (or the menu's padding) would blur Sign out to the body, and pressing
// the button while open would move focus out of the menu (closing it) before the click toggles.
// Keeping focus where it is makes both cases ordinary.
profileMenu.addEventListener('mousedown', (event) => {
  if (!signOut.contains(event.target)) event.preventDefault();
});
profileButton.addEventListener('mousedown', (event) => {
  if (!profileMenu.hidden) event.preventDefault();
});
profileButton.addEventListener('click', () => {
  if (profileMenu.hidden) openMenu();
  else closeMenu();
});

// The menu button pattern: Down or Up on the button opens it, on the one item keeps focus there.
profileButton.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  openMenu();
});
profileMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  signOut.focus();
});
// An outside press closes it without moving focus; once the tap's click has landed, focus that
// the hidden item dropped to the body goes back to the profile button (a control the tap focused
// keeps it).
let closedByOutsidePress = false;
document.addEventListener('pointerdown', (event) => {
  closedByOutsidePress = false;
  if (profileMenu.hidden || account.contains(event.target)) return;
  setMenuOpen(false);
  closedByOutsidePress = true;
});
document.addEventListener('pointercancel', () => {
  closedByOutsidePress = false;
});
document.addEventListener('click', () => {
  if (!closedByOutsidePress) return;
  closedByOutsidePress = false;
  const active = document.activeElement;
  if (!active || active === document.body) profileButton.focus();
});
// Focus leaving the menu closes it: Tab or Shift+Tab (onto the profile button, which is outside
// the menu), or out to the browser's own controls (no relatedTarget). Focus stays where it went.
profileMenu.addEventListener('focusout', (event) => {
  if (!profileMenu.contains(event.relatedTarget)) setMenuOpen(false);
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

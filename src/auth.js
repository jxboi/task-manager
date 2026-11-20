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
const accountName = byId('account-name');
const signOut = byId('account-sign-out');
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
  hint.hidden = !signup;
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

async function readSession() {
  const response = await fetch('/api/session', { cache: 'no-store' });
  if (response.status === 401) return { user: null, csrfToken: null };
  if (!response.ok) throw new Error('Session check failed');
  return response.json();
}

function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-CSRF-Token'] = token;
  return fetch(`/api/auth/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function setAccount(active) {
  currentSession = active;
  const label = active.user.name || active.user.email;
  accountName.textContent = label;
  accountName.title = label;
  signOut.setAttribute('aria-label', `Sign out ${label}`);
}

function showSignedIn(active, focus = false) {
  setAccount(active);
  for (const element of [accountName, signOut, taskView]) element.hidden = false;
  for (const element of [authView, loading, retry]) element.hidden = true;
  setMode(false, { keepEmail: false });
  if (focus) (touch.matches ? title : byId('new-todo')).focus();
}

function showSignedOut({ focus = false, expired = false } = {}) {
  currentSession = null;
  if (!byId('reminder-layer').hidden) byId('reminder-cancel').click();
  for (const element of [accountName, signOut, taskView, loading, retry, signOutNote]) element.hidden = true;
  accountName.textContent = '';
  accountName.removeAttribute('title');
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

async function refreshSession() {
  if (!currentSession || busy || checking || document.visibilityState !== 'visible') return;
  const previous = currentSession;
  checking = true;
  try {
    const active = await readSession();
    if (busy || currentSession !== previous) return;
    if (active.user) {
      setAccount(active);
    } else {
      showSignedOut({ focus: true, expired: true });
    }
  } catch {
    // Keep the current view during temporary connectivity failures.
  } finally {
    checking = false;
  }
}

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
  signOut.focus();
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
    response = await post(creating ? 'sign-up/email' : 'sign-in/email', body);
    if (!response.ok) errorCode = (await response.json().catch(() => null))?.code;
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
  await loadSession({ focus: true });
});

signOut.addEventListener('click', async () => {
  if (busy || !currentSession) return;
  busy = true;
  signOutNote.hidden = true;
  signOut.textContent = 'Signing out…';
  signOut.setAttribute('aria-disabled', 'true');
  try {
    const response = await post('sign-out', {}, currentSession.csrfToken);
    if (!response.ok && response.status !== 401) throw new Error('Sign out failed');
    showSignedOut({ focus: true });
    announce('Signed out.');
  } catch {
    signOutNote.hidden = false;
    signOut.focus();
  } finally {
    signOut.textContent = 'Sign out';
    signOut.removeAttribute('aria-disabled');
    busy = false;
  }
});

document.addEventListener('visibilitychange', refreshSession);
window.addEventListener('focus', refreshSession);
window.addEventListener('pageshow', refreshSession);
loadSession();

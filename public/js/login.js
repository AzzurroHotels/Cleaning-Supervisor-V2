import { api, ApiError } from './api.js';
import { icon, escapeHtml, toast, setButtonLoading } from './ui.js';

const card = document.getElementById('auth-card');
const params = new URLSearchParams(location.search);

function nextDestination() {
  const next = params.get('next');
  if (!next) return '/';
  try {
    const resolved = new URL(next, location.origin);
    if (resolved.origin !== location.origin) return '/';
    if (resolved.pathname === '/login') return '/';
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return '/';
  }
}

function showError(element, message) {
  if (!element) return;
  element.innerHTML =
    icon('alertTriangle', { size: 16 }) + '<span>' + escapeHtml(message) + '</span>';
  element.classList.add('is-visible');
}

function clearError(element) {
  if (!element) return;
  element.textContent = '';
  element.classList.remove('is-visible');
}

function passwordField({ id, label, hint = '', value = '', autocomplete = 'new-password' }) {
  return (
    '<div class="field">' +
    '<label for="' +
    id +
    '">' +
    escapeHtml(label) +
    '</label>' +
    '<div class="input-wrap">' +
    '<input class="input" id="' +
    id +
    '" name="' +
    id +
    '" type="password" value="' +
    escapeHtml(value) +
    '" autocomplete="' +
    autocomplete +
    '" required minlength="8" />' +
    '<button class="input-action" type="button" data-toggle-password="' +
    id +
    '" aria-label="Show password" aria-pressed="false">' +
    icon('eye', { size: 17 }) +
    '</button>' +
    '</div>' +
    (hint ? '<span class="field-hint">' + escapeHtml(hint) + '</span>' : '') +
    '</div>'
  );
}

function wirePasswordToggles(root) {
  root.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = root.querySelector('#' + button.dataset.togglePassword);
      if (!input) return;
      const showing = input.type === 'password';
      input.type = showing ? 'text' : 'password';
      button.innerHTML = icon(showing ? 'eyeOff' : 'eye', { size: 17 });
      button.setAttribute('aria-label', showing ? 'Hide password' : 'Show password');
      button.setAttribute('aria-pressed', String(showing));
      input.focus();
    });
  });
}

function renderLogin({ notice = '', username = '' } = {}) {
  card.classList.remove('is-setup');
  card.setAttribute('aria-busy', 'false');
  card.innerHTML =
    '<div class="auth-header">' +
    '<span class="auth-kicker">' +
    icon('shield', { size: 13 }) +
    'Secure access</span>' +
    '<h1>Welcome back</h1>' +
    '<p>Sign in to run the cleaning checklist or review inspection reports.</p>' +
    '</div>' +
    (notice ? '<div class="auth-success">' + icon('checkCircle', { size: 17 }) + '<span>' + escapeHtml(notice) + '</span></div>' : '') +
    '<form class="auth-form" id="loginForm" novalidate>' +
    '<p class="form-error" id="loginError" role="alert"></p>' +
    '<div class="field">' +
    '<label for="username">Username</label>' +
    '<div class="input-wrap">' +
    icon('user', { size: 18 }) +
    '<input class="input" id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="' +
    escapeHtml(username) +
    '" placeholder="Your username" required />' +
    '</div>' +
    '</div>' +
    passwordField({
      id: 'password',
      label: 'Password',
      autocomplete: 'current-password'
    }) +
    '<button class="btn btn-primary btn-lg btn-block" type="submit" id="loginSubmit">' +
    icon('arrowRight', { size: 18 }) +
    'Sign in</button>' +
    '</form>' +
    '<div class="auth-help">' +
    icon('info', { size: 17 }) +
    '<span><strong>Authorised staff only.</strong> Accounts are created by whoever sets up the system. Ask your manager if you need access.</span>' +
    '</div>';

  wirePasswordToggles(card);

  const form = card.querySelector('#loginForm');
  const error = card.querySelector('#loginError');
  const submit = card.querySelector('#loginSubmit');
  const usernameInput = card.querySelector('#username');
  const passwordInput = card.querySelector('#password');

  if (username) passwordInput?.focus();
  else usernameInput?.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(error);

    const usernameValue = usernameInput.value.trim();
    const passwordValue = passwordInput.value;
    if (!usernameValue || !passwordValue) {
      showError(error, 'Enter your username and password.');
      (!usernameValue ? usernameInput : passwordInput).focus();
      return;
    }

    setButtonLoading(submit, true, 'Signing in…');
    try {
      await api.post(
        '/api/auth/login',
        { username: usernameValue, password: passwordValue },
        { redirectOn401: false }
      );
      location.replace(nextDestination());
    } catch (requestError) {
      setButtonLoading(submit, false);
      showError(
        error,
        requestError instanceof ApiError
          ? requestError.message
          : 'Could not sign in. Please try again.'
      );
      passwordInput.select();
    }
  });
}

function renderSetup() {
  card.classList.add('is-setup');
  card.setAttribute('aria-busy', 'false');
  card.innerHTML =
    '<div class="auth-header">' +
    '<span class="auth-kicker">' +
    icon('sparkles', { size: 13 }) +
    'First-time setup</span>' +
    '<h1>Create the staff accounts</h1>' +
    '<p>Set up one supervisor account and one manager account. Both can be used immediately after this step.</p>' +
    '</div>' +
    '<div class="setup-intro">' +
    icon('shield', { size: 18 }) +
    '<span>These are the first accounts for this installation. Passwords must be at least 8 characters. You can change them later from the account menu.</span>' +
    '</div>' +
    '<form class="auth-form" id="setupForm" novalidate>' +
    '<p class="form-error" id="setupError" role="alert"></p>' +
    '<div class="setup-columns">' +
    '<section class="setup-section" aria-labelledby="supervisorHeading">' +
    '<div class="setup-section-head">' +
    '<span class="setup-icon">' +
    icon('user', { size: 18 }) +
    '</span>' +
    '<div><h3 id="supervisorHeading">Supervisor</h3><p>Runs inspections</p></div>' +
    '</div>' +
    '<div class="field"><label for="supervisorName">Full name</label><input class="input" id="supervisorName" name="supervisorName" type="text" autocomplete="name" placeholder="e.g. Alvin Mensah" required /></div>' +
    '<div class="field"><label for="supervisorUsername">Username</label><input class="input" id="supervisorUsername" name="supervisorUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="supervisor" required /></div>' +
    passwordField({
      id: 'supervisorPassword',
      label: 'Password',
      hint: 'At least 8 characters.'
    }) +
    '</section>' +
    '<section class="setup-section" aria-labelledby="managerHeading">' +
    '<div class="setup-section-head">' +
    '<span class="setup-icon">' +
    icon('chart', { size: 18 }) +
    '</span>' +
    '<div><h3 id="managerHeading">Manager</h3><p>Reviews reports and history</p></div>' +
    '</div>' +
    '<div class="field"><label for="managerName">Full name</label><input class="input" id="managerName" name="managerName" type="text" autocomplete="name" placeholder="e.g. Maria Allen" required /></div>' +
    '<div class="field"><label for="managerUsername">Username</label><input class="input" id="managerUsername" name="managerUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" value="manager" required /></div>' +
    passwordField({
      id: 'managerPassword',
      label: 'Password',
      hint: 'At least 8 characters.'
    }) +
    '</section>' +
    '</div>' +
    '<div class="setup-actions">' +
    '<button class="btn btn-primary btn-lg" type="submit" id="setupSubmit">' +
    icon('checkCircle', { size: 18 }) +
    'Create accounts</button>' +
    '<p>Use different usernames for the supervisor and manager.</p>' +
    '</div>' +
    '</form>';

  wirePasswordToggles(card);

  const form = card.querySelector('#setupForm');
  const submit = card.querySelector('#setupSubmit');
  const error = card.querySelector('#setupError');
  const fields = {
    supervisorName: card.querySelector('#supervisorName'),
    supervisorUsername: card.querySelector('#supervisorUsername'),
    supervisorPassword: card.querySelector('#supervisorPassword'),
    managerName: card.querySelector('#managerName'),
    managerUsername: card.querySelector('#managerUsername'),
    managerPassword: card.querySelector('#managerPassword')
  };

  fields.supervisorName.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError(error);

    const values = {
      supervisorName: fields.supervisorName.value.trim(),
      supervisorUsername: fields.supervisorUsername.value.trim(),
      supervisorPassword: fields.supervisorPassword.value,
      managerName: fields.managerName.value.trim(),
      managerUsername: fields.managerUsername.value.trim(),
      managerPassword: fields.managerPassword.value
    };

    if (
      !values.supervisorName ||
      !values.supervisorUsername ||
      !values.supervisorPassword ||
      !values.managerName ||
      !values.managerUsername ||
      !values.managerPassword
    ) {
      showError(error, 'Complete all six fields to create the accounts.');
      return;
    }

    if (values.supervisorPassword.length < 8 || values.managerPassword.length < 8) {
      showError(error, 'Passwords must be at least 8 characters.');
      return;
    }

    if (values.supervisorUsername.toLowerCase() === values.managerUsername.toLowerCase()) {
      showError(error, 'Supervisor and manager usernames must be different.');
      return;
    }

    setButtonLoading(submit, true, 'Creating accounts…');
    try {
      await api.post('/api/auth/setup', values, { redirectOn401: false });
      await api.post(
        '/api/auth/login',
        { username: values.supervisorUsername, password: values.supervisorPassword },
        { redirectOn401: false }
      );
      toast('Your workspace is ready.', { type: 'success' });
      setTimeout(() => location.replace('/'), 350);
    } catch (requestError) {
      setButtonLoading(submit, false);
      if (requestError instanceof ApiError && requestError.status === 409) {
        renderLogin({ notice: 'Setup is already complete. Sign in with your account.' });
        return;
      }
      showError(
        error,
        requestError instanceof ApiError
          ? requestError.message
          : 'Could not create the accounts. Please try again.'
      );
    }
  });
}

function renderUnavailable(message) {
  card.classList.remove('is-setup');
  card.setAttribute('aria-busy', 'false');
  card.innerHTML =
    '<div class="auth-error-page">' +
    '<span class="empty-icon">' +
    icon('wifiOff', { size: 24 }) +
    '</span>' +
    '<h2>Cannot reach the server</h2>' +
    '<p>' +
    escapeHtml(message || 'Check that the server is running and that this device is online.') +
    '</p>' +
    '<button class="btn btn-primary" type="button" id="retryButton">' +
    icon('refresh', { size: 17 }) +
    'Try again</button>' +
    '</div>';
  card.querySelector('#retryButton').addEventListener('click', () => location.reload());
}

async function init() {
  try {
    const status = await api.get('/api/auth/status', { redirectOn401: false });

    if (status.user) {
      location.replace(nextDestination());
      return;
    }

    if (status.needsSetup) renderSetup();
    else renderLogin();
  } catch (error) {
    renderUnavailable(error instanceof ApiError ? error.message : '');
  }
}

init();

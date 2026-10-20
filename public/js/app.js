import { api, ApiError } from './api.js';
import {
  confirmDialog,
  escapeHtml,
  icon,
  initials,
  openModal,
  setButtonLoading,
  toast
} from './ui.js';
import { renderDashboard } from './views/dashboard.js';
import { renderInspectionEditor } from './views/inspection.js';
import { renderInspectionDetail, renderInspectionsList } from './views/inspections.js';

const app = document.getElementById('app');
const menu = document.getElementById('user-menu');
const menuButton = document.getElementById('user-menu-button');
const dropdown = document.getElementById('user-dropdown');

let currentUser = null;
let cleanupCurrentView = null;
let logoutInProgress = false;

function roleLabel(role) {
  return role === 'manager' ? 'Manager' : 'Supervisor';
}

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((link) => {
    const active = link.dataset.nav === name;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function closeUserMenu() {
  dropdown.hidden = true;
  menuButton.setAttribute('aria-expanded', 'false');
}

function toggleUserMenu() {
  const willOpen = dropdown.hidden;
  dropdown.hidden = !willOpen;
  menuButton.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) dropdown.querySelector('.dropdown-item')?.focus();
}

function populateUserMenu() {
  const firstInitials = initials(currentUser.name);
  document.getElementById('topbar-avatar').textContent = firstInitials;
  document.getElementById('topbar-name').textContent = currentUser.name;
  document.getElementById('topbar-role').textContent = roleLabel(currentUser.role);
  document.getElementById('dropdown-avatar').textContent = firstInitials;
  document.getElementById('dropdown-name').textContent = currentUser.name;
  document.getElementById('dropdown-username').textContent = '@' + currentUser.username;
  const roleBadge = document.getElementById('dropdown-role');
  roleBadge.textContent = roleLabel(currentUser.role);
  roleBadge.className = 'badge ' + (currentUser.role === 'manager' ? 'badge-info' : 'badge-success');
}

function openPasswordModal() {
  closeUserMenu();
  const { dialog, close } = openModal({
    title: 'Change password',
    subtitle: 'Use at least 8 characters. Other signed-in devices will be signed out.',
    size: 'narrow',
    body:
      '<form class="account-form" id="passwordForm" novalidate>' +
      '<p class="form-error" id="passwordError" role="alert"></p>' +
      '<div class="field"><label for="currentPassword">Current password</label><input class="input" id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required /></div>' +
      '<div class="field"><label for="newPassword">New password</label><input class="input" id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="8" required /><span class="field-hint">At least 8 characters.</span></div>' +
      '<div class="field"><label for="confirmPassword">Confirm new password</label><input class="input" id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required /></div>' +
      '</form>',
    footer:
      '<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>' +
      '<button class="btn btn-primary" type="submit" form="passwordForm" id="passwordSubmit">' +
      icon('key', { size: 17 }) +
      'Update password</button>'
  });

  const form = dialog.querySelector('#passwordForm');
  const error = dialog.querySelector('#passwordError');
  const submit = dialog.querySelector('#passwordSubmit');
  const current = dialog.querySelector('#currentPassword');
  const next = dialog.querySelector('#newPassword');
  const confirm = dialog.querySelector('#confirmPassword');

  dialog.querySelector('[data-modal-close]')?.addEventListener('click', close);
  current.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    error.classList.remove('is-visible');

    if (!current.value || !next.value || !confirm.value) {
      error.textContent = 'Complete all three fields.';
      error.classList.add('is-visible');
      return;
    }
    if (next.value.length < 8) {
      error.textContent = 'The new password must be at least 8 characters.';
      error.classList.add('is-visible');
      next.focus();
      return;
    }
    if (next.value !== confirm.value) {
      error.textContent = 'The new passwords do not match.';
      error.classList.add('is-visible');
      confirm.focus();
      return;
    }

    setButtonLoading(submit, true, 'Updating…');
    try {
      await api.post('/api/auth/password', {
        currentPassword: current.value,
        newPassword: next.value
      });
      close();
      toast('Password updated. Other devices have been signed out.', { type: 'success' });
    } catch (requestError) {
      setButtonLoading(submit, false);
      error.textContent =
        requestError instanceof ApiError ? requestError.message : 'Could not update the password.';
      error.classList.add('is-visible');
    }
  });
}

async function logout() {
  if (logoutInProgress) return;
  closeUserMenu();
  const confirmed = await confirmDialog({
    title: 'Sign out?',
    message: 'Any checklist changes that have finished syncing are saved. Signing out will end this session.',
    confirmLabel: 'Sign out',
    cancelLabel: 'Stay signed in',
    iconName: 'logOut'
  });
  if (!confirmed) return;

  logoutInProgress = true;
  try {
    await api.post('/api/auth/logout');
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 0) {
      logoutInProgress = false;
      toast('Could not sign out. Please try again.', { type: 'error' });
      return;
    }
  }
  location.replace('/login');
}

function wireUserMenu() {
  populateUserMenu();
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleUserMenu();
  });
  menu.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', () => {
    if (!dropdown.hidden) closeUserMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dropdown.hidden) {
      closeUserMenu();
      menuButton.focus();
    }
  });
  dropdown.querySelector('[data-action="password"]').addEventListener('click', openPasswordModal);
  dropdown.querySelector('[data-action="logout"]').addEventListener('click', logout);
}

function showFatal(title, message, retry = true, target = app) {
  target.innerHTML =
    '<div class="fatal-state">' +
    '<span class="empty-icon">' +
    icon('wifiOff', { size: 26 }) +
    '</span>' +
    '<h1>' +
    escapeHtml(title) +
    '</h1>' +
    '<p>' +
    escapeHtml(message) +
    '</p>' +
    (retry
      ? '<button class="btn btn-primary" type="button" id="retryView">' +
        icon('refresh', { size: 17 }) +
        'Try again</button>'
      : '<a class="btn btn-secondary" href="#/">' + icon('home', { size: 17 }) + 'Back to overview</a>') +
    '</div>';
  target.querySelector('#retryView')?.addEventListener('click', () => handleRoute());
}

function showNotFound(target = app) {
  target.innerHTML =
    '<div class="fatal-state">' +
    '<span class="empty-icon">' +
    icon('search', { size: 26 }) +
    '</span>' +
    '<h1>Page not found</h1>' +
    '<p>That page does not exist or the link is out of date.</p>' +
    '<a class="btn btn-primary" href="#/">' + icon('home', { size: 17 }) + 'Back to overview</a>' +
    '</div>';
}

async function handleRoute() {
  if (!currentUser) return;
  closeUserMenu();

  if (typeof cleanupCurrentView === 'function') {
    cleanupCurrentView();
    cleanupCurrentView = null;
  }

  document.querySelectorAll('dialog.modal[open]').forEach((dialog) => {
    try {
      dialog.close();
    } catch {
      /* Ignore dialogs that are already closing. */
    }
  });

  const raw = (location.hash.replace(/^#/, '') || '/').split('?')[0];
  const segments = raw.split('/').filter(Boolean);
  const isEditor = segments[0] === 'inspection' && segments[1];
  const isDetail = segments[0] === 'inspections' && segments[1];
  const isList = segments[0] === 'inspections' && !segments[1];

  document.body.classList.toggle('is-inspecting', Boolean(isEditor));
  setActiveNav(isEditor || isDetail || isList ? 'inspections' : 'overview');
  window.scrollTo(0, 0);

  const page = document.createElement('div');
  page.className = 'route-root';
  app.replaceChildren(page);

  try {
    let cleanup = null;
    if (!segments.length) {
      cleanup = await renderDashboard(page, currentUser);
    } else if (isList) {
      cleanup = await renderInspectionsList(page, currentUser);
    } else if (isDetail) {
      cleanup = await renderInspectionDetail(page, currentUser, decodeURIComponent(segments[1]));
    } else if (isEditor) {
      if (currentUser.role !== 'supervisor') {
        location.replace('#/inspections/' + encodeURIComponent(segments[1]));
        return;
      }
      cleanup = await renderInspectionEditor(page, currentUser, decodeURIComponent(segments[1]));
    } else {
      showNotFound(page);
    }
    if (!page.isConnected) return;
    if (typeof cleanup === 'function') cleanupCurrentView = cleanup;
  } catch (error) {
    if (!page.isConnected) return;
    console.error(error);
    if (error instanceof ApiError && error.status === 401) return;
    showFatal(
      'Could not load this page',
      error instanceof ApiError
        ? error.message
        : 'Something unexpected happened. Please try again.',
      true,
      page
    );
  }
}

async function boot() {
  try {
    const result = await api.get('/api/auth/me');
    currentUser = result.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      location.replace('/login');
      return;
    }
    showFatal(
      'Cannot reach the server',
      error instanceof ApiError
        ? error.message
        : 'Check that the server is running and that this device is online.'
    );
    return;
  }

  wireUserMenu();
  window.addEventListener('hashchange', handleRoute);
  window.addEventListener('online', () => {
    toast('Back online.', { type: 'success' });
  });
  window.addEventListener('offline', () => {
    toast('You are offline. Changes will be saved on this device until the connection returns.', {
      type: 'warning',
      duration: 7000
    });
  });
  handleRoute();
}

boot();

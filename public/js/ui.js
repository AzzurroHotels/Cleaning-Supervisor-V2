import { icon } from './icons.js';

export { icon };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function initials(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

export function formatDate(value, style = 'medium') {
  if (!value) return '—';
  const date = parseDateOnly(value);
  if (!date) return String(value);
  const options = {
    short: { day: 'numeric', month: 'short', year: 'numeric' },
    medium: { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' },
    long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
    dayMonth: { day: 'numeric', month: 'short' },
    weekday: { weekday: 'short' },
    month: { month: 'long', year: 'numeric' }
  }[style] || { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('en-GB', options).format(date);
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
}

export function relativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return 'Just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return formatDate(date.toISOString().slice(0, 10), 'short');
}

export function todayInputValue() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

export function percent(part, total) {
  if (!total) return 0;
  return Math.round((Number(part) / Number(total)) * 1000) / 10;
}

export function plural(count, singular, pluralForm) {
  return Number(count) === 1 ? singular : pluralForm || singular + 's';
}

export function statusBadge(status) {
  if (status === 'completed') {
    return '<span class="badge badge-success"><span class="dot"></span>Completed</span>';
  }
  return '<span class="badge badge-warning"><span class="dot"></span>In progress</span>';
}

export function avatar(name, { large = false } = {}) {
  return (
    '<span class="avatar' +
    (large ? ' avatar-lg' : '') +
    '" aria-hidden="true">' +
    escapeHtml(initials(name)) +
    '</span>'
  );
}

export function emptyState(iconName, title, text, actionHtml = '') {
  return (
    '<div class="empty-state">' +
    '<span class="empty-icon">' +
    icon(iconName, { size: 24 }) +
    '</span>' +
    '<h3>' +
    escapeHtml(title) +
    '</h3>' +
    '<p>' +
    escapeHtml(text) +
    '</p>' +
    actionHtml +
    '</div>'
  );
}

let toastCounter = 0;

export function toast(message, { type = 'success', duration, action } = {}) {
  let region = document.getElementById('toast-region');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast-region';
    region.className = 'toast-region';
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }

  const icons = {
    success: 'checkCircle',
    error: 'alertTriangle',
    warning: 'alertTriangle',
    info: 'info'
  };
  const element = document.createElement('div');
  const id = 'toast-' + ++toastCounter;
  element.id = id;
  element.className = 'toast toast-' + type;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.innerHTML =
    '<span class="toast-icon">' +
    icon(icons[type] || 'info', { size: 16 }) +
    '</span>' +
    '<div class="toast-content">' +
    escapeHtml(message) +
    (action
      ? '<div style="margin-top:6px"><button class="btn btn-sm btn-soft" type="button" data-toast-action>' +
        escapeHtml(action.label) +
        '</button></div>'
      : '') +
    '</div>' +
    '<button class="toast-close" type="button" aria-label="Dismiss notification">' +
    icon('x', { size: 15 }) +
    '</button>';

  const remove = () => {
    if (!element.isConnected) return;
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 220);
  };

  element.querySelector('.toast-close').addEventListener('click', remove);
  if (action) {
    element.querySelector('[data-toast-action]').addEventListener('click', () => {
      remove();
      action.onClick?.();
    });
  }

  region.append(element);
  while (region.children.length > 4) region.firstElementChild.remove();

  const timeout = duration || (type === 'error' ? 7000 : 4500);
  let timer = setTimeout(remove, timeout);
  element.addEventListener('mouseenter', () => clearTimeout(timer));
  element.addEventListener('mouseleave', () => {
    timer = setTimeout(remove, 1800);
  });

  return { remove };
}

export function openModal({
  title,
  subtitle = '',
  body = '',
  footer = '',
  size = '',
  onClose,
  returnFocus = null
}) {
  const previousFocus = returnFocus || document.activeElement;
  const dialog = document.createElement('dialog');
  const sizeClass = size === 'wide' ? ' modal-wide' : size === 'narrow' ? ' modal-narrow' : '';
  dialog.className = 'modal' + sizeClass;
  dialog.setAttribute('aria-labelledby', 'modal-title');
  dialog.innerHTML =
    '<div class="modal-shell">' +
    '<div class="modal-head">' +
    '<div><h2 id="modal-title">' +
    escapeHtml(title) +
    '</h2>' +
    (subtitle ? '<p>' + escapeHtml(subtitle) + '</p>' : '') +
    '</div>' +
    '<button class="modal-close" type="button" data-modal-close aria-label="Close dialog">' +
    icon('x', { size: 18 }) +
    '</button>' +
    '</div>' +
    '<div class="modal-body">' +
    body +
    '</div>' +
    (footer ? '<div class="modal-foot">' + footer + '</div>' : '') +
    '</div>';

  document.body.append(dialog);

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    else dialog.remove();
    if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    onClose?.();
  };
  const close = () => finish();

  dialog.querySelectorAll('[data-modal-close]').forEach((button) => {
    button.addEventListener('click', close);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (!closed) {
      closed = true;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      onClose?.();
    }
  });

  dialog.showModal();

  return {
    dialog,
    close,
    body: dialog.querySelector('.modal-body'),
    footer: dialog.querySelector('.modal-foot'),
    head: dialog.querySelector('.modal-head')
  };
}

export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  iconName = 'alertTriangle'
}) {
  return new Promise((resolve) => {
    const { dialog, close } = openModal({
      title,
      body:
        '<div class="confirm-message">' +
        '<span class="confirm-icon' +
        (danger ? ' is-danger' : '') +
        '">' +
        icon(iconName, { size: 22 }) +
        '</span>' +
        '<p>' +
        escapeHtml(message) +
        '</p>' +
        '</div>',
      footer:
        '<button class="btn btn-secondary" type="button" data-confirm-cancel>' +
        escapeHtml(cancelLabel) +
        '</button>' +
        '<button class="btn ' +
        (danger ? 'btn-danger-solid' : 'btn-primary') +
        '" type="button" data-confirm-ok>' +
        escapeHtml(confirmLabel) +
        '</button>',
      size: 'narrow'
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
      close();
    };

    dialog.querySelector('[data-confirm-ok]').addEventListener('click', () => finish(true));
    dialog.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('close', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });

    requestAnimationFrame(() => dialog.querySelector('[data-confirm-ok]')?.focus());
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.left = '-9999px';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Could not read that file.'));
    reader.readAsDataURL(blob);
  });
}

export function setButtonLoading(button, loading, label = 'Working…') {
  if (!button) return;
  if (loading) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + escapeHtml(label) + '</span>';
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) {
      button.innerHTML = button.dataset.originalHtml;
      delete button.dataset.originalHtml;
    }
  }
}

export function debounce(fn, wait = 400) {
  let timer;
  let lastArgs;
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      lastArgs = undefined;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    lastArgs = undefined;
  };
  debounced.flush = () => {
    clearTimeout(timer);
    if (lastArgs) {
      const args = lastArgs;
      lastArgs = undefined;
      fn(...args);
    }
  };
  return debounced;
}

export function focusFirst(container) {
  requestAnimationFrame(() => {
    const target = container.querySelector(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href]'
    );
    target?.focus();
  });
}

import { formatDate, escapeHtml, icon, percent, relativeTime, statusBadge } from '../ui.js';

export function inspectionHref(inspection, user) {
  if (user.role === 'supervisor' && inspection.status === 'draft') {
    return '#/inspection/' + encodeURIComponent(inspection.id);
  }
  return '#/inspections/' + encodeURIComponent(inspection.id);
}

export function dateTile(dateString) {
  const date = new Date(dateString + 'T12:00:00');
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric' }).format(date);
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(date);
  return (
    '<span class="date-tile" aria-hidden="true"><strong>' +
    escapeHtml(day) +
    '</strong><span>' +
    escapeHtml(month) +
    '</span></span>'
  );
}

export function inspectionRow(inspection, user, { href, showInspector = true } = {}) {
  const destination = href || inspectionHref(inspection, user);
  const title = showInspector ? inspection.inspector.name : 'Cleaning inspection';
  const sub =
    formatDate(inspection.date, 'long') +
    ' · updated ' +
    relativeTime(inspection.updatedAt) +
    (inspection.status === 'completed' && inspection.completedAt
      ? ' · completed ' + relativeTime(inspection.completedAt)
      : '');
  const stats = inspection.stats;

  return (
    '<a class="inspection-row" href="' +
    destination +
    '">' +
    dateTile(inspection.date) +
    '<span class="inspection-row-main">' +
    '<span class="row-title">' +
    escapeHtml(title) +
    statusBadge(inspection.status) +
    '</span>' +
    '<span class="row-sub">' +
    escapeHtml(sub) +
    '</span>' +
    '</span>' +
    '<span class="inspection-row-stats" aria-label="' +
    stats.pass +
    ' passed, ' +
    stats.fail +
    ' failed, ' +
    stats.unchecked +
    ' not checked">' +
    '<span class="count-pill pass"><strong>' +
    stats.pass +
    '</strong> pass</span>' +
    '<span class="count-pill fail"><strong>' +
    stats.fail +
    '</strong> fail</span>' +
    '<span class="count-pill"><strong>' +
    stats.unchecked +
    '</strong> left</span>' +
    '</span>' +
    '<span class="row-arrow" aria-hidden="true">' +
    icon('chevronRight', { size: 17 }) +
    '</span>' +
    '</a>'
  );
}

export function statCard({ iconName, value, label, foot, tone = '', suffix = '' }) {
  return (
    '<article class="stat-card ' +
    (tone ? 'is-' + tone : '') +
    '">' +
    '<div class="stat-top"><span class="stat-icon">' +
    icon(iconName, { size: 19 }) +
    '</span></div>' +
    '<p class="stat-value">' +
    escapeHtml(value) +
    (suffix ? '<small>' + escapeHtml(suffix) + '</small>' : '') +
    '</p>' +
    '<p class="stat-label">' +
    escapeHtml(label) +
    '</p>' +
    '<p class="stat-foot">' +
    escapeHtml(foot) +
    '</p>' +
    '</article>'
  );
}

export function progressRing(value, { large = false } = {}) {
  const safe = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    '<div class="progress-ring' +
    (large ? ' is-large' : '') +
    '" style="--ring-value:' +
    safe +
    '" role="img" aria-label="' +
    Math.round(safe) +
    ' percent complete"><span>' +
    Math.round(safe) +
    '%</span></div>'
  );
}

export function completionPercent(stats) {
  return percent(stats.pass + stats.fail, stats.total);
}

export function failureMeta(count) {
  return (
    '<span class="preview-meta">' +
    icon('camera', { size: 11 }) +
    ' ' +
    count +
    ' ' +
    (count === 1 ? 'file' : 'files') +
    '</span>'
  );
}

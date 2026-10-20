import { api, buildQuery } from '../api.js';
import {
  confirmDialog,
  copyText,
  escapeHtml,
  formatDate,
  formatDateTime,
  icon,
  openModal,
  relativeTime,
  setButtonLoading,
  statusBadge,
  toast
} from '../ui.js';
import { completionPercent, inspectionRow, progressRing } from './components.js';
import { buildDailySummary, exportInspectionReport } from '../report.js';

function groupCounts(group) {
  let pass = 0;
  let fail = 0;
  let unchecked = 0;
  let hasFailure = false;
  for (const item of group.items) {
    if (item.result === 'pass') pass += 1;
    else if (item.result === 'fail') fail += 1;
    else unchecked += 1;
    if (item.failure) hasFailure = true;
  }
  return { pass, fail, unchecked, hasFailure, total: group.items.length };
}

function mediaGrid(attachments) {
  if (!attachments?.length) return '';
  return (
    '<div class="media-grid">' +
    attachments
      .map((attachment) => {
        const isVideo = attachment.mimeType.startsWith('video/');
        return (
          '<a class="media-thumb" href="' +
          escapeHtml(attachment.url) +
          '" target="_blank" rel="noopener" aria-label="Open ' +
          escapeHtml(attachment.originalName) +
          '">' +
          (isVideo
            ? '<video src="' +
              escapeHtml(attachment.url) +
              '" preload="metadata" muted></video><span class="play-badge">' +
              icon('play', { size: 18 }) +
              '</span>'
            : '<img src="' +
              escapeHtml(attachment.url) +
              '" alt="' +
              escapeHtml(attachment.originalName) +
              '" loading="lazy" />') +
          '</a>'
        );
      })
      .join('') +
    '</div>'
  );
}

function findingMarkup(item, group) {
  const failure = item.failure;
  const rechecked = item.result === 'pass' && failure?.recheckedAt;
  const attachments = failure?.attachments || [];
  return (
    '<article class="finding-card">' +
    '<div class="finding-top"><h3>' +
    escapeHtml(item.text) +
    '</h3><span class="failure-count">' +
    (attachments.length || '!') +
    '</span></div>' +
    '<p class="finding-location">' +
    escapeHtml(group.name) +
    ' · ' +
    escapeHtml(failure.location) +
    '</p>' +
    '<p>' +
    escapeHtml(failure.notes) +
    '</p>' +
    '<p class="finding-note">' +
    (rechecked
      ? 'Passed after recheck'
      : 'Failure recorded ' + relativeTime(failure.recordedAt)) +
    (attachments.length ? ' · ' + attachments.length + ' attachment(s)' : '') +
    '</p>' +
    mediaGrid(attachments) +
    '</article>'
  );
}

function readItem(item) {
  const state = item.result || 'none';
  const statusIcon = state === 'pass' ? 'check' : state === 'fail' ? 'x' : 'minusCircle';
  let note = '';
  if (item.failure && (item.result === 'fail' || item.failure.recordedAt)) {
    const rechecked = item.result === 'pass' && item.failure.recheckedAt;
    note =
      '<div class="read-note ' +
      (rechecked ? 'is-rechecked' : '') +
      '">' +
      '<strong>' +
      (rechecked ? 'Passed after recheck' : 'Failure') +
      ': ' +
      escapeHtml(item.failure.location) +
      '</strong><br />' +
      escapeHtml(item.failure.notes) +
      (item.failure.recordedAt
        ? '<br /><span class="read-note-meta">Recorded ' +
          escapeHtml(formatDateTime(item.failure.recordedAt)) +
          (rechecked && item.failure.recheckedAt
            ? ' · rechecked ' + escapeHtml(formatDateTime(item.failure.recheckedAt))
            : '') +
          '</span>'
        : '') +
      mediaGrid(item.failure.attachments) +
      '</div>';
  }

  return (
    '<div class="read-item ' +
    (state === 'pass' ? 'is-pass' : '') +
    '"><span class="read-status ' +
    state +
    '">' +
    icon(statusIcon, { size: 12 }) +
    '</span><p>' +
    escapeHtml(item.text) +
    '</p></div>' +
    note
  );
}

export async function renderInspectionDetail(container, user, inspectionId) {
  container.innerHTML =
    '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading inspection…</span></div>';

  const result = await api.get('/api/inspections/' + encodeURIComponent(inspectionId));
  if (!container.isConnected) return null;

  const inspection = result.inspection;
  const canEdit = user.role === 'supervisor';
  const isDraft = inspection.status === 'draft';
  const percentComplete = completionPercent(inspection.stats);
  const failures = [];
  for (const group of inspection.groups) {
    for (const item of group.items) {
      if (item.result === 'fail') failures.push({ group, item });
    }
  }

  let floorsHtml = '';
  for (const group of inspection.groups) {
    const counts = groupCounts(group);
    const previous = inspection.groups[inspection.groups.indexOf(group) - 1];
    if (!previous || previous.floor !== group.floor) {
      floorsHtml +=
        '<div class="floor-heading">' +
        escapeHtml(group.floor) +
        '<span class="line"></span></div>';
    }
    floorsHtml +=
      '<details class="read-group ' +
      (counts.fail ? 'is-failed' : '') +
      '" ' +
      (counts.hasFailure ? 'open' : '') +
      '>' +
      '<summary>' +
      '<span class="read-group-icon">' +
      icon(group.icon || 'clipboard', { size: 16 }) +
      '</span>' +
      '<span class="read-group-main"><strong>' +
      escapeHtml(group.name) +
      '</strong><small>' +
      escapeHtml(group.subtitle || group.floor) +
      '</small></span>' +
      '<span class="read-group-summary">' +
      (counts.fail
        ? '<span class="badge badge-danger">' + counts.fail + ' failed</span>'
        : counts.unchecked
          ? '<span class="badge badge-neutral">' + counts.unchecked + ' left</span>'
          : '<span class="badge badge-success">All checked</span>') +
      icon('chevronDown', { size: 15, className: 'group-chevron' }) +
      '</span>' +
      '</summary>' +
      '<div class="read-body">' +
      group.items.map(readItem).join('') +
      '</div>' +
      '</details>';
  }

  const findingsHtml = failures.length
    ? failures.map(({ group, item }) => findingMarkup(item, group)).join('')
    : '<div class="findings-empty">' +
      icon('checkCircle', { size: 24 }) +
      '<span>No outstanding failures. Everything marked failed has been corrected and rechecked.</span></div>';

  const metaList =
    '<ul class="detail-meta-list">' +
    '<li><span>Inspector</span><strong>' +
    escapeHtml(inspection.inspector.name) +
    '</strong></li>' +
    '<li><span>Started</span><strong>' +
    escapeHtml(formatDateTime(inspection.createdAt)) +
    '</strong></li>' +
    '<li><span>Last updated</span><strong>' +
    escapeHtml(formatDateTime(inspection.updatedAt)) +
    '</strong></li>' +
    '<li><span>Completed</span><strong>' +
    (inspection.completedAt ? escapeHtml(formatDateTime(inspection.completedAt)) : 'Not completed') +
    '</strong></li>' +
    '</ul>';

  container.innerHTML =
    '<div class="view detail-view">' +
    '<section class="detail-hero">' +
    '<div class="detail-hero-top">' +
    '<div class="detail-title">' +
    '<div class="inline">' +
    statusBadge(inspection.status) +
    '<span class="badge badge-neutral">' +
    icon('building', { size: 12 }) +
    'Allen Hostel</span>' +
    '</div>' +
    '<h1>' +
    escapeHtml(formatDate(inspection.date, 'long')) +
    '</h1>' +
    '<p>Inspected by ' +
    escapeHtml(inspection.inspector.name) +
    ' · updated ' +
    escapeHtml(relativeTime(inspection.updatedAt)) +
    '</p>' +
    '</div>' +
    '<div class="detail-actions">' +
    (canEdit && isDraft
      ? '<a class="btn btn-primary" href="#/inspection/' +
        encodeURIComponent(inspection.id) +
        '">' +
        icon('clipboard', { size: 16 }) +
        'Continue inspection</a>'
      : '') +
    (canEdit && !isDraft
      ? '<button class="btn btn-secondary" type="button" id="reopenInspection">' +
        icon('refresh', { size: 16 }) +
        'Reopen</button>'
      : '') +
    '<button class="btn btn-secondary" type="button" id="copySummary">' +
    icon('copy', { size: 16 }) +
    'Copy update</button>' +
    '<button class="btn btn-secondary" type="button" id="downloadReport">' +
    icon('download', { size: 16 }) +
    'Download</button>' +
    '<button class="btn btn-secondary" type="button" id="printReport">' +
    icon('printer', { size: 16 }) +
    'Print</button>' +
    '</div>' +
    '</div>' +
    '<div class="detail-summary">' +
    '<div class="summary-tile pass"><span>Passed</span><strong>' +
    inspection.stats.pass +
    '</strong></div>' +
    '<div class="summary-tile fail"><span>Failed</span><strong>' +
    inspection.stats.fail +
    '</strong></div>' +
    '<div class="summary-tile"><span>Not checked</span><strong>' +
    inspection.stats.unchecked +
    '</strong></div>' +
    '<div class="summary-tile"><span>Total checks</span><strong>' +
    inspection.stats.total +
    '</strong></div>' +
    '</div>' +
    '<div class="detail-progress">' +
    progressRing(percentComplete, { large: true }) +
    '<div class="progress-track"><div class="progress-fill" style="width:' +
    percentComplete +
    '%"></div></div><span>' +
    inspection.stats.pass +
    ' of ' +
    inspection.stats.total +
    ' checks passed</span>' +
    '</div>' +
    '</section>' +
    '<div class="detail-grid">' +
    '<div class="detail-main">' +
    floorsHtml +
    '</div>' +
    '<aside class="detail-side">' +
    '<section class="card findings-card"><div class="card-head"><div><h2>Findings</h2><p>' +
    (failures.length
      ? failures.length + ' outstanding item' + (failures.length === 1 ? '' : 's')
      : 'No outstanding failures') +
    '</p></div></div><div class="finding-list">' +
    findingsHtml +
    '</div></section>' +
    '<section class="card"><div class="card-head"><div><h2>Closeout</h2><p>Sign-off and handover</p></div></div>' +
    '<div class="signoff-state">' +
    '<div class="signoff-row"><span>Corrections rechecked</span>' +
    (inspection.correctionsRechecked
      ? '<span class="badge badge-success">Yes</span>'
      : '<span class="badge badge-neutral">Not confirmed</span>') +
    '</div>' +
    '<div class="signoff-row"><span>Issues handed over</span>' +
    (inspection.handoverDone
      ? '<span class="badge badge-success">Yes</span>'
      : '<span class="badge badge-neutral">Not confirmed</span>') +
    '</div>' +
    '<div class="signoff-note">' +
    (inspection.handover
      ? escapeHtml(inspection.handover)
      : 'No outstanding issues recorded.') +
    '</div>' +
    '</div></section>' +
    '<section class="card"><div class="card-head"><div><h2>Details</h2><p>Inspection record</p></div></div>' +
    metaList +
    '</section>' +
    '</aside>' +
    '</div>' +
    '</div>';

  const copyButton = container.querySelector('#copySummary');
  copyButton.addEventListener('click', async () => {
    const summary = buildDailySummary(inspection);
    const copied = await copyText(summary);
    if (copied) {
      toast('Daily update copied. Paste it into a message to management.', { type: 'success' });
      return;
    }
    openModal({
      title: 'Daily update',
      subtitle: 'Copy this text and send it to management.',
      body:
        '<textarea class="textarea" id="summaryText" readonly rows="18" style="min-height:340px">' +
        escapeHtml(summary) +
        '</textarea>',
      footer: '<button class="btn btn-primary" type="button" data-modal-close>Close</button>',
      size: 'wide'
    });
  });

  const downloadButton = container.querySelector('#downloadReport');
  downloadButton.addEventListener('click', async () => {
    setButtonLoading(downloadButton, true, 'Preparing…');
    try {
      const report = await exportInspectionReport(inspection);
      toast(
        report.missing
          ? 'Report downloaded. ' + report.missing + ' attachment(s) could not be embedded.'
          : 'Report downloaded with all attachments.',
        { type: report.missing ? 'warning' : 'success' }
      );
    } catch (error) {
      toast(error.message || 'Could not create the report.', { type: 'error' });
    } finally {
      setButtonLoading(downloadButton, false);
    }
  });

  container.querySelector('#printReport').addEventListener('click', () => window.print());

  const reopenButton = container.querySelector('#reopenInspection');
  if (reopenButton) {
    reopenButton.addEventListener('click', async () => {
      const confirmed = await confirmDialog({
        title: 'Reopen this inspection?',
        message:
          'The report will become editable again and will no longer be marked as completed until you complete it again.',
        confirmLabel: 'Reopen inspection',
        iconName: 'refresh'
      });
      if (!confirmed) return;
      setButtonLoading(reopenButton, true, 'Reopening…');
      try {
        await api.post('/api/inspections/' + encodeURIComponent(inspection.id) + '/reopen');
        toast('Inspection reopened.', { type: 'success' });
        location.hash = '#/inspection/' + encodeURIComponent(inspection.id);
      } catch (error) {
        setButtonLoading(reopenButton, false);
        toast(error.message || 'Could not reopen the inspection.', { type: 'error' });
      }
    });
  }

  const details = Array.from(container.querySelectorAll('details.read-group'));
  const beforePrint = () => {
    details.forEach((detail) => {
      detail.dataset.wasOpen = String(detail.open);
      detail.open = true;
    });
  };
  const afterPrint = () => {
    details.forEach((detail) => {
      detail.open = detail.dataset.wasOpen === 'true';
      delete detail.dataset.wasOpen;
    });
  };
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);

  return () => {
    window.removeEventListener('beforeprint', beforePrint);
    window.removeEventListener('afterprint', afterPrint);
  };
}

export async function renderInspectionsList(container, user) {
  const isManager = user.role === 'manager';

  container.innerHTML =
    '<div class="view"><header class="page-head">' +
    '<div><p class="eyebrow">' +
    (isManager ? 'Inspection history' : 'Your inspections') +
    '</p><h1>Inspections</h1><p class="page-sub">' +
    (isManager
      ? 'Browse every draft and completed cleaning inspection across the hostel.'
      : 'Every inspection you start is kept here, including drafts and completed reports.') +
    '</p></div></header>' +
    '<form class="filter-bar" id="inspectionFilters">' +
    '<div class="field filter-search"><label for="filterSearch">Search</label><div class="input-wrap">' +
    icon('search', { size: 16 }) +
    '<input class="input" id="filterSearch" type="search" placeholder="' +
    (isManager ? 'Inspector name or date' : 'Date') +
    '" /></div></div>' +
    '<div class="field"><label for="filterStatus">Status</label><select class="select" id="filterStatus"><option value="">All statuses</option><option value="completed">Completed</option><option value="draft">In progress</option></select></div>' +
    '<div class="field"><label for="filterFrom">From</label><input class="input" id="filterFrom" type="date" /></div>' +
    '<div class="field"><label for="filterTo">To</label><input class="input" id="filterTo" type="date" /></div>' +
    '<div class="filter-actions"><button class="btn btn-secondary" type="button" id="clearFilters">' +
    icon('x', { size: 15 }) +
    'Clear</button><button class="btn btn-primary" type="submit">' +
    icon('filter', { size: 15 }) +
    'Apply</button></div>' +
    '</form>' +
    '<p class="list-count" id="listCount">Loading inspections…</p>' +
    '<div class="list-card" id="listRows"><div class="loading-state" style="padding:40px 16px"><span class="spinner" aria-hidden="true"></span><span>Loading inspections…</span></div></div>' +
    '<div class="load-more" id="loadMoreWrap" hidden><button class="btn btn-secondary" type="button" id="loadMore">Load more inspections</button></div>' +
    '</div>';

  const form = container.querySelector('#inspectionFilters');
  const search = container.querySelector('#filterSearch');
  const status = container.querySelector('#filterStatus');
  const from = container.querySelector('#filterFrom');
  const to = container.querySelector('#filterTo');
  const clear = container.querySelector('#clearFilters');
  const listRows = container.querySelector('#listRows');
  const listCount = container.querySelector('#listCount');
  const loadMoreWrap = container.querySelector('#loadMoreWrap');
  const loadMore = container.querySelector('#loadMore');

  let items = [];
  let total = 0;
  let requestToken = 0;
  let loadingMore = false;

  function currentQuery(offset) {
    return buildQuery({
      status: status.value,
      from: from.value,
      to: to.value,
      q: search.value.trim(),
      limit: 20,
      offset
    });
  }

  function renderRows() {
    if (!items.length) {
      const filtered = Boolean(status.value || from.value || to.value || search.value.trim());
      listRows.innerHTML =
        '<div class="empty-state">' +
        '<span class="empty-icon">' +
        icon(filtered ? 'search' : 'clipboard', { size: 23 }) +
        '</span>' +
        '<h3>' +
        (filtered ? 'No matching inspections' : 'No inspections yet') +
        '</h3>' +
        '<p>' +
        (filtered
          ? 'Try changing the filters or clearing them.'
          : isManager
            ? 'Supervisor inspections will appear here.'
            : 'Start your first inspection from the overview page.') +
        '</p>' +
        (filtered
          ? '<button class="btn btn-secondary btn-sm" type="button" data-clear-empty>Clear filters</button>'
          : '') +
        '</div>';
      listRows.querySelector('[data-clear-empty]')?.addEventListener('click', () => {
        clearFilters();
      });
    } else {
      listRows.innerHTML = items
        .map((inspection) => inspectionRow(inspection, user, { showInspector: isManager }))
        .join('');
    }

    listCount.textContent =
      total + ' inspection' + (total === 1 ? '' : 's') + (items.length < total ? ' · showing ' + items.length : '');
    loadMoreWrap.hidden = items.length >= total;
  }

  function showError(message) {
    listRows.innerHTML =
      '<div class="empty-state">' +
      '<span class="empty-icon">' +
      icon('alertTriangle', { size: 23 }) +
      '</span>' +
      '<h3>Could not load inspections</h3>' +
      '<p>' +
      escapeHtml(message) +
      '</p>' +
      '<button class="btn btn-secondary btn-sm" type="button" data-retry-list>Try again</button></div>';
    listRows.querySelector('[data-retry-list]')?.addEventListener('click', () => load(true));
    listCount.textContent = '';
    loadMoreWrap.hidden = true;
  }

  async function load(reset) {
    if (!reset && loadingMore) return;
    const token = ++requestToken;
    const offset = reset ? 0 : items.length;

    if (reset) {
      loadMoreWrap.hidden = true;
      listRows.innerHTML =
        '<div class="loading-state" style="padding:40px 16px"><span class="spinner" aria-hidden="true"></span><span>Loading inspections…</span></div>';
    } else {
      loadingMore = true;
      setButtonLoading(loadMore, true, 'Loading…');
    }

    try {
      const data = await api.get('/api/inspections' + currentQuery(offset));
      if (token !== requestToken || !container.isConnected) return;
      const fetched = data.items || [];
      items = reset ? fetched : items.concat(fetched);
      total = data.total || 0;
      renderRows();
    } catch (error) {
      if (token !== requestToken || !container.isConnected) return;
      showError(error.message || 'Please try again.');
    } finally {
      if (token === requestToken) {
        loadingMore = false;
        setButtonLoading(loadMore, false);
      }
    }
  }

  function clearFilters() {
    form.reset();
    items = [];
    total = 0;
    load(true);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    items = [];
    total = 0;
    load(true);
  });
  clear.addEventListener('click', clearFilters);
  status.addEventListener('change', () => form.requestSubmit());
  from.addEventListener('change', () => form.requestSubmit());
  to.addEventListener('change', () => form.requestSubmit());
  loadMore.addEventListener('click', () => load(false));

  await load(true);
  return null;
}

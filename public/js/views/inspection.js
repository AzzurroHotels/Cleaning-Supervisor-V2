import { api } from '../api.js';
import {
  confirmDialog,
  copyText,
  debounce,
  escapeHtml,
  formatBytes,
  formatDate,
  icon,
  openModal,
  setButtonLoading,
  toast
} from '../ui.js';
import { completionPercent, progressRing } from './components.js';
import { buildDailySummary, exportInspectionReport } from '../report.js';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FAILURE_BYTES = 60 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-m4v'
]);
const FILE_ACCEPT =
  'image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,video/mp4,video/quicktime,video/webm,video/x-m4v';

function isoNow() {
  return new Date().toISOString();
}

function findItem(inspection, groupKey, index) {
  const group = inspection.groups.find((entry) => entry.id === groupKey);
  if (!group) return null;
  const item = group.items[index];
  if (!item) return null;
  return { group, item };
}

function countGroup(group) {
  let pass = 0;
  let fail = 0;
  let unchecked = 0;
  for (const item of group.items) {
    if (item.result === 'pass') pass += 1;
    else if (item.result === 'fail') fail += 1;
    else unchecked += 1;
  }
  return { pass, fail, unchecked, total: group.items.length, checked: pass + fail };
}

function recomputeStats(inspection) {
  let pass = 0;
  let fail = 0;
  let unchecked = 0;
  let failedGroups = 0;
  let checkedGroups = 0;
  for (const group of inspection.groups) {
    const counts = countGroup(group);
    pass += counts.pass;
    fail += counts.fail;
    unchecked += counts.unchecked;
    if (counts.fail) failedGroups += 1;
    if (!counts.unchecked) checkedGroups += 1;
  }
  inspection.stats = {
    ...inspection.stats,
    pass,
    fail,
    unchecked,
    failedGroups,
    checkedGroups,
    total: inspection.stats.total || pass + fail + unchecked
  };
}

function mediaThumb(attachment, { removable = false } = {}) {
  const isVideo = attachment.mimeType.startsWith('video/');
  return (
    '<div class="upload-item" data-existing-attachment="' +
    escapeHtml(attachment.id) +
    '">' +
    '<span class="upload-thumb">' +
    (isVideo
      ? '<video src="' +
        escapeHtml(attachment.url) +
        '" preload="metadata" muted></video>'
      : '<img src="' +
        escapeHtml(attachment.url) +
        '" alt="" loading="lazy" />') +
    '</span>' +
    '<span class="upload-meta"><strong>' +
    escapeHtml(attachment.originalName) +
    '</strong><span>' +
    escapeHtml(formatBytes(attachment.size)) +
    ' · ' +
    (isVideo ? 'Video' : 'Photo') +
    '</span></span>' +
    (removable
      ? '<button class="upload-remove" type="button" data-remove-existing="' +
        escapeHtml(attachment.id) +
        '" aria-label="Remove ' +
        escapeHtml(attachment.originalName) +
        '">' +
        icon('trash', { size: 15 }) +
        '</button>'
      : '') +
    '</div>'
  );
}

export async function renderInspectionEditor(container, user, inspectionId) {
  container.innerHTML =
    '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading checklist…</span></div>';

  const result = await api.get('/api/inspections/' + encodeURIComponent(inspectionId));
  if (!container.isConnected) return null;

  let inspection = result.inspection;
  if (inspection.status !== 'draft') {
    location.replace('#/inspections/' + encodeURIComponent(inspection.id));
    return null;
  }

  const draftKey = 'allen:draft:' + inspection.id;
  const openKey = 'allen:open-groups:' + inspection.id;
  const tabKey = 'allen:active-tab:' + inspection.id;

  let pendingOps = [];
  let restored = false;
  try {
    const stored = JSON.parse(localStorage.getItem(draftKey));
    if (
      stored &&
      stored.inspection?.id === inspection.id &&
      stored.inspection.status === 'draft' &&
      Array.isArray(stored.pendingOps) &&
      stored.pendingOps.length
    ) {
      inspection = stored.inspection;
      pendingOps = stored.pendingOps;
      restored = true;
    }
  } catch {
    localStorage.removeItem(draftKey);
  }

  recomputeStats(inspection);

  const floors = [...new Set(inspection.groups.map((group) => group.floor))];
  let activeTab = sessionStorage.getItem(tabKey);
  if (activeTab !== 'finish' && !floors.includes(activeTab)) {
    const failedFloor = floors.find((floor) =>
      inspection.groups.some((group) => group.floor === floor && countGroup(group).fail)
    );
    const uncheckedFloor = floors.find((floor) =>
      inspection.groups.some((group) => group.floor === floor && countGroup(group).unchecked)
    );
    activeTab = failedFloor || uncheckedFloor || floors[0];
  }

  let search = '';
  let filter = 'all';
  let openGroups;
  try {
    const saved = JSON.parse(sessionStorage.getItem(openKey));
    openGroups = new Set(Array.isArray(saved) ? saved : []);
  } catch {
    openGroups = new Set();
  }
  for (const group of inspection.groups) {
    if (countGroup(group).fail) openGroups.add(group.id);
  }
  if (!openGroups.size) {
    const first = inspection.groups.find(
      (group) => group.floor === activeTab && countGroup(group).unchecked
    );
    if (first) openGroups.add(first.id);
  }

  let saveState = restored ? 'saving' : 'saved';
  let flushPromise = null;
  let destroyed = false;
  let activeModal = null;
  let previewUrls = [];

  const saveHandover = debounce((value) => {
    enqueue({ kind: 'patch', payload: { handover: value } });
  }, 650);

  function saveOpenGroups() {
    try {
      sessionStorage.setItem(openKey, JSON.stringify([...openGroups]));
    } catch {
      /* Session storage can be unavailable; opening state is non-critical. */
    }
  }

  function persistDraft() {
    try {
      if (!pendingOps.length) {
        localStorage.removeItem(draftKey);
        return;
      }
      localStorage.setItem(
        draftKey,
        JSON.stringify({ inspection, pendingOps, savedAt: Date.now() })
      );
    } catch {
      /* Local storage may be full or blocked; the UI still reports sync state. */
    }
  }

  function setSaveState(state) {
    saveState = state;
    renderSaveIndicator();
    renderOfflineBanner();
  }

  async function runQueue() {
    if (!pendingOps.length) {
      setSaveState('saved');
      return true;
    }

    setSaveState('saving');
    while (pendingOps.length && !destroyed) {
      const operation = pendingOps[0];
      try {
        if (operation.kind === 'result') {
          await api.put(
            '/api/inspections/' +
              encodeURIComponent(inspection.id) +
              '/results/' +
              encodeURIComponent(operation.groupKey) +
              '/' +
              operation.index,
            operation.payload
          );
        } else {
          await api.patch('/api/inspections/' + encodeURIComponent(inspection.id), operation.payload);
        }
        pendingOps.shift();
        persistDraft();
      } catch (error) {
        if (error.status === 0 || error.status >= 500) {
          setSaveState('offline');
          persistDraft();
          return false;
        }
        pendingOps.shift();
        persistDraft();
        toast(error.message || 'A change could not be saved.', { type: 'error' });
      }
    }

    if (!pendingOps.length) {
      setSaveState('saved');
      persistDraft();
      return true;
    }
    setSaveState('offline');
    persistDraft();
    return false;
  }

  function flushQueue() {
    if (!flushPromise) {
      flushPromise = runQueue()
        .catch(() => false)
        .finally(() => {
          flushPromise = null;
          if (pendingOps.length && saveState !== 'offline') queueMicrotask(flushQueue);
        });
    }
    return flushPromise;
  }

  function enqueue(operation) {
    pendingOps.push(operation);
    persistDraft();
    setSaveState('saving');
    flushQueue();
  }

  const handleOnline = () => {
    if (pendingOps.length) flushQueue();
  };
  const handleOffline = () => {
    if (pendingOps.length) setSaveState('offline');
  };
  const beforeUnload = (event) => {
    if (pendingOps.length) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  window.addEventListener('beforeunload', beforeUnload);

  container.innerHTML =
    '<div class="view inspection-editor">' +
    '<div class="inspection-bar">' +
    '<div class="inspection-bar-left">' +
    '<a class="btn btn-icon btn-secondary" href="#/" aria-label="Back to overview">' +
    icon('chevronLeft', { size: 18 }) +
    '</a>' +
    '<div><h1>Cleaning inspection</h1><p id="inspectionBarSub"></p></div>' +
    '</div>' +
    '<div class="inspection-bar-center">' +
    '<div class="progress-ring" id="headerRing" style="--ring-value:0" role="img" aria-label="Checklist progress"><span>0%</span></div>' +
    '<div class="bar-counts"><strong id="barChecked">0 of 0</strong><span id="barBreakdown">0 failed</span></div>' +
    '</div>' +
    '<div class="inspection-bar-right">' +
    '<span class="save-pill" id="savePill" role="status" aria-live="polite">' +
    icon('cloud', { size: 13 }) +
    '<span>All changes saved</span></span>' +
    '<button class="btn btn-primary btn-sm" type="button" data-tab="finish">' +
    icon('flag', { size: 14 }) +
    'Finish</button>' +
    '</div>' +
    '</div>' +
    '<div class="offline-banner" id="offlineBanner" hidden>' +
    icon('cloudOff', { size: 17 }) +
    '<span id="offlineText">Changes are saved on this device and will sync when the connection returns.</span>' +
    '<button class="btn btn-sm btn-secondary" type="button" data-retry-sync>Retry sync</button>' +
    '</div>' +
    '<div class="inspection-meta">' +
    '<div class="field"><label for="inspectionDate">Inspection date</label><input class="input" id="inspectionDate" type="date" value="' +
    escapeHtml(inspection.date) +
    '" /></div>' +
    '<p class="meta-note">' +
    icon('cloud', { size: 12 }) +
    ' Autosaves to the hostel server with a local backup on this device.</p>' +
    '</div>' +
    '<div class="floor-tabs" id="floorTabs" role="tablist" aria-label="Checklist sections"></div>' +
    '<div class="inspection-toolbar" id="inspectionToolbar">' +
    '<div class="toolbar-search">' +
    icon('search', { size: 16 }) +
    '<input class="input" id="itemSearch" type="search" placeholder="Search this floor or a finding" aria-label="Search checklist items" />' +
    '</div>' +
    '<div class="filter-pills" role="group" aria-label="Filter checks">' +
    '<button class="filter-pill is-active" type="button" data-filter="all">All</button>' +
    '<button class="filter-pill" type="button" data-filter="unchecked">Unchecked</button>' +
    '<button class="filter-pill" type="button" data-filter="failed">Failed</button>' +
    '</div>' +
    '<button class="btn btn-secondary btn-sm toolbar-expand" type="button" data-expand-all>Expand all</button>' +
    '</div>' +
    '<div id="tabContent" role="tabpanel"></div>' +
    '</div>';

  const tabContent = container.querySelector('#tabContent');
  const toolbar = container.querySelector('#inspectionToolbar');
  const searchInput = container.querySelector('#itemSearch');
  const dateInput = container.querySelector('#inspectionDate');
  const tabsContainer = container.querySelector('#floorTabs');

  function renderSaveIndicator() {
    const pill = container.querySelector('#savePill');
    if (!pill) return;
    if (saveState === 'saving') {
      pill.className = 'save-pill is-saving';
      pill.innerHTML = icon('cloud', { size: 13 }) + '<span>Saving…</span>';
      pill.setAttribute('aria-label', 'Saving changes');
      pill.title = 'Saving changes';
    } else if (saveState === 'offline') {
      pill.className = 'save-pill is-offline';
      pill.innerHTML = icon('cloudOff', { size: 13 }) + '<span>Offline · saved locally</span>';
      pill.setAttribute('aria-label', 'Offline. Changes saved on this device.');
      pill.title = 'Offline. Changes saved on this device.';
    } else {
      pill.className = 'save-pill';
      pill.innerHTML = icon('cloud', { size: 13 }) + '<span>All changes saved</span>';
      pill.setAttribute('aria-label', 'All changes saved');
      pill.title = 'All changes saved';
    }
  }

  function renderOfflineBanner() {
    const banner = container.querySelector('#offlineBanner');
    if (!banner) return;
    const show = saveState === 'offline' && pendingOps.length;
    banner.hidden = !show;
  }

  function renderTabs() {
    const failedTotal = inspection.groups.reduce(
      (sum, group) => sum + countGroup(group).fail,
      0
    );
    tabsContainer.innerHTML =
      floors
        .map((floor) => {
          const groups = inspection.groups.filter((group) => group.floor === floor);
          const totals = groups.reduce(
            (acc, group) => {
              const counts = countGroup(group);
              acc.fail += counts.fail;
              acc.checked += counts.checked;
              acc.total += counts.total;
              acc.unchecked += counts.unchecked;
              return acc;
            },
            { fail: 0, checked: 0, total: 0, unchecked: 0 }
          );
          const label = floor.replace(' floor', '');
          const detail = totals.fail
            ? totals.fail + ' failed'
            : totals.unchecked
              ? totals.unchecked + ' left'
              : 'Done';
          return (
            '<button class="floor-tab ' +
            (activeTab === floor ? 'is-active' : '') +
            '" type="button" role="tab" aria-selected="' +
            (activeTab === floor) +
            '" data-tab="' +
            escapeHtml(floor) +
            '"><strong>' +
            escapeHtml(label) +
            '</strong><span class="' +
            (totals.fail ? 'tab-alert' : '') +
            '">' +
            escapeHtml(detail) +
            '</span></button>'
          );
        })
        .join('') +
      '<button class="floor-tab ' +
      (activeTab === 'finish' ? 'is-active' : '') +
      '" type="button" role="tab" aria-selected="' +
      (activeTab === 'finish') +
      '" data-tab="finish"><strong>Finish</strong><span class="' +
      (failedTotal ? 'tab-alert' : '') +
      '">' +
      (failedTotal ? failedTotal + ' failed' : 'Sign off') +
      '</span></button>';
  }

  function syncToolbar() {
    toolbar.hidden = activeTab === 'finish';
    container.querySelectorAll('[data-filter]').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.filter === filter);
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    });
    const floorGroups = inspection.groups.filter((group) => group.floor === activeTab);
    const allOpen =
      floorGroups.length > 0 && floorGroups.every((group) => openGroups.has(group.id));
    const expandButton = container.querySelector('[data-expand-all]');
    if (expandButton) {
      expandButton.textContent = allOpen ? 'Collapse all' : 'Expand all';
      expandButton.setAttribute('aria-pressed', String(allOpen));
    }
  }

  function updateHeader() {
    recomputeStats(inspection);
    const pct = completionPercent(inspection.stats);
    const ring = container.querySelector('#headerRing');
    if (ring) {
      ring.style.setProperty('--ring-value', String(Math.max(0, Math.min(100, pct))));
      ring.querySelector('span').textContent = Math.round(pct) + '%';
      ring.setAttribute('aria-label', Math.round(pct) + ' percent of checks completed');
    }
    const checked = inspection.stats.pass + inspection.stats.fail;
    const barChecked = container.querySelector('#barChecked');
    const barBreakdown = container.querySelector('#barBreakdown');
    if (barChecked) barChecked.textContent = checked + ' of ' + inspection.stats.total;
    if (barBreakdown) {
      barBreakdown.textContent =
        inspection.stats.fail + ' failed · ' + inspection.stats.unchecked + ' left';
    }
    const sub = container.querySelector('#inspectionBarSub');
    if (sub) {
      sub.textContent =
        formatDate(inspection.date, 'medium') +
        ' · ' +
        inspection.inspector.name +
        ' · ' +
        (inspection.stats.failedGroups
          ? inspection.stats.failedGroups +
            ' section' +
            (inspection.stats.failedGroups === 1 ? '' : 's') +
            ' with failures'
          : 'no failures yet');
    }
    dateInput.value = inspection.date;
    renderTabs();
    renderSaveIndicator();
    renderOfflineBanner();
  }

  function itemMatches(item, group) {
    if (filter === 'unchecked' && item.result !== null) return false;
    if (filter === 'failed' && item.result !== 'fail') return false;
    if (!search) return true;
    const haystack = [
      item.text,
      item.failure?.location || '',
      item.failure?.notes || '',
      group.name,
      group.floor
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(search.toLowerCase());
  }

  function checkRow(group, item) {
    const selected = item.result;
    const rechecked = selected === 'pass' && item.failure?.recheckedAt;
    const preview =
      item.failure && (selected === 'fail' || item.failure.recordedAt)
        ? '<div class="failure-preview ' +
          (rechecked ? 'is-rechecked' : '') +
          '">' +
          icon(rechecked ? 'checkCircle' : 'alertTriangle', { size: 13 }) +
          '<div class="preview-copy"><strong>' +
          escapeHtml(item.failure.location) +
          '</strong> — ' +
          escapeHtml(item.failure.notes) +
          '<div class="preview-actions"><button class="preview-link" type="button" data-edit-failure data-group="' +
          escapeHtml(group.id) +
          '" data-index="' +
          item.index +
          '">View / edit finding</button>' +
          (item.failure.attachments?.length
            ? '<span class="preview-meta">' +
              icon('camera', { size: 11 }) +
              ' ' +
              item.failure.attachments.length +
              '</span>'
            : '') +
          (rechecked ? '<span class="preview-meta">Rechecked</span>' : '') +
          '</div></div></div>'
        : '';

    return (
      '<div class="check-row ' +
      (selected ? 'is-' + selected : '') +
      '" data-item-key="' +
      escapeHtml(group.id + ':' + item.index) +
      '">' +
      '<div class="check-copy"><div class="check-text"><span class="check-mark">' +
      icon(
        selected === 'pass' ? 'check' : selected === 'fail' ? 'x' : 'circle',
        { size: 11 }
      ) +
      '</span><span>' +
      escapeHtml(item.text) +
      '</span></div>' +
      preview +
      '</div>' +
      '<div class="result-control" role="group" aria-label="Result for: ' +
      escapeHtml(item.text) +
      '">' +
      '<button class="result-btn pass ' +
      (selected === 'pass' ? 'is-selected' : '') +
      '" type="button" data-result="pass" data-group="' +
      escapeHtml(group.id) +
      '" data-index="' +
      item.index +
      '" aria-pressed="' +
      (selected === 'pass') +
      '" aria-label="Pass: ' +
      escapeHtml(item.text) +
      '">' +
      icon('check', { size: 12 }) +
      'Pass</button>' +
      '<button class="result-btn fail ' +
      (selected === 'fail' ? 'is-selected' : '') +
      '" type="button" data-result="fail" data-group="' +
      escapeHtml(group.id) +
      '" data-index="' +
      item.index +
      '" aria-pressed="' +
      (selected === 'fail') +
      '" aria-label="Fail: ' +
      escapeHtml(item.text) +
      '">' +
      icon('x', { size: 12 }) +
      'Fail</button>' +
      '</div>' +
      '</div>'
    );
  }

  function groupMarkup(group) {
    const counts = countGroup(group);
    const visibleItems = group.items.filter((item) => itemMatches(item, group));
    if (!visibleItems.length) return '';
    const open = openGroups.has(group.id);
    const detail = counts.fail
      ? counts.fail + ' failed'
      : counts.unchecked
        ? counts.unchecked + ' not checked'
        : 'All checks complete';
    return (
      '<section class="group-card ' +
      (counts.fail ? 'has-fail ' : '') +
      (open ? 'is-open' : '') +
      '" data-group-card="' +
      escapeHtml(group.id) +
      '">' +
      '<button class="group-head" type="button" data-group-toggle="' +
      escapeHtml(group.id) +
      '" aria-expanded="' +
      open +
      '">' +
      '<span class="group-icon">' +
      icon(group.icon || 'clipboard', { size: 17 }) +
      '</span>' +
      '<span class="group-main"><h2>' +
      escapeHtml(group.name) +
      '</h2><p>' +
      escapeHtml(group.subtitle || group.floor) +
      '</p></span>' +
      '<span class="group-progress"><span class="progress-track"><span class="progress-fill' +
      (counts.fail ? ' is-danger' : '') +
      '" style="width:' +
      (counts.total ? (counts.checked / counts.total) * 100 : 0) +
      '%"></span></span><span>' +
      detail +
      '</span></span>' +
      '<span class="group-badge">' +
      (counts.fail
        ? '<span class="badge badge-danger">' + counts.fail + ' failed</span>'
        : counts.unchecked
          ? '<span class="badge badge-neutral">' + counts.unchecked + ' left</span>'
          : '<span class="badge badge-success">Done</span>') +
      '</span>' +
      '<span class="group-chevron">' +
      icon('chevronDown', { size: 16 }) +
      '</span>' +
      '</button>' +
      '<div class="group-body">' +
      visibleItems.map((item) => checkRow(group, item)).join('') +
      '</div>' +
      '</section>'
    );
  }

  function renderGroups() {
    const groups = inspection.groups.filter((group) => group.floor === activeTab);
    const html = groups.map(groupMarkup).join('');
    tabContent.innerHTML = html
      ? '<div class="groups-list">' + html + '</div>'
      : '<div class="search-empty">' +
        icon('search', { size: 20 }) +
        '<p style="margin-top:6px">No checks match this search or filter on ' +
        escapeHtml(activeTab) +
        '.</p></div>';
    syncToolbar();
  }

  function renderFinish() {
    const currentFailures = [];
    for (const group of inspection.groups) {
      for (const item of group.items) {
        if (item.result === 'fail') currentFailures.push({ group, item });
      }
    }
    const pct = completionPercent(inspection.stats);
    const failurePreview = currentFailures.length
      ? currentFailures
          .slice(0, 8)
          .map(
            ({ group, item }) =>
              '<button class="finish-finding" type="button" data-goto-failure data-floor="' +
              escapeHtml(group.floor) +
              '" data-group="' +
              escapeHtml(group.id) +
              '" data-index="' +
              item.index +
              '">' +
              icon('alertTriangle', { size: 14 }) +
              '<span><strong>' +
              escapeHtml(item.text) +
              '</strong><span>' +
              escapeHtml(group.name) +
              ' · ' +
              escapeHtml(item.failure?.location || '') +
              '</span></span></button>'
          )
          .join('')
      : '<p class="action-note" style="margin-top:12px">No outstanding failures. Nice work.</p>';

    tabContent.innerHTML =
      '<div class="finish-grid">' +
      '<div class="finish-main">' +
      '<section class="card">' +
      '<div class="finish-summary-top">' +
      progressRing(pct, { large: true }) +
      '<div><h2>' +
      (inspection.stats.unchecked
        ? 'Keep going'
        : inspection.stats.fail
          ? 'Review findings'
          : 'Ready to finish') +
      '</h2><p>' +
      (inspection.stats.unchecked
        ? inspection.stats.unchecked +
          ' check' +
          (inspection.stats.unchecked === 1 ? '' : 's') +
          ' still not checked.'
        : 'Every checklist item has a result.') +
      '</p></div></div>' +
      '<div class="finish-counts">' +
      '<div class="mini-count pass"><span>Passed</span><strong>' +
      inspection.stats.pass +
      '</strong></div>' +
      '<div class="mini-count fail"><span>Failed</span><strong>' +
      inspection.stats.fail +
      '</strong></div>' +
      '<div class="mini-count"><span>Left</span><strong>' +
      inspection.stats.unchecked +
      '</strong></div>' +
      '</div>' +
      (currentFailures.length
        ? '<div class="finish-findings">' +
          '<p class="eyebrow" style="margin:0">Outstanding findings</p>' +
          failurePreview +
          (currentFailures.length > 8
            ? '<p class="action-note">' +
              (currentFailures.length - 8) +
              ' more finding(s) are shown in the full report.</p>'
            : '') +
          '</div>'
        : '') +
      '</section>' +
      '<section class="card">' +
      '<div class="card-head"><div><h2>Before finishing</h2><p>Confirm the closeout checks below.</p></div></div>' +
      '<div class="signoff-form">' +
      '<label class="check-card"><input type="checkbox" id="correctionsRechecked" ' +
      (inspection.correctionsRechecked ? 'checked' : '') +
      ' /><span>Missed cleaning has been corrected and checked again.</span></label>' +
      '<label class="check-card"><input type="checkbox" id="handoverDone" ' +
      (inspection.handoverDone ? 'checked' : '') +
      ' /><span>Outstanding cleaning, maintenance and safety issues have been passed to management.</span></label>' +
      '<div class="field"><label for="handoverNotes">Anything still outstanding?</label><textarea class="textarea" id="handoverNotes" maxlength="4000" placeholder="Area or room, what needs fixing, who is handling it and when.">' +
      escapeHtml(inspection.handover) +
      '</textarea></div>' +
      '</div>' +
      '</section>' +
      '</div>' +
      '<div class="finish-side">' +
      '<section class="card">' +
      '<div class="card-head"><div><h2>Reports</h2><p>Share the daily update or save a full copy.</p></div></div>' +
      '<div class="action-stack">' +
      '<button class="btn btn-secondary" type="button" data-copy-summary>' +
      icon('copy', { size: 16 }) +
      'Copy daily update</button>' +
      '<button class="btn btn-secondary" type="button" data-export-report>' +
      icon('download', { size: 16 }) +
      'Save report with attachments</button>' +
      '<a class="btn btn-secondary" href="#/inspections/' +
      encodeURIComponent(inspection.id) +
      '">' +
      icon('fileText', { size: 16 }) +
      'View full report</a>' +
      '</div>' +
      '<p class="action-note">Reports include every check, failure note and attachment.</p>' +
      '</section>' +
      '<section class="card">' +
      '<div class="card-head"><div><h2>Complete inspection</h2><p>Lock the report and send it to management.</p></div></div>' +
      '<button class="btn btn-primary btn-lg btn-block" type="button" data-complete>' +
      icon('checkCircle', { size: 18 }) +
      'Complete inspection</button>' +
      '<p class="action-note">You can reopen a completed inspection from its report if something needs correcting.</p>' +
      '<div class="danger-zone"><button class="btn btn-danger btn-sm" type="button" data-discard-draft>' +
      icon('trash', { size: 14 }) +
      'Discard draft</button></div>' +
      '</section>' +
      '</div>' +
      '</div>';
    syncToolbar();
  }

  function renderTabContent() {
    if (activeTab === 'finish') renderFinish();
    else renderGroups();
  }

  function applyResultLocally(groupKey, index, nextResult, failureInput) {
    const found = findItem(inspection, groupKey, index);
    if (!found) return;
    const { item } = found;
    const previous = item.result;
    const now = isoNow();
    if (nextResult === 'fail') {
      item.result = 'fail';
      item.failure = {
        location: failureInput.location,
        notes: failureInput.notes,
        recordedAt:
          previous === 'fail' && item.failure?.recordedAt ? item.failure.recordedAt : now,
        recheckedAt: null,
        attachments: item.failure?.attachments || []
      };
    } else {
      item.result = 'pass';
      if (previous === 'fail' && item.failure) item.failure.recheckedAt = now;
    }
    item.updatedAt = now;
    inspection.updatedAt = now;
    recomputeStats(inspection);
    openGroups.add(groupKey);
    saveOpenGroups();
  }

  function focusResult(groupKey, index, result) {
    requestAnimationFrame(() => {
      const button = container.querySelector(
        '[data-result="' +
          result +
          '"][data-group="' +
          groupKey +
          '"][data-index="' +
          index +
          '"]'
      );
      if (button) button.focus();
      else container.querySelector('[data-group-toggle="' + groupKey + '"]')?.focus();
    });
  }

  async function handleResultClick(button) {
    const groupKey = button.dataset.group;
    const index = Number(button.dataset.index);
    const wanted = button.dataset.result;
    const found = findItem(inspection, groupKey, index);
    if (!found) return;
    const { item } = found;

    if (wanted === 'fail') {
      openFailureModal(groupKey, index);
      return;
    }

    if (item.result === 'pass') return;

    if (item.result === 'fail') {
      const confirmed = await confirmDialog({
        title: 'Mark as corrected?',
        message:
          'This item was marked as failed. Only pass it after the issue has been corrected and reinspected.',
        confirmLabel: 'Yes, mark passed',
        cancelLabel: 'Not yet',
        iconName: 'checkCircle'
      });
      if (!confirmed) return;
      toast('Marked as passed after recheck.', { type: 'success' });
    }

    applyResultLocally(groupKey, index, 'pass');
    updateHeader();
    renderTabContent();
    focusResult(groupKey, index, 'pass');
    enqueue({
      kind: 'result',
      groupKey,
      index,
      payload: { result: 'pass' }
    });
  }

  function openFailureModal(groupKey, index) {
    const found = findItem(inspection, groupKey, index);
    if (!found) return;
    const { group, item } = found;
    const existingFailure = item.failure || null;

    const draft = {
      location: existingFailure?.location || group.floor + ' · ' + group.name,
      notes: existingFailure?.notes || '',
      existing: existingFailure?.attachments ? [...existingFailure.attachments] : [],
      removed: new Set(),
      files: []
    };
    let busy = false;
    previewUrls = [];

    const modal = openModal({
      title: existingFailure ? 'Update finding' : 'Record a failure',
      subtitle: group.floor + ' · ' + group.name,
      size: 'wide',
      body:
        '<form class="modal-form" id="failureForm" novalidate>' +
        '<div class="failed-item-context">' +
        icon(group.icon || 'alertTriangle', { size: 17 }) +
        '<div><span>Checklist item</span><strong>' +
        escapeHtml(item.text) +
        '</strong></div></div>' +
        '<p class="form-error" id="failureFormError" role="alert"></p>' +
        '<div class="field"><label for="failureLocation">Room, area or exact spot</label><input class="input" id="failureLocation" type="text" maxlength="240" value="' +
        escapeHtml(draft.location) +
        '" placeholder="e.g. Room 12, upper bunk" required /><span class="field-hint">Be specific so the issue can be found quickly.</span></div>' +
        '<div class="field"><label for="failureNotes">What failed?</label><textarea class="textarea" id="failureNotes" maxlength="2000" placeholder="Describe what needs cleaning, fixing or reinspection." required>' +
        escapeHtml(draft.notes) +
        '</textarea></div>' +
        '<div class="existing-media" id="existingMediaSection" ' +
        (draft.existing.length ? '' : 'hidden') +
        '><div class="existing-media-head"><span>Attached evidence</span><span id="existingMediaCount"></span></div><div class="upload-list" id="existingMediaList"></div></div>' +
        '<label class="upload-zone" for="failureFiles">' +
        '<span class="upload-icon">' +
        icon('camera', { size: 18 }) +
        '</span><strong>Add photos or videos</strong>' +
        '<small>Optional · up to 20 MB per file and 60 MB per failure</small>' +
        '<input id="failureFiles" type="file" accept="' +
        FILE_ACCEPT +
        '" multiple />' +
        '</label>' +
        '<div class="upload-list" id="pendingMediaList"></div>' +
        '<p class="modal-note">' +
        icon('lock', { size: 12 }) +
        '<span>Evidence is stored on the hostel server and included in reports.</span></p>' +
        '</form>',
      footer:
        '<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>' +
        '<button class="btn btn-primary" type="submit" form="failureForm" id="saveFailureSubmit">' +
        icon('checkCircle', { size: 16 }) +
        'Save failure</button>',
      onClose: () => {
        for (const url of previewUrls) URL.revokeObjectURL(url);
        previewUrls = [];
        activeModal = null;
      }
    });
    activeModal = modal;
    const dialog = modal.dialog;
    const form = dialog.querySelector('#failureForm');
    const errorBox = dialog.querySelector('#failureFormError');
    const locationInput = dialog.querySelector('#failureLocation');
    const notesInput = dialog.querySelector('#failureNotes');
    const fileInput = dialog.querySelector('#failureFiles');
    const existingSection = dialog.querySelector('#existingMediaSection');
    const existingList = dialog.querySelector('#existingMediaList');
    const existingCount = dialog.querySelector('#existingMediaCount');
    const pendingList = dialog.querySelector('#pendingMediaList');
    const submit = dialog.querySelector('#saveFailureSubmit');

    locationInput.focus();

    const initialLocation = draft.location;
    const initialNotes = draft.notes;
    let confirmingDiscard = false;

    function isDirty() {
      return (
        locationInput.value.trim() !== initialLocation ||
        notesInput.value.trim() !== initialNotes ||
        draft.removed.size > 0 ||
        draft.files.length > 0
      );
    }

    async function requestClose() {
      if (busy || confirmingDiscard) return;
      if (!isDirty()) {
        modal.close();
        return;
      }
      confirmingDiscard = true;
      try {
        const discard = await confirmDialog({
          title: 'Discard this finding?',
          message:
            'Your edits to the location, notes and attachments will not be saved.',
          confirmLabel: 'Discard changes',
          cancelLabel: 'Keep editing',
          danger: true,
          iconName: 'trash'
        });
        if (discard) modal.close();
      } finally {
        confirmingDiscard = false;
      }
    }

    dialog.querySelectorAll('[data-modal-close]').forEach((button) => {
      const replacement = button.cloneNode(true);
      button.replaceWith(replacement);
      replacement.addEventListener('click', () => requestClose());
    });

    dialog.addEventListener(
      'click',
      (event) => {
        if (event.target !== dialog) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!busy) requestClose();
      },
      true
    );
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!busy) requestClose();
    });

    function showError(message) {
      errorBox.textContent = message;
      errorBox.classList.add('is-visible');
      errorBox.scrollIntoView({ block: 'nearest' });
    }

    function clearError() {
      errorBox.textContent = '';
      errorBox.classList.remove('is-visible');
    }

    function totalBytes() {
      const existing = draft.existing
        .filter((attachment) => !draft.removed.has(attachment.id))
        .reduce((sum, attachment) => sum + Number(attachment.size || 0), 0);
      const pending = draft.files.reduce((sum, entry) => sum + entry.file.size, 0);
      return existing + pending;
    }

    function renderMediaLists() {
      const visible = draft.existing.filter((attachment) => !draft.removed.has(attachment.id));
      existingSection.hidden = !visible.length;
      existingCount.textContent = visible.length + ' file' + (visible.length === 1 ? '' : 's');
      existingList.innerHTML = visible.map((attachment) => mediaThumb(attachment, { removable: true })).join('');

      pendingList.innerHTML = draft.files
        .map(
          (entry) =>
            '<div class="upload-item" data-pending-id="' +
            entry.uid +
            '"><span class="upload-thumb">' +
            (entry.file.type.startsWith('video/')
              ? '<video src="' + entry.url + '" preload="metadata" muted></video>'
              : '<img src="' + entry.url + '" alt="" />') +
            '</span><span class="upload-meta"><strong>' +
            escapeHtml(entry.file.name) +
            '</strong><span>' +
            escapeHtml(formatBytes(entry.file.size)) +
            ' · ' +
            (entry.uploading ? 'Uploading…' : 'Ready to upload') +
            '</span></span>' +
            (entry.uploading
              ? '<span class="spinner" style="width:15px;height:15px"></span>'
              : '<button class="upload-remove" type="button" data-remove-pending="' +
                entry.uid +
                '" aria-label="Remove ' +
                escapeHtml(entry.file.name) +
                '">' +
                icon('trash', { size: 15 }) +
                '</button>') +
            '</div>'
        )
        .join('');
    }

    function setBusy(value) {
      busy = value;
      submit.disabled = value;
      fileInput.disabled = value;
      dialog.querySelectorAll('[data-modal-close]').forEach((button) => {
        button.disabled = value;
      });
      if (value) setButtonLoading(submit, true, 'Saving…');
      else setButtonLoading(submit, false);
    }

    async function processMedia() {
      let mediaFailed = false;
      for (const attachmentId of [...draft.removed]) {
        try {
          await api.delete(
            '/api/inspections/' +
              encodeURIComponent(inspection.id) +
              '/attachments/' +
              encodeURIComponent(attachmentId)
          );
          draft.existing = draft.existing.filter((element) => element.id !== attachmentId);
          draft.removed.delete(attachmentId);
          const localItem = findItem(inspection, groupKey, index)?.item;
          if (localItem?.failure) {
            localItem.failure.attachments = (localItem.failure.attachments || []).filter(
              (element) => element.id !== attachmentId
            );
          }
          renderMediaLists();
        } catch (error) {
          if (error.status === 404) {
            draft.removed.delete(attachmentId);
            continue;
          }
          mediaFailed = true;
        }
      }

      for (const entry of [...draft.files]) {
        entry.uploading = true;
        renderMediaLists();
        try {
          const formData = new FormData();
          formData.append('files', entry.file);
          const response = await api.upload(
            '/api/inspections/' +
              encodeURIComponent(inspection.id) +
              '/attachments?groupKey=' +
              encodeURIComponent(groupKey) +
              '&itemIndex=' +
              index,
            formData
          );
          const localItem = findItem(inspection, groupKey, index)?.item;
          if (localItem?.failure) {
            localItem.failure.attachments = (localItem.failure.attachments || []).concat(
              response.attachments || []
            );
          }
          const position = draft.files.indexOf(entry);
          if (position >= 0) draft.files.splice(position, 1);
          URL.revokeObjectURL(entry.url);
          renderMediaLists();
        } catch (error) {
          entry.uploading = false;
          mediaFailed = true;
          renderMediaLists();
          showError(error.message || 'One or more files could not be uploaded. Try again.');
          break;
        }
      }

      return !mediaFailed;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (busy) return;
      clearError();

      const location = locationInput.value.trim();
      const notes = notesInput.value.trim();
      if (!location || !notes) {
        showError('Add the location and describe what failed.');
        (!location ? locationInput : notesInput).focus();
        return;
      }
      if (totalBytes() > MAX_FAILURE_BYTES) {
        showError('Photos and videos for one failure must total 60 MB or less.');
        return;
      }

      setBusy(true);
      applyResultLocally(groupKey, index, 'fail', { location, notes });
      updateHeader();
      renderTabContent();
      enqueue({
        kind: 'result',
        groupKey,
        index,
        payload: { result: 'fail', location, notes }
      });

      const saved = await flushQueue();
      if (!saved) {
        setBusy(false);
        showError(
          'You are offline. This finding is saved on this device and will sync when the connection returns. Keep this window open to add photos, or cancel and add them later.'
        );
        return;
      }

      const mediaOk = await processMedia();
      setBusy(false);
      persistDraft();
      if (!mediaOk) {
        showError('The finding was saved, but some evidence could not be uploaded. Try again.');
        return;
      }

      modal.close();
      toast(existingFailure ? 'Finding updated.' : 'Failure recorded.', { type: 'success' });
      renderTabContent();
      focusResult(groupKey, index, 'fail');
    });

    dialog.addEventListener('click', (event) => {
      if (busy) return;
      const removeExisting = event.target.closest('[data-remove-existing]');
      if (removeExisting) {
        draft.removed.add(removeExisting.dataset.removeExisting);
        renderMediaLists();
        return;
      }
      const removePending = event.target.closest('[data-remove-pending]');
      if (removePending) {
        const entry = draft.files.find((element) => element.uid === removePending.dataset.removePending);
        if (entry) {
          URL.revokeObjectURL(entry.url);
          draft.files = draft.files.filter((element) => element.uid !== entry.uid);
          renderMediaLists();
        }
      }
    });

    fileInput.addEventListener('change', () => {
      if (busy) return;
      clearError();
      const selected = Array.from(fileInput.files || []);
      fileInput.value = '';
      const errors = [];
      for (const file of selected) {
        if (!ALLOWED_TYPES.has(file.type)) {
          errors.push(file.name + ' is not a supported photo or video.');
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          errors.push(file.name + ' is larger than 20 MB.');
          continue;
        }
        if (totalBytes() + file.size > MAX_FAILURE_BYTES) {
          errors.push('Photos and videos must total 60 MB or less.');
          break;
        }
        const url = URL.createObjectURL(file);
        previewUrls.push(url);
        draft.files.push({
          uid: Math.random().toString(36).slice(2) + Date.now().toString(36),
          file,
          url,
          uploading: false
        });
      }
      renderMediaLists();
      if (errors.length) showError(errors[0]);
    });

    renderMediaLists();
  }

  async function completeInspection(button) {
    saveHandover.flush();
    if (pendingOps.length) {
      const flushed = await flushQueue();
      if (!flushed) {
        toast('Reconnect to sync your remaining changes before completing.', { type: 'error' });
        return;
      }
    }

    const unchecked = inspection.stats.unchecked;
    const failed = inspection.stats.fail;
    const message = unchecked
      ? unchecked +
        ' item' +
        (unchecked === 1 ? ' has' : 's have') +
        ' not been checked. They will appear as not checked in the report.' +
        (failed ? ' ' + failed + ' failure(s) are still outstanding.' : '')
      : 'All checks have a result.' +
        (failed ? ' ' + failed + ' failure(s) are still outstanding.' : ' No failures remain.') +
        ' The report will be locked.';

    const confirmed = await confirmDialog({
      title: 'Complete this inspection?',
      message,
      confirmLabel: 'Complete inspection',
      cancelLabel: 'Keep editing',
      iconName: 'checkCircle'
    });
    if (!confirmed) return;

    setButtonLoading(button, true, 'Completing…');
    try {
      const response = await api.post(
        '/api/inspections/' + encodeURIComponent(inspection.id) + '/complete'
      );
      inspection = response.inspection;
      toast('Inspection completed. The report is ready to share.', { type: 'success' });
      location.hash = '#/inspections/' + encodeURIComponent(inspection.id);
    } catch (error) {
      setButtonLoading(button, false);
      toast(error.message || 'Could not complete the inspection.', { type: 'error' });
    }
  }

  async function copySummary() {
    saveHandover.flush();
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
        '<textarea class="textarea" readonly rows="18" style="min-height:340px">' +
        escapeHtml(summary) +
        '</textarea>',
      footer: '<button class="btn btn-primary" type="button" data-modal-close>Close</button>',
      size: 'wide'
    });
  }

  async function exportReport(button) {
    saveHandover.flush();
    if (pendingOps.length) {
      const flushed = await flushQueue();
      if (!flushed) {
        toast('Some changes are still local. Reconnect before exporting the report.', {
          type: 'error'
        });
        return;
      }
    }
    setButtonLoading(button, true, 'Preparing…');
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
      setButtonLoading(button, false);
    }
  }

  container.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) {
      const next = tabButton.dataset.tab;
      activeTab = next === 'finish' ? 'finish' : next;
      sessionStorage.setItem(tabKey, activeTab);
      renderTabContent();
      updateHeader();
      return;
    }

    const filterButton = event.target.closest('[data-filter]');
    if (filterButton) {
      filter = filterButton.dataset.filter;
      if (filter !== 'all' && activeTab !== 'finish') {
        for (const group of inspection.groups.filter((entry) => entry.floor === activeTab)) {
          if (group.items.some((item) => itemMatches(item, group))) openGroups.add(group.id);
        }
        saveOpenGroups();
      }
      renderTabContent();
      return;
    }

    const toggle = event.target.closest('[data-group-toggle]');
    if (toggle) {
      const groupId = toggle.dataset.groupToggle;
      if (openGroups.has(groupId)) openGroups.delete(groupId);
      else openGroups.add(groupId);
      saveOpenGroups();
      const card = toggle.closest('[data-group-card]');
      const open = openGroups.has(groupId);
      card.classList.toggle('is-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      syncToolbar();
      return;
    }

    if (event.target.closest('[data-expand-all]')) {
      const floorGroups = inspection.groups.filter((group) => group.floor === activeTab);
      const allOpen = floorGroups.every((group) => openGroups.has(group.id));
      for (const group of floorGroups) {
        if (allOpen) openGroups.delete(group.id);
        else openGroups.add(group.id);
      }
      saveOpenGroups();
      renderTabContent();
      return;
    }

    const resultButton = event.target.closest('[data-result]');
    if (resultButton) {
      await handleResultClick(resultButton);
      return;
    }

    const editButton = event.target.closest('[data-edit-failure]');
    if (editButton) {
      openFailureModal(editButton.dataset.group, Number(editButton.dataset.index));
      return;
    }

    if (event.target.closest('[data-retry-sync]')) {
      flushQueue();
      return;
    }

    const gotoFailure = event.target.closest('[data-goto-failure]');
    if (gotoFailure) {
      activeTab = gotoFailure.dataset.floor;
      search = '';
      filter = 'all';
      openGroups.add(gotoFailure.dataset.group);
      saveOpenGroups();
      sessionStorage.setItem(tabKey, activeTab);
      renderTabContent();
      updateHeader();
      requestAnimationFrame(() => {
        const target = container.querySelector(
          '[data-item-key="' +
            gotoFailure.dataset.group +
            ':' +
            gotoFailure.dataset.index +
            '"]'
        );
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target?.querySelector('.result-btn.fail')?.focus();
      });
      return;
    }

    if (event.target.closest('[data-copy-summary]')) {
      await copySummary();
      return;
    }

    if (event.target.closest('[data-export-report]')) {
      await exportReport(event.target.closest('[data-export-report]'));
      return;
    }

    const completeButton = event.target.closest('[data-complete]');
    if (completeButton) {
      await completeInspection(completeButton);
      return;
    }

    if (event.target.closest('[data-discard-draft]')) {
      const confirmed = await confirmDialog({
        title: 'Discard this draft?',
        message:
          'This will permanently delete the checklist, failure notes and uploaded evidence. It cannot be undone.',
        confirmLabel: 'Discard draft',
        cancelLabel: 'Keep draft',
        danger: true,
        iconName: 'trash'
      });
      if (!confirmed) return;
      try {
        await api.delete('/api/inspections/' + encodeURIComponent(inspection.id));
        localStorage.removeItem(draftKey);
        toast('Draft discarded.', { type: 'success' });
        location.hash = '#/';
      } catch (error) {
        toast(error.message || 'Could not discard the draft.', { type: 'error' });
      }
    }
  });

  container.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'correctionsRechecked') {
      inspection.correctionsRechecked = target.checked;
      enqueue({ kind: 'patch', payload: { correctionsRechecked: target.checked } });
    } else if (target.id === 'handoverDone') {
      inspection.handoverDone = target.checked;
      enqueue({ kind: 'patch', payload: { handoverDone: target.checked } });
    }
  });

  container.addEventListener('input', (event) => {
    if (event.target.id === 'handoverNotes') {
      inspection.handover = event.target.value;
      saveHandover(event.target.value);
    }
  });

  searchInput.addEventListener(
    'input',
    debounce(() => {
      search = searchInput.value.trim();
      if (search && activeTab !== 'finish') {
        for (const group of inspection.groups.filter((entry) => entry.floor === activeTab)) {
          if (group.items.some((item) => itemMatches(item, group))) openGroups.add(group.id);
        }
        saveOpenGroups();
      }
      if (activeTab !== 'finish') renderGroups();
    }, 160)
  );

  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    inspection.date = dateInput.value;
    updateHeader();
    enqueue({ kind: 'patch', payload: { date: dateInput.value } });
  });

  updateHeader();
  renderTabContent();

  if (restored) {
    toast('Restored unsaved changes from this device.', { type: 'info' });
  }
  if (pendingOps.length) flushQueue();

  return () => {
    saveHandover.flush();
    persistDraft();
    destroyed = true;
    if (activeModal) {
      try {
        activeModal.dialog.close();
      } catch {
        /* The dialog may already be closed. */
      }
    }
    for (const url of previewUrls) URL.revokeObjectURL(url);
    previewUrls = [];
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('beforeunload', beforeUnload);
  };
}

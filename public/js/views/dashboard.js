import { api } from '../api.js';
import {
  escapeHtml,
  formatDate,
  icon,
  openModal,
  setButtonLoading,
  todayInputValue,
  toast
} from '../ui.js';
import {
  completionPercent,
  inspectionRow,
  progressRing,
  statCard
} from './components.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function barChart(trend) {
  const max = Math.max(1, ...trend.map((day) => day.pass + day.fail));
  const today = todayInputValue();

  return (
    '<div class="bar-chart" role="img" aria-label="Pass and fail totals for the last seven days">' +
    trend
      .map((day) => {
        const total = day.pass + day.fail;
        const passHeight = (day.pass / max) * 100;
        const failHeight = (day.fail / max) * 100;
        const label = formatDate(day.date, 'weekday');
        const description =
          formatDate(day.date, 'medium') +
          ': ' +
          day.pass +
          ' passed, ' +
          day.fail +
          ' failed, ' +
          day.inspections +
          ' inspection' +
          (day.inspections === 1 ? '' : 's');
        return (
          '<div class="chart-day ' +
          (day.date === today ? 'is-today' : '') +
          '" title="' +
          escapeHtml(description) +
          '" aria-label="' +
          escapeHtml(description) +
          '">' +
          '<div class="chart-stack">' +
          (day.pass
            ? '<span class="chart-bar pass" style="height:' + passHeight.toFixed(1) + '%"></span>'
            : '') +
          (day.fail
            ? '<span class="chart-bar fail" style="height:' + failHeight.toFixed(1) + '%"></span>'
            : '') +
          '</div>' +
          '<span class="chart-label">' +
          escapeHtml(label) +
          '</span>' +
          '<span class="chart-total">' +
          (total || '—') +
          '</span>' +
          '</div>'
        );
      })
      .join('') +
    '</div>'
  );
}

function failuresMarkup(topFailures) {
  if (!topFailures.length) {
    return (
      '<div class="empty-state" style="padding:26px 12px">' +
      '<span class="empty-icon">' +
      icon('checkCircle', { size: 23 }) +
      '</span>' +
      '<h3>No failures recorded</h3>' +
      '<p>Nothing has failed in the last 30 days.</p>' +
      '</div>'
    );
  }

  return (
    '<div class="failure-list">' +
    topFailures
      .map(
        (failure, index) =>
          '<div class="failure-row">' +
          '<span class="failure-rank">' +
          (index + 1) +
          '</span>' +
          '<div class="failure-copy"><strong>' +
          escapeHtml(failure.itemText) +
          '</strong><p class="failure-meta">' +
          escapeHtml(failure.floor) +
          ' · ' +
          escapeHtml(failure.groupName) +
          '</p></div>' +
          '<span class="failure-count" title="Failure count">' +
          failure.count +
          '</span>' +
          '</div>'
      )
      .join('') +
    '</div>'
  );
}

function floorsMarkup(floors) {
  return (
    '<div class="floor-list">' +
    floors
      .map((floor) => {
        const pass = Number(floor.passes) || 0;
        const fail = Number(floor.fails) || 0;
        const total = pass + fail;
        const passWidth = total ? (pass / total) * 100 : 0;
        const failWidth = total ? (fail / total) * 100 : 0;
        return (
          '<div class="floor-row">' +
          '<div class="floor-top"><strong>' +
          escapeHtml(floor.floor) +
          '</strong><span>' +
          (fail ? fail + ' failed · ' : '') +
          pass +
          ' passed</span></div>' +
          '<div class="floor-bar" aria-hidden="true">' +
          (total
            ? '<span class="pass" style="width:' +
              passWidth.toFixed(1) +
              '%"></span><span class="fail" style="width:' +
              failWidth.toFixed(1) +
              '%"></span>'
            : '') +
          '</div>' +
          '</div>'
        );
      })
      .join('') +
    '</div>' +
    '<div class="floor-legend"><span><span class="legend-dot"></span>Passed</span><span><span class="legend-dot fail"></span>Failed</span><span>Last 30 days</span></div>'
  );
}

function openStartInspection(stats) {
  const date = todayInputValue();
  const draftNote = stats.activeDraft
    ? '<p class="modal-note">' +
      icon('info', { size: 13 }) +
      '<span>You already have an inspection in progress. It will stay available under Inspections if you start another.</span></p>'
    : '';

  const { dialog, close } = openModal({
    title: 'Start a new inspection',
    subtitle: 'Choose the inspection date. Everything autosaves as you work.',
    body:
      '<form class="modal-form" id="startInspectionForm" novalidate>' +
      '<p class="form-error" id="startInspectionError" role="alert"></p>' +
      '<div class="field"><label for="inspectionDate">Inspection date</label><input class="input date-input" id="inspectionDate" name="date" type="date" value="' +
      date +
      '" max="' +
      date +
      '" required /></div>' +
      draftNote +
      '<div class="modal-note">' +
      icon('shield', { size: 13 }) +
      '<span>The full room-by-room checklist will be created for this date.</span>' +
      '</div>' +
      '</form>',
    footer:
      '<button class="btn btn-secondary" type="button" data-modal-close>Cancel</button>' +
      '<button class="btn btn-primary" type="submit" form="startInspectionForm" id="startInspectionSubmit">' +
      icon('plus', { size: 17 }) +
      'Start inspection</button>',
    size: 'narrow'
  });

  const form = dialog.querySelector('#startInspectionForm');
  const error = dialog.querySelector('#startInspectionError');
  const submit = dialog.querySelector('#startInspectionSubmit');
  const dateInput = dialog.querySelector('#inspectionDate');

  requestAnimationFrame(() => dateInput.focus());

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.classList.remove('is-visible');
    if (!dateInput.value) {
      error.textContent = 'Choose a date for this inspection.';
      error.classList.add('is-visible');
      return;
    }

    setButtonLoading(submit, true, 'Starting…');
    try {
      const result = await api.post('/api/inspections', { date: dateInput.value });
      close();
      location.hash = '#/inspection/' + encodeURIComponent(result.inspection.id);
    } catch (requestError) {
      setButtonLoading(submit, false);
      error.textContent = requestError.message || 'Could not start the inspection.';
      error.classList.add('is-visible');
    }
  });
}

export async function renderDashboard(container, user) {
  container.innerHTML =
    '<div class="loading-state"><span class="spinner" aria-hidden="true"></span><span>Loading overview…</span></div>';

  const stats = await api.get('/api/stats');
  const isManager = user.role === 'manager';
  const today = stats.today;
  const week = stats.week;
  const draft = stats.activeDraft;

  const statCards = isManager
    ? [
        statCard({
          iconName: 'clipboard',
          value: today.completed + '/' + today.inspections,
          label: 'Inspections completed today',
          foot: today.inspections
            ? today.drafts + ' still in progress'
            : 'No inspections started today'
        }),
        statCard({
          iconName: 'alertTriangle',
          value: today.fail,
          label: 'Failures today',
          foot: today.fail ? 'Needs correction or recheck' : 'No failures recorded today',
          tone: today.fail ? 'danger' : ''
        }),
        statCard({
          iconName: 'list',
          value: today.checked,
          label: 'Items checked today',
          foot: today.totalItems
            ? today.completion +
              '% across ' +
              today.inspections +
              ' inspection' +
              (today.inspections === 1 ? '' : 's')
            : 'Nothing checked yet',
          tone: today.checked ? 'info' : ''
        }),
        statCard({
          iconName: 'chart',
          value: week.passRate,
          suffix: '%',
          label: 'Pass rate this week',
          foot:
            week.checked +
            ' checks across ' +
            week.inspections +
            ' inspection' +
            (week.inspections === 1 ? '' : 's'),
          tone: 'info'
        })
      ]
    : [
        statCard({
          iconName: 'clipboard',
          value: today.checked,
          suffix:
            today.totalItems && today.inspections === 1 ? '/' + today.totalItems : '',
          label: 'Items checked today',
          foot: today.totalItems
            ? today.completion +
              '% across ' +
              today.inspections +
              ' inspection' +
              (today.inspections === 1 ? '' : 's')
            : 'Start an inspection when you are ready'
        }),
        statCard({
          iconName: 'alertTriangle',
          value: today.fail,
          label: 'Failures today',
          foot: today.fail ? 'Correct and reinspect each item' : 'No failures recorded today',
          tone: today.fail ? 'danger' : ''
        }),
        statCard({
          iconName: 'checkCircle',
          value: today.completed,
          label: 'Completed today',
          foot:
            today.drafts + ' in progress · ' + today.inspections + ' started',
          tone: today.completed ? 'info' : ''
        }),
        statCard({
          iconName: 'chart',
          value: week.passRate,
          suffix: '%',
          label: 'Pass rate this week',
          foot: week.checked + ' checks over 7 days',
          tone: 'info'
        })
      ];

  const draftMarkup =
    !isManager && draft
      ? '<a class="draft-banner" href="#/inspection/' +
        encodeURIComponent(draft.id) +
        '">' +
        '<span class="draft-icon">' +
        icon('clipboard', { size: 23 }) +
        '</span>' +
        '<div class="draft-copy"><span class="eyebrow">In progress</span><h2>Continue your ' +
        escapeHtml(formatDate(draft.date, 'dayMonth')) +
        ' inspection</h2><p>' +
        (draft.stats.pass + draft.stats.fail) +
        ' of ' +
        draft.stats.total +
        ' checks completed · ' +
        draft.stats.fail +
        ' failed</p></div>' +
        '<div class="draft-progress">' +
        progressRing(completionPercent(draft.stats)) +
        '<small>complete</small></div>' +
        '<span class="draft-arrow">' +
        icon('arrowRight', { size: 18 }) +
        '</span>' +
        '</a>'
      : '';

  const recent = stats.recent.length
    ? stats.recent
        .map((inspection) => inspectionRow(inspection, user, { showInspector: isManager }))
        .join('')
    : '<div class="empty-state" style="padding:30px 12px">' +
      '<span class="empty-icon">' +
      icon('clipboard', { size: 23 }) +
      '</span>' +
      '<h3>No inspections yet</h3>' +
      '<p>' +
      (isManager
        ? 'Supervisor inspections will appear here once they begin.'
        : 'Start your first cleaning inspection to see it here.') +
      '</p>' +
      (!isManager
        ? '<button class="btn btn-primary btn-sm" type="button" data-start-inspection>' +
          icon('plus', { size: 15 }) +
          'Start inspection</button>'
        : '') +
      '</div>';

  container.innerHTML =
    '<div class="view dashboard-view">' +
    '<header class="page-head">' +
    '<div>' +
    '<p class="eyebrow">' +
    (isManager ? 'Manager dashboard' : 'Supervisor workspace') +
    '</p>' +
    '<h1>' +
    escapeHtml(greeting()) +
    ', ' +
    escapeHtml(firstName(user.name)) +
    '.</h1>' +
    '<p class="page-sub">' +
    escapeHtml(formatDate(today.date, 'long')) +
    ' · ' +
    (isManager
      ? 'A live view of cleaning performance across the hostel.'
      : 'Pick up where you left off or start the next cleaning inspection.') +
    '</p>' +
    '</div>' +
    '<div class="page-actions">' +
    (isManager
      ? '<span class="badge badge-info">' + icon('chart', { size: 13 }) + 'Hostel-wide view</span>'
      : '<button class="btn btn-primary btn-lg" type="button" data-start-inspection>' +
        icon('plus', { size: 18 }) +
        'Start inspection</button>') +
    '</div>' +
    '</header>' +
    draftMarkup +
    '<div class="stat-grid">' +
    statCards.join('') +
    '</div>' +
    '<div class="dash-grid">' +
    '<section class="card chart-card">' +
    '<div class="card-head"><div><h2>Last 7 days</h2><p>Checks recorded across ' +
    (isManager ? 'all supervisors' : 'your inspections') +
    '</p></div><div class="chart-legend"><span><span class="legend-dot"></span>Passed</span><span><span class="legend-dot fail"></span>Failed</span></div></div>' +
    (week.checked
      ? barChart(week.trend)
      : '<div class="empty-state" style="padding:32px 12px"><span class="empty-icon">' +
        icon('chart', { size: 23 }) +
        '</span><h3>No checks recorded</h3><p>Start an inspection to see the weekly trend here.</p></div>') +
    '</section>' +
    '<div class="dash-stack">' +
    '<section class="card"><div class="card-head"><div><h2>Most failed checks</h2><p>Last 30 days</p></div></div>' +
    failuresMarkup(stats.topFailures) +
    '</section>' +
    '<section class="card"><div class="card-head"><div><h2>Floor overview</h2><p>Pass and fail totals by floor</p></div></div>' +
    floorsMarkup(stats.floors) +
    '</section>' +
    '</div>' +
    '</div>' +
    '<section class="card">' +
    '<div class="card-head"><div><h2>Recent inspections</h2><p>' +
    (isManager ? 'Latest activity from all supervisors' : 'Your latest inspection activity') +
    '</p></div><a class="card-action" href="#/inspections">View all' +
    icon('arrowRight', { size: 14 }) +
    '</a></div>' +
    '<div class="recent-list">' +
    recent +
    '</div>' +
    '</section>' +
    '<p class="view-footnote">Allen Hostel · Cleaning operations · Data saved to the hostel server</p>' +
    '</div>';

  container.querySelectorAll('[data-start-inspection]').forEach((button) => {
    button.addEventListener('click', () => openStartInspection(stats));
  });

  return null;
}

import { api } from './api.js';
import { blobToDataUrl, downloadBlob, escapeHtml, formatDate } from './ui.js';

function itemStatus(item) {
  if (item.result === 'pass') return 'PASS';
  if (item.result === 'fail') return 'FAIL';
  return 'NOT CHECKED';
}

export function buildDailySummary(inspection) {
  const lines = [];
  lines.push('ALLEN CLEANING CHECK — ' + inspection.date);
  lines.push('Inspector: ' + inspection.inspector.name);
  lines.push('Status: ' + (inspection.status === 'completed' ? 'Completed' : 'In progress'));
  lines.push('');

  for (const group of inspection.groups) {
    lines.push(group.floor + ' / ' + group.name);
    for (const item of group.items) {
      let line = '• ' + itemStatus(item) + ': ' + item.text;
      if (item.failure && (item.result === 'fail' || item.failure.recordedAt)) {
        line +=
          '\n  ' +
          item.failure.location +
          ' — ' +
          item.failure.notes +
          (item.result === 'pass' && item.failure.recheckedAt ? ' (passed after recheck)' : '');
        if (item.failure.attachments?.length) {
          line += ' | ' + item.failure.attachments.length + ' attachment(s)';
        }
      }
      lines.push(line);
    }
    lines.push('');
  }

  lines.push('Corrections rechecked: ' + (inspection.correctionsRechecked ? 'Yes' : 'Not confirmed'));
  lines.push('Outstanding issues handed over: ' + (inspection.handoverDone ? 'Yes' : 'Not confirmed'));
  lines.push('');
  lines.push('Outstanding / handover:');
  lines.push(inspection.handover || 'None recorded');
  return lines.join('\n');
}

export function reportFileName(inspection) {
  return 'Allen-cleaning-' + inspection.date + '.html';
}

function renderMedia(attachments, mediaMap) {
  if (!attachments?.length) return '';
  let html = '<div class="report-media">';
  for (const attachment of attachments) {
    const dataUrl = mediaMap.get(attachment.id);
    if (!dataUrl) {
      html +=
        '<p class="missing">Attachment unavailable: ' +
        escapeHtml(attachment.originalName) +
        '</p>';
      continue;
    }
    if (attachment.mimeType.startsWith('video/')) {
      html +=
        '<video controls preload="metadata" src="' +
        escapeHtml(dataUrl) +
        '"></video>';
    } else {
      html +=
        '<img src="' +
        escapeHtml(dataUrl) +
        '" alt="' +
        escapeHtml(attachment.originalName) +
        '" />';
    }
  }
  html += '</div>';
  return html;
}

function collectAttachments(inspection) {
  const attachments = [];
  for (const group of inspection.groups) {
    for (const item of group.items) {
      if (item.failure?.attachments?.length) {
        attachments.push(...item.failure.attachments);
      }
    }
  }
  return attachments;
}

export async function exportInspectionReport(inspection) {
  const mediaMap = new Map();
  let missing = 0;
  for (const attachment of collectAttachments(inspection)) {
    try {
      const blob = await api.blob(attachment.url);
      mediaMap.set(attachment.id, await blobToDataUrl(blob));
    } catch {
      missing += 1;
    }
  }

  const summary = buildDailySummary(inspection);
  const failures = [];
  for (const group of inspection.groups) {
    for (const item of group.items) {
      if (item.failure && (item.result === 'fail' || item.failure.recordedAt)) {
        failures.push({ group, item });
      }
    }
  }

  const failureHtml = failures
    .map(
      ({ group, item }) =>
        '<section class="failure">' +
        '<p class="failure-kicker">' +
        escapeHtml(group.floor) +
        ' · ' +
        escapeHtml(group.name) +
        '</p>' +
        '<h3>' +
        escapeHtml(item.text) +
        '</h3>' +
        '<p class="location">' +
        escapeHtml(item.failure.location) +
        '</p>' +
        '<p class="notes">' +
        escapeHtml(item.failure.notes) +
        '</p>' +
        '<p class="state">' +
        (item.result === 'fail'
          ? 'Outstanding failure'
          : 'Passed after recheck' +
            (item.failure.recheckedAt ? ' · ' + formatDate(item.failure.recheckedAt.slice(0, 10)) : '')) +
        '</p>' +
        renderMedia(item.failure.attachments, mediaMap) +
        '</section>'
    )
    .join('');

  const stats = inspection.stats;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<title>Allen cleaning report — ' +
    escapeHtml(inspection.date) +
    '</title><style>' +
    ':root{color-scheme:light}*{box-sizing:border-box}body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1c2b23;max-width:860px;margin:0 auto;padding:36px 24px;background:#fff}h1,h2,h3{line-height:1.25;margin:0}h1{font-size:28px;letter-spacing:-.03em}h2{font-size:18px;margin-top:28px;padding-bottom:8px;border-bottom:1px solid #e1e5da}h3{font-size:14px}.kicker{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#6b786f;font-weight:700;margin:0 0 8px}.meta{display:flex;gap:20px;flex-wrap:wrap;margin-top:12px;color:#6b786f;font-size:12.5px}.badges{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.badge{padding:5px 10px;border-radius:999px;font-size:11px;font-weight:700;background:#eef1e8;color:#36483d}.badge.pass{background:#e9f5ee;color:#2d7a52}.badge.fail{background:#fbece9;color:#ad4638}pre{white-space:pre-wrap;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f8f9f4;border:1px solid #e1e5da;border-radius:12px;padding:18px;overflow-wrap:anywhere}.failure{border:1px solid #f0d2cc;background:#fffafa;border-radius:12px;padding:16px;margin-top:12px;break-inside:avoid}.failure-kicker{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:#6b786f;font-weight:700;margin:0 0 5px}.location{color:#ad4638;font-weight:600;font-size:12.5px;margin:5px 0 0}.notes{color:#36483d;font-size:12.5px;margin:6px 0 0;white-space:pre-wrap}.state{font-size:10.5px;color:#6b786f;margin:8px 0 0}.report-media{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:12px}.report-media img,.report-media video{width:100%;max-height:220px;object-fit:cover;border-radius:9px;border:1px solid #e1e5da;background:#eef1e8}.missing{font-size:11px;color:#ad4638;margin:0;grid-column:1/-1}.foot{margin-top:34px;padding-top:14px;border-top:1px solid #e1e5da;color:#8c978f;font-size:10.5px}@media print{body{padding:0}.failure{break-inside:avoid}}' +
    '</style></head><body>' +
    '<p class="kicker">Allen Hostel · Cleaning inspection report</p>' +
    '<h1>' +
    (inspection.status === 'completed' ? 'Completed cleaning inspection' : 'Cleaning inspection draft') +
    '</h1>' +
    '<div class="meta"><span>Date: <strong>' +
    escapeHtml(formatDate(inspection.date, 'long')) +
    '</strong></span><span>Inspector: <strong>' +
    escapeHtml(inspection.inspector.name) +
    '</strong></span><span>Updated: <strong>' +
    escapeHtml(formatDate(inspection.updatedAt.slice(0, 10), 'short')) +
    '</strong></span></div>' +
    '<div class="badges"><span class="badge pass">' +
    stats.pass +
    ' passed</span><span class="badge fail">' +
    stats.fail +
    ' failed</span><span class="badge">' +
    stats.unchecked +
    ' not checked</span><span class="badge">' +
    stats.total +
    ' total checks</span></div>' +
    '<h2>Daily summary</h2><pre>' +
    escapeHtml(summary) +
    '</pre>' +
    (failures.length ? '<h2>Findings</h2>' + failureHtml : '') +
    '<p class="foot">Generated from Allen Cleaning Supervisor. ' +
    (missing ? missing + ' attachment(s) could not be embedded. ' : '') +
    'Report generated ' +
    escapeHtml(new Date().toLocaleString('en-GB')) +
    '.</p>' +
    '</body></html>';

  downloadBlob(new Blob([html], { type: 'text/html' }), reportFileName(inspection));
  return { missing };
}

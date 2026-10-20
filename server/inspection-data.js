const fs = require('node:fs');
const path = require('node:path');
const { nowIso } = require('./db');

function parseChecklist(row) {
  try {
    const groups = JSON.parse(row.checklist_json);
    return Array.isArray(groups) ? groups : [];
  } catch {
    return [];
  }
}

function summarizeInspection(row) {
  const pass = Number(row.pass_count) || 0;
  const fail = Number(row.fail_count) || 0;
  const total = Number(row.total_items) || 0;
  return {
    id: row.id,
    date: row.date,
    status: row.status,
    inspector: { id: row.inspector_id, name: row.inspector_name },
    handover: row.handover || '',
    correctionsRechecked: Boolean(row.corrections_rechecked),
    handoverDone: Boolean(row.handover_done),
    stats: {
      pass,
      fail,
      unchecked: Math.max(0, total - pass - fail),
      total
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function serializeInspection(db, row) {
  const groups = parseChecklist(row);
  const results = db.prepare('SELECT * FROM results WHERE inspection_id = ?').all(row.id);
  const attachments = db
    .prepare('SELECT * FROM attachments WHERE inspection_id = ? ORDER BY created_at ASC')
    .all(row.id);

  const resultMap = new Map(results.map((result) => [result.group_key + ':' + result.item_index, result]));
  const attachmentMap = new Map();
  for (const attachment of attachments) {
    const key = attachment.group_key + ':' + attachment.item_index;
    if (!attachmentMap.has(key)) attachmentMap.set(key, []);
    attachmentMap.get(key).push({
      id: attachment.id,
      originalName: attachment.original_name,
      mimeType: attachment.mime_type,
      size: attachment.size,
      createdAt: attachment.created_at,
      url: '/api/attachments/' + attachment.id
    });
  }

  let failedGroups = 0;
  let checkedGroups = 0;

  const hydratedGroups = groups.map((group) => {
    let groupFailed = false;
    let groupChecked = true;
    const items = group.items.map((text, index) => {
      const key = group.id + ':' + index;
      const result = resultMap.get(key);
      if (result?.result === 'fail') groupFailed = true;
      if (!result) groupChecked = false;
      const failure =
        result && (result.result === 'fail' || result.recorded_at)
          ? {
              location: result.location || '',
              notes: result.notes || '',
              recordedAt: result.recorded_at,
              recheckedAt: result.rechecked_at,
              attachments: attachmentMap.get(key) || []
            }
          : null;
      return {
        index,
        text,
        result: result?.result || null,
        failure,
        updatedAt: result?.updated_at || null
      };
    });
    if (groupFailed) failedGroups += 1;
    if (groupChecked) checkedGroups += 1;
    return { ...group, items };
  });

  const pass = Number(row.pass_count) || 0;
  const fail = Number(row.fail_count) || 0;
  const total = Number(row.total_items) || 0;

  return {
    ...summarizeInspection(row),
    groups: hydratedGroups,
    stats: {
      pass,
      fail,
      unchecked: Math.max(0, total - pass - fail),
      total,
      groups: hydratedGroups.length,
      failedGroups,
      checkedGroups
    }
  };
}

function refreshCounts(db, inspectionId) {
  const counts = db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END), 0) AS pass,
        COALESCE(SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END), 0) AS fail
      FROM results
      WHERE inspection_id = ?
    `)
    .get(inspectionId);

  db.prepare('UPDATE inspections SET pass_count = ?, fail_count = ?, updated_at = ? WHERE id = ?')
    .run(counts.pass, counts.fail, nowIso(), inspectionId);
  return counts;
}

function touchInspection(db, inspectionId) {
  db.prepare('UPDATE inspections SET updated_at = ? WHERE id = ?').run(nowIso(), inspectionId);
}

function attachmentPath(uploadDir, storedName) {
  const resolved = path.resolve(uploadDir, storedName);
  const root = path.resolve(uploadDir) + path.sep;
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function removeAttachmentFile(uploadDir, storedName) {
  const filePath = attachmentPath(uploadDir, storedName);
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not remove attachment file:', error.message);
  }
}

module.exports = {
  parseChecklist,
  summarizeInspection,
  serializeInspection,
  refreshCounts,
  touchInspection,
  attachmentPath,
  removeAttachmentFile
};

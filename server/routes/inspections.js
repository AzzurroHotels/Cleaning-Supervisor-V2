const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireRole } = require('../auth');
const { buildChecklist, checklistStats } = require('../checklist');
const { nowIso } = require('../db');
const {
  parseChecklist,
  summarizeInspection,
  serializeInspection,
  refreshCounts,
  touchInspection,
  removeAttachmentFile
} = require('../inspection-data');
const {
  HttpError,
  wrap,
  requireText,
  optionalText,
  requireDate,
  todayLocal,
  toBool
} = require('../util');

const ALLOWED_MIME = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['image/heic', '.heic'],
  ['image/heif', '.heif'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['video/x-m4v', '.m4v']
]);

function createInspectionsRouter({
  db,
  uploadDir,
  maxFileBytes = 20 * 1024 * 1024,
  maxFailureBytes = 60 * 1024 * 1024,
  maxFiles = 10
}) {
  fs.mkdirSync(uploadDir, { recursive: true });

  const router = express.Router();
  const getRow = db.prepare('SELECT * FROM inspections WHERE id = ?');
  const getResult = db.prepare(
    'SELECT * FROM results WHERE inspection_id = ? AND group_key = ? AND item_index = ?'
  );
  const getAttachment = db.prepare('SELECT * FROM attachments WHERE id = ? AND inspection_id = ?');
  const sumAttachmentSizes = db.prepare(
    'SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE inspection_id = ? AND group_key = ? AND item_index = ?'
  );

  function loadInspection(req, { edit = false } = {}) {
    const row = getRow.get(req.params.id);
    if (!row) throw new HttpError(404, 'Inspection not found.');

    if (req.user.role === 'manager') {
      if (edit) throw new HttpError(403, 'Managers can view inspections but cannot edit them.');
      return row;
    }

    if (row.inspector_id !== req.user.id) {
      throw new HttpError(403, 'This inspection belongs to another supervisor.');
    }
    if (edit && row.status !== 'draft') {
      throw new HttpError(409, 'Reopen this completed inspection before editing it.');
    }
    return row;
  }

  function findGroupItem(row, groupKey, rawIndex) {
    const groups = parseChecklist(row);
    const group = groups.find((entry) => entry.id === groupKey);
    if (!group) throw new HttpError(404, 'Checklist section not found.');
    const indexText = String(rawIndex);
    if (!/^\d+$/.test(indexText)) throw new HttpError(400, 'Invalid checklist item.');
    const itemIndex = Number(indexText);
    if (itemIndex < 0 || itemIndex >= group.items.length) {
      throw new HttpError(400, 'Invalid checklist item.');
    }
    return { group, itemIndex, itemText: group.items[itemIndex] };
  }

  const storage = multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      const extension = ALLOWED_MIME.get(file.mimetype) || '';
      callback(null, crypto.randomUUID() + extension);
    }
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: maxFileBytes,
      files: maxFiles,
      fields: 10,
      fieldNameSize: 100,
      parts: maxFiles + 10
    },
    fileFilter: (req, file, callback) => {
      if (!ALLOWED_MIME.has(file.mimetype)) {
        callback(new HttpError(400, 'Choose a JPG, PNG, WebP, HEIC, GIF, MP4, MOV or WebM file.'));
        return;
      }
      callback(null, true);
    }
  });

  router.use(requireAuth);

  router.post(
    '/',
    requireRole('supervisor'),
    wrap((req, res) => {
      const date = req.body?.date ? requireDate(req.body.date) : todayLocal();
      const groups = buildChecklist();
      const { totalItems } = checklistStats(groups);
      const id = crypto.randomUUID();
      const now = nowIso();

      db.prepare(`
        INSERT INTO inspections (
          id, inspector_id, inspector_name, date, status, checklist_json, total_items,
          pass_count, fail_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, 0, 0, ?, ?)
      `).run(id, req.user.id, req.user.name, date, JSON.stringify(groups), totalItems, now, now);

      res.status(201).json({ inspection: serializeInspection(db, getRow.get(id)) });
    })
  );

  router.get(
    '/',
    wrap((req, res) => {
      const where = [];
      const params = [];

      if (req.user.role === 'supervisor') {
        where.push('inspector_id = ?');
        params.push(req.user.id);
      } else if (req.query.inspectorId) {
        const inspectorId = Number(req.query.inspectorId);
        if (!Number.isInteger(inspectorId) || inspectorId < 1) {
          throw new HttpError(400, 'Invalid inspector filter.');
        }
        where.push('inspector_id = ?');
        params.push(inspectorId);
      }

      if (req.query.status) {
        if (!['draft', 'completed'].includes(req.query.status)) {
          throw new HttpError(400, 'Invalid status filter.');
        }
        where.push('status = ?');
        params.push(req.query.status);
      }

      if (req.query.from) {
        where.push('date >= ?');
        params.push(requireDate(req.query.from, 'From date'));
      }
      if (req.query.to) {
        where.push('date <= ?');
        params.push(requireDate(req.query.to, 'To date'));
      }

      if (req.query.q) {
        const query = String(req.query.q).trim().slice(0, 80);
        if (query) {
          where.push('(inspector_name LIKE ? OR date LIKE ?)');
          params.push('%' + query + '%', '%' + query + '%');
        }
      }

      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const total = db.prepare('SELECT COUNT(*) AS count FROM inspections ' + clause).get(...params).count;
      const rows = db
        .prepare(
          'SELECT * FROM inspections ' +
            clause +
            ' ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?'
        )
        .all(...params, limit, offset);

      res.json({
        items: rows.map(summarizeInspection),
        total,
        limit,
        offset
      });
    })
  );

  router.get(
    '/:id',
    wrap((req, res) => {
      const row = loadInspection(req);
      res.json({ inspection: serializeInspection(db, row) });
    })
  );

  router.patch(
    '/:id',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = loadInspection(req, { edit: true });
      const updates = [];
      const params = [];

      if (req.body.date !== undefined) {
        updates.push('date = ?');
        params.push(requireDate(req.body.date));
      }
      if (req.body.handover !== undefined) {
        updates.push('handover = ?');
        params.push(optionalText(req.body.handover, 'Handover notes', { max: 4000 }));
      }
      if (req.body.correctionsRechecked !== undefined) {
        updates.push('corrections_rechecked = ?');
        params.push(toBool(req.body.correctionsRechecked) ? 1 : 0);
      }
      if (req.body.handoverDone !== undefined) {
        updates.push('handover_done = ?');
        params.push(toBool(req.body.handoverDone) ? 1 : 0);
      }

      if (!updates.length) throw new HttpError(400, 'No supported fields were provided.');

      updates.push('updated_at = ?');
      params.push(nowIso(), row.id);
      db.prepare('UPDATE inspections SET ' + updates.join(', ') + ' WHERE id = ?').run(...params);

      res.json({ inspection: serializeInspection(db, getRow.get(row.id)) });
    })
  );

  router.put(
    '/:id/results/:groupKey/:itemIndex',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = loadInspection(req, { edit: true });
      const { group, itemIndex, itemText } = findGroupItem(
        row,
        req.params.groupKey,
        req.params.itemIndex
      );
      const result = req.body?.result;
      if (!['pass', 'fail'].includes(result)) {
        throw new HttpError(400, 'Result must be pass or fail.');
      }

      const existing = getResult.get(row.id, group.id, itemIndex);
      const now = nowIso();

      const apply = db.transaction(() => {
        if (result === 'fail') {
          const location = requireText(req.body.location, 'Location', { min: 1, max: 240 });
          const notes = requireText(req.body.notes, 'Notes', { min: 1, max: 2000 });
          const recordedAt =
            existing?.result === 'fail' && existing.recorded_at ? existing.recorded_at : now;

          db.prepare(`
            INSERT INTO results (
              inspection_id, group_key, item_index, group_name, floor, item_text, kind,
              result, location, notes, recorded_at, rechecked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'fail', ?, ?, ?, NULL, ?)
            ON CONFLICT(inspection_id, group_key, item_index) DO UPDATE SET
              result = 'fail',
              location = excluded.location,
              notes = excluded.notes,
              recorded_at = excluded.recorded_at,
              rechecked_at = NULL,
              updated_at = excluded.updated_at
          `).run(
            row.id,
            group.id,
            itemIndex,
            group.name,
            group.floor,
            itemText,
            group.kind,
            location,
            notes,
            recordedAt,
            now
          );
        } else {
          const recheckedAt = existing?.result === 'fail' ? now : existing?.rechecked_at || null;
          db.prepare(`
            INSERT INTO results (
              inspection_id, group_key, item_index, group_name, floor, item_text, kind,
              result, location, notes, recorded_at, rechecked_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pass', NULL, NULL, NULL, ?, ?)
            ON CONFLICT(inspection_id, group_key, item_index) DO UPDATE SET
              result = 'pass',
              rechecked_at = excluded.rechecked_at,
              updated_at = excluded.updated_at
          `).run(
            row.id,
            group.id,
            itemIndex,
            group.name,
            group.floor,
            itemText,
            group.kind,
            recheckedAt,
            now
          );
        }

        refreshCounts(db, row.id);
      });

      apply();
      res.json({ result: getResult.get(row.id, group.id, itemIndex) });
    })
  );

  function validateAttachmentTarget(req, res, next) {
    try {
      const row = loadInspection(req, { edit: true });
      const { group, itemIndex } = findGroupItem(
        row,
        req.query.groupKey,
        req.query.itemIndex
      );
      const result = getResult.get(row.id, group.id, itemIndex);
      if (!result || result.result !== 'fail') {
        throw new HttpError(400, 'Photos and videos can only be added to a current failure.');
      }
      req.attachmentTarget = { row, group, itemIndex };
      next();
    } catch (error) {
      next(error);
    }
  }

  router.post(
    '/:id/attachments',
    requireRole('supervisor'),
    validateAttachmentTarget,
    upload.array('files', maxFiles),
    wrap((req, res) => {
      const { row, group, itemIndex } = req.attachmentTarget;
      const files = req.files || [];

      function cleanupFiles() {
        for (const file of files) removeAttachmentFile(uploadDir, file.filename);
      }

      try {
        if (!files.length) throw new HttpError(400, 'Choose at least one photo or video.');
        const existingBytes = sumAttachmentSizes.get(row.id, group.id, itemIndex).total;
        const incomingBytes = files.reduce((sum, file) => sum + file.size, 0);
        if (existingBytes + incomingBytes > maxFailureBytes) {
          throw new HttpError(413, 'Photos and videos for one failure must total 60 MB or less.');
        }

        const insert = db.prepare(`
          INSERT INTO attachments (
            id, inspection_id, group_key, item_index, stored_name, original_name,
            mime_type, size, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const created = [];
        const now = nowIso();
        const insertAll = db.transaction(() => {
          for (const file of files) {
            const id = crypto.randomUUID();
            insert.run(
              id,
              row.id,
              group.id,
              itemIndex,
              file.filename,
              file.originalname.slice(0, 240),
              file.mimetype,
              file.size,
              now
            );
            created.push({
              id,
              originalName: file.originalname,
              mimeType: file.mimetype,
              size: file.size,
              createdAt: now,
              url: '/api/attachments/' + id
            });
          }
          touchInspection(db, row.id);
        });
        insertAll();
        res.status(201).json({ attachments: created });
      } catch (error) {
        cleanupFiles();
        throw error;
      }
    })
  );

  router.delete(
    '/:id/attachments/:attachmentId',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = loadInspection(req, { edit: true });
      const attachment = getAttachment.get(req.params.attachmentId, row.id);
      if (!attachment) throw new HttpError(404, 'Attachment not found.');

      db.prepare('DELETE FROM attachments WHERE id = ?').run(attachment.id);
      removeAttachmentFile(uploadDir, attachment.stored_name);
      touchInspection(db, row.id);
      res.status(204).end();
    })
  );

  router.post(
    '/:id/complete',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = loadInspection(req, { edit: true });
      if (row.pass_count + row.fail_count === 0) {
        throw new HttpError(400, 'Mark at least one checklist item before completing the inspection.');
      }
      const now = nowIso();
      db.prepare(
        "UPDATE inspections SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?"
      ).run(now, now, row.id);
      res.json({ inspection: serializeInspection(db, getRow.get(row.id)) });
    })
  );

  router.post(
    '/:id/reopen',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = getRow.get(req.params.id);
      if (!row) throw new HttpError(404, 'Inspection not found.');
      if (row.inspector_id !== req.user.id) {
        throw new HttpError(403, 'This inspection belongs to another supervisor.');
      }
      if (row.status !== 'completed') throw new HttpError(409, 'This inspection is already open.');
      db.prepare("UPDATE inspections SET status = 'draft', completed_at = NULL, updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      res.json({ inspection: serializeInspection(db, getRow.get(row.id)) });
    })
  );

  router.delete(
    '/:id',
    requireRole('supervisor'),
    wrap((req, res) => {
      const row = loadInspection(req, { edit: true });
      const attachments = db
        .prepare('SELECT stored_name FROM attachments WHERE inspection_id = ?')
        .all(row.id);
      for (const attachment of attachments) {
        removeAttachmentFile(uploadDir, attachment.stored_name);
      }
      db.prepare('DELETE FROM inspections WHERE id = ?').run(row.id);
      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createInspectionsRouter, ALLOWED_MIME };

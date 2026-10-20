const fs = require('node:fs');
const express = require('express');
const { requireAuth } = require('../auth');
const { HttpError, wrap } = require('../util');
const { attachmentPath } = require('../inspection-data');

function contentDisposition(name) {
  const fallback = String(name || 'attachment').replace(/[^\w. -]/g, '_').slice(0, 120) || 'attachment';
  const encoded = encodeURIComponent(name || 'attachment').replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
  return 'inline; filename="' + fallback + '"; filename*=UTF-8\'\'' + encoded;
}

function createAttachmentsRouter({ db, uploadDir }) {
  const router = express.Router();
  const getAttachment = db.prepare(`
    SELECT a.*, i.inspector_id
    FROM attachments a
    JOIN inspections i ON i.id = a.inspection_id
    WHERE a.id = ?
  `);

  router.get(
    '/:id',
    requireAuth,
    wrap((req, res, next) => {
      const attachment = getAttachment.get(req.params.id);
      if (!attachment) throw new HttpError(404, 'Attachment not found.');
      if (req.user.role !== 'manager' && attachment.inspector_id !== req.user.id) {
        throw new HttpError(403, 'You do not have access to this attachment.');
      }

      const filePath = attachmentPath(uploadDir, attachment.stored_name);
      if (!filePath || !fs.existsSync(filePath)) {
        throw new HttpError(404, 'Attachment file is missing from storage.');
      }

      res.set('Cache-Control', 'private, max-age=3600');
      res.set('Content-Disposition', contentDisposition(attachment.original_name));
      res.type(attachment.mime_type);
      res.sendFile(filePath, (error) => {
        if (error && !res.headersSent) next(error);
      });
    })
  );

  return router;
}

module.exports = { createAttachmentsRouter };

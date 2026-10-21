import { Readable } from 'node:stream';
import { get } from '@vercel/blob';
import { isAdmin } from './_auth.js';

// Streams one attachment to a signed-in manager; the store itself is private.
export default async function handler(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password' });
  const pathname = String(req.query.p || '');
  if (!pathname.startsWith('media/') || pathname.includes('..')) return res.status(400).json({ error: 'Invalid path' });
  try {
    const blob = await get(pathname, { access: 'private' });
    if (!blob || blob.statusCode !== 200) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', blob.blob.contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200);
    Readable.fromWeb(blob.stream).pipe(res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

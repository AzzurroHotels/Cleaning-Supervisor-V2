import { isAdmin } from './_auth.js';
import { callServer } from './_server.js';

// Gives a signed-in manager one attached photo from the report server.
export default async function handler(req, res) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password' });
  const id = String(req.query.id || '');
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const { meta, bytes } = await callServer('/photo/' + id);
    res.setHeader('Content-Type', meta.type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.status(200).send(bytes);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

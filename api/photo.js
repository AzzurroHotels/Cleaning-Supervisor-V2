import { inspectorAuthorized } from './_auth.js';
import { callServer } from './_server.js';

// Receives one (already shrunk) photo from the inspector's phone and stores it on the report server.
// Vercel limits a request body to 4.5 MB, so the phone sends each photo on its own.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!inspectorAuthorized(req)) return res.status(401).json({ error: 'Sign in again' });
  try {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length || bytes.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Photo is empty or too large' });
    const name = decodeURIComponent(String(req.headers['x-name'] || 'photo.jpg')).slice(0, 200);
    const { meta } = await callServer('/photo', { name }, bytes);
    res.status(201).json({ id: meta.id });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

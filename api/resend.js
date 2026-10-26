import { isAdmin } from './_auth.js';
import { callServer } from './_server.js';

// Lets a manager post a report's PDF to WhatsApp again (for example after the group was missing the bot).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password' });
  try {
    await callServer('/resend', { id: String(req.body?.id || '') });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

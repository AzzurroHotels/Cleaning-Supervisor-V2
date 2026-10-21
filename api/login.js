import { checkInspector, issueToken } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { id, password } = req.body || {};
  if (!checkInspector(id, password)) {
    await new Promise(r => setTimeout(r, 800)); // slows down password guessing
    return res.status(401).json({ error: 'Wrong login ID or password' });
  }
  res.status(200).json({ token: issueToken() });
}

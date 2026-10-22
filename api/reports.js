import { randomUUID } from 'node:crypto';
import { inspectorAuthorized, isAdmin } from './_auth.js';
import { callServer } from './_server.js';

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const UUID = /^[0-9a-f-]{36}$/;

// Checks and trims what the phone sent; the report server stores exactly this.
function clean(body) {
  if (!body || typeof body !== 'object') throw new Error('Invalid report');
  const name = text(body.name, 100).trim() || 'Inspector';
  const date = text(body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
  const failures = (Array.isArray(body.failures) ? body.failures : []).slice(0, 300).map(f => ({
    id: text(f.id, 20),
    status: f.status === 'pass' ? 'pass' : 'fail',
    floor: text(f.floor, 30),
    area: text(f.area, 200),
    item: text(f.item, 400),
    recheckedAt: text(f.recheckedAt, 40),
    location: text(f.location, 300),
    notes: text(f.notes, 3000),
    media: (Array.isArray(f.media) ? f.media : []).slice(0, 10)
      .filter(m => UUID.test(String(m.id || '')))
      .map(m => ({ id: m.id, type: ['image/jpeg', 'image/png'].includes(m.type) ? m.type : 'image/jpeg', name: text(m.name, 200) })),
  }));
  const areas = (Array.isArray(body.areas) ? body.areas : []).slice(0, 100).map(a => ({
    floor: text(a.floor, 30),
    name: text(a.name, 200),
    note: text(a.note, 2000).trim(),
    media: (Array.isArray(a.media) ? a.media : []).slice(0, 6)
      .filter(m => UUID.test(String(m.id || '')))
      .map(m => ({ id: m.id, type: ['image/jpeg', 'image/png'].includes(m.type) ? m.type : 'image/jpeg', name: text(m.name, 200) })),
    items: (Array.isArray(a.items) ? a.items : []).slice(0, 60).map(i => ({ text: text(i.text, 400), status: ['pass', 'fail'].includes(i.status) ? i.status : 'unchecked' })),
  }));
  const areaNotes = (Array.isArray(body.areaNotes) ? body.areaNotes : []).slice(0, 100)
    .map(n => ({ floor: text(n.floor, 30), area: text(n.area, 200), note: text(n.note, 2000).trim() }))
    .filter(n => n.note);
  return {
    id: randomUUID(),
    submittedAt: new Date().toISOString(),
    name, date, failures, areas, areaNotes,
    summary: text(body.summary, 200000),
    recheck: !!body.recheck,
    handoverDone: !!body.handoverDone,
    handover: text(body.handover, 5000),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      if (!inspectorAuthorized(req)) return res.status(401).json({ error: 'Sign in again' });
      const report = clean(req.body);
      await callServer('/submit', report);
      return res.status(201).json({ id: report.id });
    }
    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password' });
      const { meta } = await callServer('/reports');
      return res.status(200).json({ reports: meta.reports });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}

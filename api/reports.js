import { randomUUID } from 'node:crypto';
import { get, list, put } from '@vercel/blob';
import { inspectorAuthorized, isAdmin } from './_auth.js';

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

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
      .filter(m => typeof m.pathname === 'string' && m.pathname.startsWith('media/'))
      .map(m => ({ pathname: m.pathname, type: text(m.type, 100), name: text(m.name, 200) })),
  }));
  const areaNotes = (Array.isArray(body.areaNotes) ? body.areaNotes : []).slice(0, 100)
    .map(n => ({ floor: text(n.floor, 30), area: text(n.area, 200), note: text(n.note, 2000).trim() }))
    .filter(n => n.note);
  const areas = (Array.isArray(body.areas) ? body.areas : []).slice(0, 100).map(a => ({
    floor: text(a.floor, 30),
    name: text(a.name, 200),
    note: text(a.note, 2000).trim(),
    items: (Array.isArray(a.items) ? a.items : []).slice(0, 60).map(i => ({ text: text(i.text, 400), status: ['pass', 'fail'].includes(i.status) ? i.status : 'unchecked' })),
  }));
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

async function readJson(pathname) {
  const blob = await get(pathname, { access: 'private', useCache: false });
  if (!blob || blob.statusCode !== 200) return null;
  return JSON.parse(await new Response(blob.stream).text());
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      if (!inspectorAuthorized(req)) return res.status(401).json({ error: 'Sign in again' });
      const report = clean(req.body);
      const reportPath = `reports/${report.date}-${report.id}.json`;
      await put(reportPath, JSON.stringify(report), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
      // Queue it for the WhatsApp forwarder (see api/outbox.js).
      await put(`outbox/${report.id}.json`, JSON.stringify({ id: report.id, reportPath }), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      });
      return res.status(201).json({ id: report.id });
    }
    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Wrong password' });
      const { blobs } = await list({ prefix: 'reports/' });
      const newest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)).slice(0, 30);
      const reports = (await Promise.all(newest.map(b => readJson(b.pathname)))).filter(Boolean);
      return res.status(200).json({ reports });
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

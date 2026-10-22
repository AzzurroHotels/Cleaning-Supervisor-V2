#!/usr/bin/env node
// Allen cleaning report server. Runs on the OpenClaw machine and:
//   - saves submitted reports in a SQLite database and photos on disk
//   - builds the detailed PDF and posts it to the WhatsApp group through OpenClaw (with retries)
//   - answers the website (Vercel) for the manager page
// The website talks to it with sealed, signed requests (see lib/seal.js); it only listens on localhost
// and is reached through an nginx entry.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { open, pack, seal, unpack, verify } from './seal.mjs';
import { buildReportPdf, captionFor, reportFilename } from './report-pdf.mjs';

const run = promisify(execFile);
const {
  SERVER_SECRET,
  WHATSAPP_GROUP = '',
  PORT = '8788',
  DATA_DIR = '/var/lib/cleaning-report-service',
  SITE_URL = 'https://allen-cleaning-checklist.vercel.app',
  OPENCLAW_BIN = 'openclaw',
} = process.env;
if (!SERVER_SECRET || SERVER_SECRET.length < 24) { console.error('SERVER_SECRET (24+ characters) is required'); process.exit(1); }

const photosDir = path.join(DATA_DIR, 'photos'), outDir = path.join(DATA_DIR, 'out');
fs.mkdirSync(photosDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'reports.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports(
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT);
  CREATE TABLE IF NOT EXISTS photos(
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, name TEXT, size INTEGER, report_id TEXT);
`);

const MAX_BODY = 9 * 1024 * 1024, MAX_PHOTO = 6 * 1024 * 1024, MAX_ATTEMPTS = 8;
const ID = /^[0-9a-f-]{36}$/;
const seen = new Map();                                    // nonce -> expiry, blocks replayed requests

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const isImage = b => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);
const markSent = id => db.prepare("UPDATE reports SET status='sent', last_error=NULL, sent_at=? WHERE id=?").run(new Date().toISOString(), id);

const routes = {
  async '/photo'({ meta, bytes }) {
    if (!bytes.length || bytes.length > MAX_PHOTO || !isImage(bytes)) throw Object.assign(new Error('Only JPEG or PNG photos up to 6 MB are accepted'), { code: 400 });
    const id = randomUUID();
    fs.writeFileSync(path.join(photosDir, id), bytes);
    db.prepare('INSERT INTO photos(id,created_at,type,name,size) VALUES(?,?,?,?,?)').run(id, new Date().toISOString(), bytes[0] === 0xff ? 'image/jpeg' : 'image/png', String(meta.name || '').slice(0, 200), bytes.length);
    return { meta: { id } };
  },
  async '/submit'({ meta: report }) {
    if (!report || typeof report !== 'object' || !ID.test(report.id || '') || !Array.isArray(report.failures)) throw Object.assign(new Error('Invalid report'), { code: 400 });
    const photoIds = [...report.failures.flatMap(f => (f.media || []).map(m => m.id)), ...(report.areas || []).flatMap(a => (a.media || []).map(m => m.id))];
    for (const id of photoIds) {
      const row = ID.test(id) && db.prepare('SELECT report_id FROM photos WHERE id=?').get(id);
      if (!row || (row.report_id && row.report_id !== report.id)) throw Object.assign(new Error('A photo is missing. Please attach it again.'), { code: 400 });
    }
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO reports(id,created_at,date,data) VALUES(?,?,?,?)').run(report.id, report.submittedAt, report.date, JSON.stringify(report));
      for (const id of photoIds) db.prepare('UPDATE photos SET report_id=? WHERE id=?').run(report.id, id);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err.message.includes('UNIQUE') ? Object.assign(new Error('Report already submitted'), { code: 409 }) : err; }
    setImmediate(tick);
    return { meta: { id: report.id } };
  },
  async '/reports'() {
    const rows = db.prepare('SELECT data,status,attempts,last_error,sent_at FROM reports ORDER BY created_at DESC LIMIT 30').all();
    return { meta: { reports: rows.map(r => ({ ...JSON.parse(r.data), delivery: { status: r.status, attempts: r.attempts, error: r.last_error, sentAt: r.sent_at } })) } };
  },
  async '/resend'({ meta }) {
    if (!ID.test(meta.id || '')) throw Object.assign(new Error('Invalid id'), { code: 400 });
    db.prepare("UPDATE reports SET status='pending', attempts=0, next_attempt=0, last_error=NULL WHERE id=?").run(meta.id);
    setImmediate(tick);
    return { meta: { ok: true } };
  },
};

async function handle(req, res) {
  const send = (code, meta, bytes) => {
    const body = seal(SERVER_SECRET, pack(meta, bytes));
    res.writeHead(code, { 'content-type': 'application/octet-stream', 'content-length': body.length });
    res.end(body);
  };
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, pending: db.prepare("SELECT count(*) c FROM reports WHERE status='pending'").get().c }));
    }
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' });
    const body = await readBody(req);
    const ts = String(req.headers['x-ts'] || ''), nonce = String(req.headers['x-nonce'] || '');
    const route = req.url.split('?')[0];
    for (const [n, exp] of seen) if (exp < Date.now()) seen.delete(n);
    if (!nonce || seen.has(nonce) || Math.abs(Date.now() - Number(ts)) > 120000 || !verify(SERVER_SECRET, { method: 'POST', route, ts, nonce, body }, req.headers['x-sig'])) {
      res.writeHead(401); return res.end();
    }
    seen.set(nonce, Date.now() + 5 * 60000);
    const msg = unpack(open(SERVER_SECRET, body));
    const photo = route.match(/^\/photo\/([0-9a-f-]{36})$/);
    if (photo) {
      const row = db.prepare('SELECT type FROM photos WHERE id=?').get(photo[1]);
      if (!row) return send(404, { error: 'Not found' });
      return send(200, { type: row.type }, fs.readFileSync(path.join(photosDir, photo[1])));
    }
    if (!routes[route]) return send(404, { error: 'Not found' });
    const out = await routes[route](msg);
    return send(200, out.meta, out.bytes);
  } catch (err) {
    console.error(`${req.url}: ${err.message}`);
    if (!res.headersSent) return send(err.code && err.code < 600 ? err.code : 400, { error: err.code && err.code < 500 ? err.message : 'Report server error' });
  }
}

// --- WhatsApp delivery -------------------------------------------------------------------------
let busy = false;
async function deliver(row) {
  const report = JSON.parse(row.data), dir = path.join(outDir, row.id);
  try {
    if (!WHATSAPP_GROUP) throw new Error('WHATSAPP_GROUP is not set');
    const pdf = await buildReportPdf(report, { adminUrl: `${SITE_URL}/admin.html`, loadMedia: async id => ID.test(id) ? new Uint8Array(fs.readFileSync(path.join(photosDir, id))) : null });
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, reportFilename(report));
    fs.writeFileSync(file, pdf);
    const { stdout } = await run(OPENCLAW_BIN, ['message', 'send', '--channel', 'whatsapp', '--target', WHATSAPP_GROUP, '--media', file, '--message', captionFor(report), '--json'], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
    const json = stdout.slice(stdout.indexOf('{'));
    let failure = null;
    try { if (JSON.parse(json).ok === false) failure = json.slice(0, 300); } catch { /* output was not JSON: treat the zero exit code as success */ }
    if (failure) throw new Error(failure);
    markSent(row.id);
    console.log(`sent ${row.id} to WhatsApp`);
  } catch (err) {
    const attempts = row.attempts + 1;
    // Prefer what OpenClaw itself printed over "Command failed: <long command line>"
    const said = String(err.stderr || err.stdout || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[plugins]')).slice(-2).join(' | ');
    const reason = (said || err.message).slice(0, 300);
    db.prepare('UPDATE reports SET status=?, attempts=?, next_attempt=?, last_error=? WHERE id=?')
      .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, Date.now() + Math.min(2 ** attempts * 30000, 3600000), reason, row.id);
    console.error(`delivery of ${row.id} failed (attempt ${attempts}): ${reason}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const row = db.prepare("SELECT * FROM reports WHERE status='pending' AND next_attempt<=? ORDER BY created_at LIMIT 1").get(Date.now());
    if (row) await deliver(row);
  } catch (err) { console.error(`worker: ${err.message}`); } finally { busy = false; }
}
setInterval(tick, 5000);
setInterval(() => {                                       // drop photos that were uploaded but never attached to a report
  for (const p of db.prepare("SELECT id FROM photos WHERE report_id IS NULL AND created_at < ?").all(new Date(Date.now() - 24 * 3600000).toISOString())) {
    fs.rmSync(path.join(photosDir, p.id), { force: true });
    db.prepare('DELETE FROM photos WHERE id=?').run(p.id);
  }
}, 3600000);

http.createServer(handle).listen(Number(PORT), '127.0.0.1', () => console.log(`report server on 127.0.0.1:${PORT}, data in ${DATA_DIR}`));

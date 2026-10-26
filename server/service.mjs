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
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { open, pack, seal, unpack, verify } from './seal.mjs';
import { buildReportPdf, captionFor, reportFilename } from './report-pdf.mjs';

const run = promisify(execFile);
const {
  SERVER_SECRET,
  WHATSAPP_GROUP = '',
  WHATSAPP_GROUPS = '',
  PORT = '8788',
  DATA_DIR = '/var/lib/cleaning-report-service',
  SITE_URL = 'https://allen-cleaning-checklist.vercel.app',
  OPENCLAW_BIN = 'openclaw',
} = process.env;
if (!SERVER_SECRET || SERVER_SECRET.length < 24) { console.error('SERVER_SECRET (24+ characters) is required'); process.exit(1); }
// The Cleaning Inspection group is included by default alongside WHATSAPP_GROUP.
// Set WHATSAPP_GROUPS (comma-separated) to override the whole list.
const DEFAULT_EXTRA_GROUPS = ['120363429178555205@g.us'];
// A bare group ID longer than a phone number is normalised to the WhatsApp group JID.
const groupTarget = target => /^\d{16,}$/.test(target) ? `${target}@g.us` : target;
const configuredTargets = WHATSAPP_GROUPS || [WHATSAPP_GROUP, ...DEFAULT_EXTRA_GROUPS].join(',');
const TARGETS = [...new Set(String(configuredTargets).split(',').map(t => groupTarget(t.trim())).filter(Boolean))];
const DELIVERY_TARGETS = TARGETS.length ? TARGETS : [''];
const PRIMARY_TARGET = WHATSAPP_GROUPS ? (TARGETS[0] || '') : (groupTarget(String(WHATSAPP_GROUP).trim()) || TARGETS[0] || '');
if (!TARGETS.length) console.warn('WHATSAPP_GROUP(S) is not set: reports will be saved but cannot be sent');

const photosDir = path.join(DATA_DIR, 'photos'), outDir = path.join(DATA_DIR, 'out');
fs.mkdirSync(photosDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'reports.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reports(
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, content_hash TEXT, client_hash TEXT);
  CREATE TABLE IF NOT EXISTS photos(
    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, type TEXT NOT NULL, name TEXT, size INTEGER, report_id TEXT);
  CREATE TABLE IF NOT EXISTS deliveries(
    report_id TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, sent_at TEXT, PRIMARY KEY(report_id, target));
`);

const MAX_BODY = 9 * 1024 * 1024, MAX_PHOTO = 6 * 1024 * 1024, MAX_ATTEMPTS = 8;
const ID = /^[0-9a-f-]{36}$/;
const seen = new Map();                                    // nonce -> expiry, blocks replayed requests

// A fresh report ID is created by the web app for every request.  Do not use it
// for duplicate detection: a second tap would otherwise look like a new report.
// Photo IDs are also transient, so fingerprint the actual image bytes instead.
const photoFingerprint = id => createHash('sha256').update(fs.readFileSync(path.join(photosDir, id))).digest('hex');
const reportFingerprint = report => {
  const media = list => (list || []).map(m => ({ type: m.type, image: photoFingerprint(m.id) }));
  const value = {
    name: report.name, date: report.date,
    failures: report.failures.map(f => ({ id: f.id, status: f.status, floor: f.floor, area: f.area, item: f.item, recheckedAt: f.recheckedAt, location: f.location, notes: f.notes, media: media(f.media) })),
    areas: (report.areas || []).map(a => ({ floor: a.floor, name: a.name, note: a.note, media: media(a.media), items: a.items })),
    areaNotes: report.areaNotes || [], summary: report.summary,
    recheck: report.recheck, handoverDone: report.handoverDone, handover: report.handover,
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
};

// Existing installations predate content_hash. Backfill what can be read, then
// let SQLite enforce the guard even when two requests arrive at once.
try { db.exec('ALTER TABLE reports ADD COLUMN content_hash TEXT'); } catch (err) { if (!/duplicate column name/i.test(err.message)) throw err; }
try { db.exec('ALTER TABLE reports ADD COLUMN client_hash TEXT'); } catch (err) { if (!/duplicate column name/i.test(err.message)) throw err; }
for (const row of db.prepare('SELECT id,data FROM reports WHERE content_hash IS NULL ORDER BY created_at DESC').all()) {
  try {
    const hash = reportFingerprint(JSON.parse(row.data));
    if (!db.prepare('SELECT 1 FROM reports WHERE content_hash=?').get(hash)) db.prepare('UPDATE reports SET content_hash=? WHERE id=?').run(hash, row.id);
  } catch { /* Keep an unreadable legacy record unindexed rather than preventing startup. */ }
}
// Reports saved after the API started sending snapshotHash but before this
// version was running still carry it inside data, so index what is available.
for (const row of db.prepare('SELECT id,data FROM reports WHERE client_hash IS NULL ORDER BY created_at DESC').all()) {
  try {
    const hash = JSON.parse(row.data).snapshotHash;
    if (!/^[0-9a-f]{64}$/.test(hash || '')) continue;
    if (!db.prepare('SELECT 1 FROM reports WHERE client_hash=?').get(hash)) db.prepare('UPDATE reports SET client_hash=? WHERE id=?').run(hash, row.id);
  } catch { /* Keep an unreadable legacy record unindexed rather than preventing startup. */ }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reports_content_hash_unique ON reports(content_hash) WHERE content_hash IS NOT NULL');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS reports_client_hash_unique ON reports(client_hash) WHERE client_hash IS NOT NULL');
// Give reports saved before per-group tracking a delivery row for the original
// group only, so adding a new group does not resend old reports to it.
for (const r of db.prepare('SELECT id,status,attempts,next_attempt,last_error,sent_at FROM reports WHERE id NOT IN (SELECT report_id FROM deliveries)').all()) {
  db.prepare('INSERT OR IGNORE INTO deliveries(report_id,target,status,attempts,next_attempt,last_error,sent_at) VALUES(?,?,?,?,?,?,?)').run(r.id, PRIMARY_TARGET, r.status, r.attempts, r.next_attempt, r.last_error, r.sent_at);
}

const readBody = req => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const isImage = b => (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) || (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47);

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
    const contentHash = reportFingerprint(report);
    // Photos are uploaded again for every attempt and may be re-encoded, so the
    // content hash alone can miss an unchanged resubmission. The snapshot hash
    // comes from the checklist itself and stays the same until something changes.
    const clientHash = typeof report.snapshotHash === 'string' && /^[0-9a-f]{64}$/.test(report.snapshotHash) ? report.snapshotHash : null;
    const findExisting = () => clientHash
      ? db.prepare('SELECT id FROM reports WHERE content_hash=? OR client_hash=?').get(contentHash, clientHash)
      : db.prepare('SELECT id FROM reports WHERE content_hash=?').get(contentHash);
    const alreadySubmitted = findExisting();
    if (alreadySubmitted) return { meta: { id: alreadySubmitted.id, duplicate: true } };
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO reports(id,created_at,date,data,content_hash,client_hash) VALUES(?,?,?,?,?,?)').run(report.id, report.submittedAt, report.date, JSON.stringify(report), contentHash, clientHash);
      for (const target of DELIVERY_TARGETS) db.prepare('INSERT OR IGNORE INTO deliveries(report_id,target) VALUES(?,?)').run(report.id, target);
      for (const id of photoIds) db.prepare('UPDATE photos SET report_id=? WHERE id=?').run(report.id, id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      // The unique indexes also cover the small race between the lookup above
      // and the insert. Return the original report rather than queueing a resend.
      if (err.message.includes('UNIQUE')) {
        const existing = findExisting();
        if (existing) return { meta: { id: existing.id, duplicate: true } };
        throw Object.assign(new Error('Report already submitted'), { code: 409 });
      }
      throw err;
    }
    setImmediate(tick);
    return { meta: { id: report.id } };
  },
  async '/reports'() {
    const rows = db.prepare('SELECT id,data,status,attempts,last_error,sent_at FROM reports ORDER BY created_at DESC LIMIT 30').all();
    return { meta: { reports: rows.map(r => ({
      ...JSON.parse(r.data),
      delivery: { status: r.status, attempts: r.attempts, error: r.last_error, sentAt: r.sent_at, targets: db.prepare('SELECT target,status,attempts,last_error,sent_at FROM deliveries WHERE report_id=?').all(r.id) },
    })) } };
  },
  async '/resend'({ meta }) {
    if (!ID.test(meta.id || '') || !db.prepare('SELECT 1 FROM reports WHERE id=?').get(meta.id)) throw Object.assign(new Error('Invalid id'), { code: 400 });
    // Include groups added after this report was submitted. If they never got
    // it, only those missing groups send; otherwise this is a full resend.
    for (const target of DELIVERY_TARGETS) db.prepare('INSERT OR IGNORE INTO deliveries(report_id,target) VALUES(?,?)').run(meta.id, target);
    const deliveries = db.prepare('SELECT status FROM deliveries WHERE report_id=?').all(meta.id);
    if (deliveries.every(d => d.status === 'sent')) {
      db.prepare("UPDATE deliveries SET status='pending', attempts=0, next_attempt=0, last_error=NULL, sent_at=NULL WHERE report_id=?").run(meta.id);
    } else {
      db.prepare("UPDATE deliveries SET status='pending', attempts=0, next_attempt=0, last_error=NULL WHERE report_id=? AND status!='sent'").run(meta.id);
    }
    refreshReport(meta.id);
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

// Reports keep an aggregate delivery status for the manager page. Each group
// has its own row so a retry never sends the PDF to a group that already got it.
function refreshReport(id) {
  const rows = db.prepare('SELECT status,attempts,next_attempt,last_error,sent_at FROM deliveries WHERE report_id=?').all(id);
  if (!rows.length) return;
  const attempts = Math.max(...rows.map(r => r.attempts));
  if (rows.every(r => r.status === 'sent')) {
    const sentAt = rows.map(r => r.sent_at).filter(Boolean).sort().pop() || new Date().toISOString();
    db.prepare("UPDATE reports SET status='sent', attempts=?, next_attempt=0, last_error=NULL, sent_at=? WHERE id=?").run(attempts, sentAt, id);
    return;
  }
  if (rows.some(r => r.status === 'pending')) {
    const pending = rows.filter(r => r.status === 'pending');
    const error = rows.filter(r => r.status !== 'sent').map(r => r.last_error).filter(Boolean).join(' | ').slice(0, 300) || null;
    db.prepare("UPDATE reports SET status='pending', attempts=?, next_attempt=?, last_error=? WHERE id=?").run(attempts, Math.min(...pending.map(r => r.next_attempt)), error, id);
    return;
  }
  const error = rows.map(r => r.last_error).filter(Boolean).join(' | ').slice(0, 300) || 'WhatsApp delivery failed';
  db.prepare("UPDATE reports SET status='failed', attempts=?, next_attempt=0, last_error=? WHERE id=?").run(attempts, error, id);
}

async function deliverReport(id, data) {
  const report = JSON.parse(data), dir = path.join(outDir, id);
  const due = db.prepare("SELECT target,attempts FROM deliveries WHERE report_id=? AND status='pending' AND next_attempt<=? ORDER BY target").all(id, Date.now());
  if (!due.length) return;
  let file = null, pdfError = null;
  try {
    const pdf = await buildReportPdf(report, { adminUrl: `${SITE_URL}/admin.html`, loadMedia: async photoId => ID.test(photoId) ? new Uint8Array(fs.readFileSync(path.join(photosDir, photoId))) : null });
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, reportFilename(report));
    fs.writeFileSync(file, pdf);
  } catch (err) { pdfError = err; }
  for (const delivery of due) {
    try {
      if (pdfError) throw pdfError;
      if (!delivery.target) throw new Error('WHATSAPP_GROUP(S) is not set');
      const { stdout } = await run(OPENCLAW_BIN, ['message', 'send', '--channel', 'whatsapp', '--target', delivery.target, '--media', file, '--message', captionFor(report), '--json'], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      const json = stdout.slice(stdout.indexOf('{'));
      let failure = null;
      try { if (JSON.parse(json).ok === false) failure = json.slice(0, 300); } catch { /* output was not JSON: treat the zero exit code as success */ }
      if (failure) throw new Error(failure);
      db.prepare("UPDATE deliveries SET status='sent', last_error=NULL, sent_at=? WHERE report_id=? AND target=?").run(new Date().toISOString(), id, delivery.target);
      console.log(`sent ${id} to ${delivery.target}`);
    } catch (err) {
      const attempts = delivery.attempts + 1;
      // Prefer what OpenClaw itself printed over "Command failed: <long command line>"
      const said = String(err.stderr || err.stdout || '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('[plugins]')).slice(-2).join(' | ');
      const reason = ((delivery.target ? delivery.target + ': ' : '') + (said || err.message)).slice(0, 300);
      db.prepare('UPDATE deliveries SET status=?, attempts=?, next_attempt=?, last_error=? WHERE report_id=? AND target=?')
        .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, Date.now() + Math.min(2 ** attempts * 30000, 3600000), reason, id, delivery.target);
      console.error(`delivery of ${id} to ${delivery.target || '(not configured)'} failed (attempt ${attempts}): ${reason}`);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  refreshReport(id);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const row = db.prepare(`SELECT r.id,r.data FROM reports r WHERE EXISTS (
      SELECT 1 FROM deliveries d WHERE d.report_id=r.id AND d.status='pending' AND d.next_attempt<=?
    ) ORDER BY r.created_at, r.id LIMIT 1`).get(Date.now());
    if (row) await deliverReport(row.id, row.data);
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

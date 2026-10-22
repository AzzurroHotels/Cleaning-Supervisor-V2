// Starts the real report server with a stand-in for `openclaw` and drives it the way the website does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, pack, seal, sign, unpack } from '../lib/seal.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, 'server', '.test-bundle');          // inside the repo so pdf-lib resolves
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
const SECRET = 'test-secret-with-more-than-24-characters';
const PORT = 18700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
let server;

const fake = path.join(tmp, 'openclaw');
fs.writeFileSync(fake, `#!/bin/sh
if [ -f "${tmp}/FAIL" ]; then echo "simulated WhatsApp failure" >&2; exit 1; fi
echo "$@" >> "${tmp}/calls.log"
for a in "$@"; do case "$a" in *.pdf) cp "$a" "${tmp}/last.pdf";; esac; done
echo '[plugins] noise before the json'
echo '{"ok": true}'
`, { mode: 0o755 });

async function call(route, meta = {}, bytes = Buffer.alloc(0), tweak = {}) {
  const body = seal(SECRET, pack(meta, bytes));
  const ts = tweak.ts ?? String(Date.now()), nonce = tweak.nonce ?? randomUUID();
  const sig = sign(tweak.secret ?? SECRET, { method: 'POST', route, ts, nonce, body });
  const res = await fetch(BASE + route, { method: 'POST', body: tweak.body ?? body, headers: { 'x-ts': ts, 'x-nonce': nonce, 'x-sig': tweak.sig ?? sig } });
  const buf = Buffer.from(await res.arrayBuffer());
  let reply = null;
  try { reply = unpack(open(SECRET, buf)); } catch { /* unsealed (e.g. 401) */ }
  return { status: res.status, reply };
}

const reportWith = photoId => ({
  id: randomUUID(), submittedAt: new Date().toISOString(), name: 'Inspector', date: '2026-10-22',
  failures: [{ id: '0-0', status: 'fail', floor: 'Ground floor', area: 'Entrance', item: 'Doors clean', recheckedAt: '', location: 'Front door', notes: 'Smudged glass', media: photoId ? [{ id: photoId, type: 'image/png', name: 'a.png' }] : [] }],
  areas: [{ floor: 'Ground floor', name: 'Entrance', note: 'Mat replaced', items: [{ text: 'Doors clean', status: 'fail' }, { text: 'Floor clean', status: 'pass' }] }],
  areaNotes: [{ floor: 'Ground floor', area: 'Entrance', note: 'Mat replaced' }],
  summary: '', recheck: true, handoverDone: false, handover: 'All good',
});

const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 250)); }
};

before(async () => {
  execFileSync('sh', [path.join(root, 'server', 'bundle.sh'), bundle], { stdio: 'ignore' });
  server = spawn(process.execPath, [path.join(bundle, 'service.mjs')], {
    env: { ...process.env, SERVER_SECRET: SECRET, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), WHATSAPP_GROUP: 'fake@g.us', OPENCLAW_BIN: fake },
    stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } });
});

after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(bundle, { recursive: true, force: true }); });

test('a photo and a report are saved, and the PDF is posted to WhatsApp', async () => {
  const up = await call('/photo', { name: 'a.png' }, PNG);
  assert.equal(up.status, 200);
  const report = reportWith(up.reply.meta.id);
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');
  const args = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8');
  assert.match(args, /message send --channel whatsapp --target fake@g\.us --media .*Allen-cleaning-report-2026-10-22\.pdf --message/);
  assert.match(args, /Passed 1 \| Failed 1/);
  const pdf = fs.readFileSync(path.join(tmp, 'last.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert(pdf.length > 3000, 'PDF should contain real content');
  const saved = (await call('/reports')).reply.meta.reports.find(r => r.id === report.id);
  assert.equal(saved.failures[0].notes, 'Smudged glass');
  assert.equal(saved.areas[0].note, 'Mat replaced');
  const photo = await call('/photo/' + up.reply.meta.id);
  assert.equal(photo.status, 200);
  assert.equal(photo.reply.meta.type, 'image/png');
  assert(photo.reply.bytes.equals(PNG), 'photo comes back byte for byte');
});

test('unsigned, tampered, replayed and stale requests are refused', async () => {
  assert.equal((await fetch(BASE + '/reports', { method: 'POST', body: 'hello' })).status, 401);
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { secret: 'a-different-secret-that-is-long-enough' })).status, 401);
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { sig: 'ab'.repeat(32) })).status, 401);
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { ts: String(Date.now() - 10 * 60000) })).status, 401);
  const nonce = randomUUID();
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { nonce })).status, 200);
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { nonce })).status, 401);   // same nonce again
  const body = seal(SECRET, pack({}));
  body[body.length - 1] ^= 1;                                                               // flip one bit
  assert.equal((await call('/reports', {}, Buffer.alloc(0), { body })).status, 401);
});

test('bad uploads and bad reports are rejected', async () => {
  assert.equal((await call('/photo', { name: 'x.txt' }, Buffer.from('not an image'))).status, 400);
  assert.equal((await call('/photo', {}, Buffer.alloc(0))).status, 400);
  assert.equal((await call('/submit', reportWith(randomUUID()))).status, 400);              // photo that was never uploaded
  assert.equal((await call('/submit', { id: 'nope' })).status, 400);
  const ok = reportWith(null);
  assert.equal((await call('/submit', ok)).status, 200);
  assert.equal((await call('/submit', ok)).status, 409);                                    // same report twice
  assert.equal((await call('/nothing-here')).status, 404);
  assert.equal((await call('/photo/' + randomUUID())).status, 404);
});

test('a failed WhatsApp send is kept and retried when the manager resends', async () => {
  fs.writeFileSync(path.join(tmp, 'FAIL'), '');
  const report = reportWith(null);
  assert.equal((await call('/submit', report)).status, 200);
  const failed = await until(async () => { const r = (await call('/reports')).reply.meta.reports.find(x => x.id === report.id); return r.delivery.attempts >= 1 ? r : null; });
  assert.equal(failed.delivery.status, 'pending');
  assert.match(failed.delivery.error, /simulated WhatsApp failure/);
  fs.rmSync(path.join(tmp, 'FAIL'));
  assert.equal((await call('/resend', { id: report.id })).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(x => x.id === report.id).delivery.status === 'sent');
});

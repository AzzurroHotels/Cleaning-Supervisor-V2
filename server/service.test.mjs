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
fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs'), path=require('node:path');
const tmp=${JSON.stringify(tmp)};
const args=process.argv.slice(2);
const flag=name=>fs.existsSync(path.join(tmp,name));
const read=name=>flag(name)?fs.readFileSync(path.join(tmp,name),'utf8').trim():'';
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:'';};
const target=opt('--target'), media=opt('--media'), delivered=path.join(tmp,'delivered.jsonl');
const record=()=>fs.appendFileSync(delivered,JSON.stringify({target,file:path.basename(media||'')})+'\\n');
if(args[0]==='sessions'){
  console.log(JSON.stringify({sessions:['fake@g.us','120363000000000000@g.us'].map(t=>({key:'agent:main:whatsapp:group:'+t}))}));
  process.exit(0);
}
if(args[0]==='gateway'&&args[1]==='call'&&args[2]==='chat.history'){
  const params=JSON.parse(opt('--params')||'{}'), key=String(params.sessionKey||'');
  const group=key.split('whatsapp:group:').pop();
  const rows=flag('delivered.jsonl')?fs.readFileSync(delivered,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
  console.log(JSON.stringify({messages:rows.filter(x=>x.target===group).map(x=>({text:x.file}))}));
  process.exit(0);
}
if(args[0]!=='message'||args[1]!=='send'){console.error('unexpected command');process.exit(2);}
fs.appendFileSync(path.join(tmp,'attempts.log'),args.join(' ')+'\\n');
if(flag('FAIL')){console.error('simulated WhatsApp failure');process.exit(1);}
if(flag('FAIL_TARGET')&&target===read('FAIL_TARGET')){console.error('simulated group failure');process.exit(1);}
if(flag('UNCERTAIN_TARGET')&&target===read('UNCERTAIN_TARGET')&&flag('UNCERTAIN_UNSENT')){console.error('simulated uncertain failure');process.exit(1);}
if(flag('UNCERTAIN_TARGET')&&target===read('UNCERTAIN_TARGET')&&flag('UNCERTAIN_SENT')){
  record();
  console.error('simulated uncertain result after delivery');
  process.exit(1);
}
fs.appendFileSync(path.join(tmp,'calls.log'),args.join(' ')+'\\n');
record();
if(media) fs.copyFileSync(media,path.join(tmp,'last.pdf'));
console.log('[plugins] noise before the json');
console.log('{"ok": true}');
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
    env: { ...process.env, SERVER_SECRET: SECRET, PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), WHATSAPP_GROUPS: 'fake@g.us, 120363000000000000', OPENCLAW_BIN: fake },
    stdio: 'ignore',
  });
  await until(async () => { try { return (await fetch(BASE + '/health')).ok; } catch { return false; } });
});

after(async () => {
  if (server) {
    const done = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await Promise.race([done, new Promise(resolve => { const t = setTimeout(resolve, 5000); t.unref(); })]);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bundle, { recursive: true, force: true });
});

test('a photo and a report are saved, and the PDF is posted to WhatsApp', async () => {
  const up = await call('/photo', { name: 'a.png' }, PNG);
  assert.equal(up.status, 200);
  const report = reportWith(up.reply.meta.id);
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');
  const args = fs.readFileSync(path.join(tmp, 'calls.log'), 'utf8');
  assert.match(args, /message send --channel whatsapp --target fake@g\.us --media .*Allen-cleaning-report-2026-10-22-[0-9a-f]+\.pdf --message/);
  assert.match(args, /message send --channel whatsapp --target 120363000000000000@g\.us --media .*Allen-cleaning-report-2026-10-22-[0-9a-f]+\.pdf --message/);
  assert.match(args, /Passed 1 \| Failed 1/);
  const pdf = fs.readFileSync(path.join(tmp, 'last.pdf'));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert(pdf.length > 3000, 'PDF should contain real content');
  const saved = (await call('/reports')).reply.meta.reports.find(r => r.id === report.id);
  assert.equal(saved.failures[0].notes, 'Smudged glass');
  assert.equal(saved.areas[0].note, 'Mat replaced');
  assert.deepEqual(saved.delivery.targets.map(t => [t.target, t.status]).sort(), [['120363000000000000@g.us', 'sent'], ['fake@g.us', 'sent']]);
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
  const repeated = await call('/submit', ok);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.reply.meta.duplicate, true);                                        // same report is not queued twice
  assert.equal((await call('/nothing-here')).status, 404);
  assert.equal((await call('/photo/' + randomUUID())).status, 404);
});

test('an unchanged report is sent once, but a changed report is accepted', async () => {
  const report = reportWith(null);
  report.failures[0].notes = 'Fingerprint test: original finding';
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');

  const repeat = { ...report, id: randomUUID(), submittedAt: new Date(Date.now() + 1000).toISOString() };
  const duplicate = await call('/submit', repeat);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.reply.meta.duplicate, true);
  assert.equal(duplicate.reply.meta.id, report.id);
  assert.equal((await call('/reports')).reply.meta.reports.some(r => r.id === repeat.id), false);

  const changed = { ...repeat, id: randomUUID(), failures: repeat.failures.map(f => ({ ...f, notes: 'Glass has been cleaned' })) };
  const accepted = await call('/submit', changed);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.reply.meta.duplicate, undefined);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === changed.id)?.delivery.status === 'sent');
});

test('an unchanged report stays a duplicate even when its photo is uploaded again with different bytes', async () => {
  const first = await call('/photo', { name: 'a.png' }, PNG);
  const report = reportWith(first.reply.meta.id);
  report.failures[0].notes = 'Client snapshot dedupe test';
  report.snapshotHash = 'a'.repeat(64);
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');

  const again = await call('/photo', { name: 'a.png' }, Buffer.concat([PNG, Buffer.from([0])]));
  const repeat = {
    ...report, id: randomUUID(), submittedAt: new Date(Date.now() + 1000).toISOString(),
    failures: report.failures.map(f => ({ ...f, media: [{ ...f.media[0], id: again.reply.meta.id }] })),
  };
  const duplicate = await call('/submit', repeat);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.reply.meta.duplicate, true);
  assert.equal(duplicate.reply.meta.id, report.id);
  assert.equal((await call('/reports')).reply.meta.reports.some(r => r.id === repeat.id), false);
});

test('legacy reports are deduped by checklist and photo metadata even when photos are re-encoded', async () => {
  const first = await call('/photo', { name: 'a.png' }, PNG);
  const report = reportWith(first.reply.meta.id);
  report.failures[0].notes = 'Legacy semantic test';
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');

  const again = await call('/photo', { name: 'a.png' }, Buffer.concat([PNG, Buffer.from([0])]));
  const repeat = {
    ...report, id: randomUUID(), submittedAt: new Date(Date.now() + 1000).toISOString(),
    failures: report.failures.map(f => ({ ...f, media: [{ ...f.media[0], id: again.reply.meta.id }] })),
  };
  const duplicate = await call('/submit', repeat);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.reply.meta.duplicate, true);
  assert.equal(duplicate.reply.meta.id, report.id);

  const changed = {
    ...repeat, id: randomUUID(), snapshotHash: 'b'.repeat(64),
    failures: repeat.failures.map(f => ({ ...f, notes: 'Legacy semantic test changed' })),
  };
  assert.equal((await call('/submit', changed)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === changed.id)?.delivery.status === 'sent');
});

test('room photos are saved with the report and reach the PDF', async () => {
  const up = await call('/photo', { name: 'room.png' }, PNG);
  const report = reportWith(null);
  report.areas[0].media = [{ id: up.reply.meta.id, type: 'image/png', name: 'room.png' }];
  assert.equal((await call('/submit', report)).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id)?.delivery.status === 'sent');
  const saved = (await call('/reports')).reply.meta.reports.find(r => r.id === report.id);
  assert.equal(saved.areas[0].media[0].id, up.reply.meta.id);
  assert((await call('/photo/' + up.reply.meta.id)).reply.bytes.equals(PNG));
  const bad = reportWith(null);
  bad.areas[0].media = [{ id: randomUUID(), type: 'image/png', name: 'x.png' }];
  assert.equal((await call('/submit', bad)).status, 400);                                   // room photo that was never uploaded
});

test('a failed WhatsApp send is kept and retried when the manager resends', async () => {
  fs.writeFileSync(path.join(tmp, 'FAIL'), '');
  const report = reportWith(null);
  report.failures[0].notes = 'Retry test finding';
  assert.equal((await call('/submit', report)).status, 200);
  const failed = await until(async () => { const r = (await call('/reports')).reply.meta.reports.find(x => x.id === report.id); return r.delivery.attempts >= 1 ? r : null; });
  assert.equal(failed.delivery.status, 'pending');
  assert.match(failed.delivery.error, /simulated WhatsApp failure/);
  fs.rmSync(path.join(tmp, 'FAIL'));
  assert.equal((await call('/resend', { id: report.id })).status, 200);
  await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id).delivery.status === 'sent');
});

test('a failure on one group does not resend to the group that already received it', async () => {
  const calls = path.join(tmp, 'calls.log'), marker = path.join(tmp, 'FAIL_TARGET');
  fs.writeFileSync(marker, '120363000000000000@g.us');
  try {
    const start = fs.existsSync(calls) ? fs.statSync(calls).size : 0;
    const report = reportWith(null);
    report.failures[0].notes = 'Per-group retry test';
    assert.equal((await call('/submit', report)).status, 200);
    const partial = await until(async () => {
      const r = (await call('/reports')).reply.meta.reports.find(x => x.id === report.id);
      const first = r.delivery.targets.find(t => t.target === 'fake@g.us'), second = r.delivery.targets.find(t => t.target === '120363000000000000@g.us');
      return first.status === 'sent' && second.attempts >= 1 ? r : null;
    });
    assert.equal(partial.delivery.status, 'pending');
    assert.match(partial.delivery.error, /simulated group failure/);
    fs.rmSync(marker);
    assert.equal((await call('/resend', { id: report.id })).status, 200);
    await until(async () => (await call('/reports')).reply.meta.reports.find(r => r.id === report.id).delivery.status === 'sent');
    const log = fs.readFileSync(calls, 'utf8').slice(start);
    assert.equal((log.match(/--target fake@g\.us/g) || []).length, 1);      // successful group is not sent again
    assert.equal((log.match(/--target 120363000000000000@g\.us/g) || []).length, 1);    // failed group is retried
  } finally { fs.rmSync(marker, { force: true }); }
});

test('an uncertain send that reached the group is marked sent and not retried', async () => {
  const target = '120363000000000000@g.us', marker = path.join(tmp, 'UNCERTAIN_TARGET'), sent = path.join(tmp, 'UNCERTAIN_SENT'), attempts = path.join(tmp, 'attempts.log');
  fs.writeFileSync(marker, target);
  fs.writeFileSync(sent, '1');
  try {
    const start = fs.existsSync(attempts) ? fs.statSync(attempts).size : 0;
    const report = reportWith(null);
    report.failures[0].notes = 'Uncertain delivered test';
    assert.equal((await call('/submit', report)).status, 200);
    const finished = await until(async () => {
      const r = (await call('/reports')).reply.meta.reports.find(x => x.id === report.id);
      return r.delivery.targets.find(t => t.target === target)?.status === 'sent' ? r : null;
    });
    assert.equal(finished.delivery.status, 'sent');
    await new Promise(resolve => setTimeout(resolve, 6000));                    // allow at least one worker interval
    const log = fs.readFileSync(attempts, 'utf8').slice(start);
    assert.equal((log.match(new RegExp('--target ' + target.replace('.', '\\.'), 'g')) || []).length, 1);
    assert.equal((log.match(/--target fake@g\.us/g) || []).length, 1);
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(sent, { force: true });
  }
});

test('an uncertain send that was not delivered is retried', async () => {
  const target = '120363000000000000@g.us', marker = path.join(tmp, 'UNCERTAIN_TARGET'), unsent = path.join(tmp, 'UNCERTAIN_UNSENT'), attempts = path.join(tmp, 'attempts.log');
  fs.writeFileSync(marker, target);
  fs.writeFileSync(unsent, '1');
  try {
    const start = fs.existsSync(attempts) ? fs.statSync(attempts).size : 0;
    const report = reportWith(null);
    report.failures[0].notes = 'Uncertain retry test';
    assert.equal((await call('/submit', report)).status, 200);
    const pending = await until(async () => {
      const r = (await call('/reports')).reply.meta.reports.find(x => x.id === report.id);
      const t = r.delivery.targets.find(t => t.target === target);
      return t.status === 'pending' && t.attempts >= 1 ? r : null;
    });
    assert.match(pending.delivery.error, /not found|retrying/i);
    fs.rmSync(marker);
    fs.rmSync(unsent);
    assert.equal((await call('/resend', { id: report.id })).status, 200);
    await until(async () => (await call('/reports')).reply.meta.reports.find(x => x.id === report.id).delivery.status === 'sent');
    const log = fs.readFileSync(attempts, 'utf8').slice(start);
    assert.equal((log.match(new RegExp('--target ' + target.replace('.', '\\.'), 'g')) || []).length, 2); // failed, then retried
    assert.equal((log.match(/--target fake@g\.us/g) || []).length, 1);
  } finally {
    fs.rmSync(marker, { force: true });
    fs.rmSync(unsent, { force: true });
  }
});

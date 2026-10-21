#!/usr/bin/env node
// Sends newly submitted cleaning reports (as PDF) to a WhatsApp group through OpenClaw.
// Runs once per invocation; a systemd timer calls it every 30 seconds.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const {
  OUTBOX_URL, OUTBOX_SECRET, WHATSAPP_GROUP,
  STATE_DIR = '/var/lib/cleaning-report-forwarder',
  OPENCLAW_BIN = 'openclaw',
} = process.env;

if (!OUTBOX_URL || !OUTBOX_SECRET || !WHATSAPP_GROUP) {
  console.error('Set OUTBOX_URL, OUTBOX_SECRET and WHATSAPP_GROUP (see /etc/cleaning-report-forwarder.env)');
  process.exit(1);
}

const api = async (p, init = {}) => {
  const res = await fetch(OUTBOX_URL + p, { ...init, headers: { authorization: 'Bearer ' + OUTBOX_SECRET, ...init.headers } });
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res;
};

// The site's list can lag a minute behind an acknowledgement, so remember what was already sent here
// to make sure the same report is never posted to the group twice.
const sentFile = path.join(STATE_DIR, 'sent.json');
const loadSent = async () => new Set(JSON.parse(await fs.readFile(sentFile, 'utf8').catch(() => '[]')));
const saveSent = sent => fs.writeFile(sentFile, JSON.stringify([...sent].slice(-500)));

await fs.mkdir(path.join(STATE_DIR, 'out'), { recursive: true });
const sent = await loadSent();
const { pending } = await (await api('/api/outbox')).json();
let failed = 0;

for (const item of pending.slice(0, 5)) {
  try {
    if (!sent.has(item.id)) {
      const dir = path.join(STATE_DIR, 'out', item.id);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, item.filename.replace(/[^\w.-]+/g, '_'));
      await fs.writeFile(file, Buffer.from(await (await api('/api/outbox?id=' + encodeURIComponent(item.id))).arrayBuffer()));
      const { stdout } = await run(OPENCLAW_BIN, ['message', 'send', '--channel', 'whatsapp', '--target', WHATSAPP_GROUP, '--media', file, '--message', item.caption, '--json'], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
      const result = stdout.slice(stdout.indexOf('{'));
      try { if (JSON.parse(result).ok === false) throw new Error(result.slice(0, 300)); } catch (e) { if (e.message.startsWith('{')) throw e; }
      sent.add(item.id);
      await saveSent(sent);
      await fs.rm(dir, { recursive: true, force: true });
      console.log(`sent ${item.id} (${item.filename})`);
    }
    await api('/api/outbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id }) });
  } catch (err) {
    failed++;
    console.error(`report ${item.id}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);

import { randomUUID } from 'node:crypto';
import { open, pack, seal, sign, unpack } from '../lib/seal.js';

// Calls the report server (SERVER_URL, reached over plain HTTP, so every call is sealed and signed).
export async function callServer(route, meta = {}, bytes = Buffer.alloc(0)) {
  const secret = process.env.SERVER_SECRET, base = process.env.SERVER_URL;
  if (!secret || !base) throw Object.assign(new Error('Report storage is not configured'), { status: 500 });
  const body = seal(secret, pack(meta, bytes));
  const ts = String(Date.now()), nonce = randomUUID();
  let res;
  try {
    res = await fetch(base + route, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/octet-stream', 'x-ts': ts, 'x-nonce': nonce, 'x-sig': sign(secret, { method: 'POST', route, ts, nonce, body }) },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    throw Object.assign(new Error('The report server is not reachable right now. Your checklist is still saved on this device; try again shortly.'), { status: 502 });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  let reply;
  try { reply = unpack(open(secret, buf)); } catch { throw Object.assign(new Error(`The report server refused the request (${res.status}).`), { status: 502 }); }
  if (!res.ok) throw Object.assign(new Error(reply.meta.error || `Report server error ${res.status}`), { status: res.status === 404 ? 404 : 400 });
  return reply;                                            // { meta, bytes }
}

// Shared by the Vercel functions and the report server. Everything that crosses between them is
// encrypted and authenticated here, because the report server is reached over plain HTTP:
//   - the body is sealed with AES-256-GCM (confidential and tamper-proof)
//   - each request is signed with HMAC-SHA256 over method, route, timestamp, nonce and body hash
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const derive = secret => {
  const k = Buffer.from(hkdfSync('sha256', String(secret), 'allen-cleaning-report', 'keys-v1', 64));
  return { enc: k.subarray(0, 32), mac: k.subarray(32) };
};

export function seal(secret, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derive(secret).enc, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(secret, sealed) {
  if (sealed.length < 28) throw new Error('Bad payload');
  const decipher = createDecipheriv('aes-256-gcm', derive(secret).enc, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

// A message is a small JSON object plus optional raw bytes (for photos).
export function pack(meta, bytes = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(meta ?? {}));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return Buffer.concat([head, json, bytes]);
}

export function unpack(buf) {
  const n = buf.readUInt32BE(0);
  return { meta: JSON.parse(buf.subarray(4, 4 + n).toString()), bytes: buf.subarray(4 + n) };
}

export function sign(secret, { method, route, ts, nonce, body }) {
  return createHmac('sha256', derive(secret).mac)
    .update([method, route, ts, nonce, createHash('sha256').update(body).digest('hex')].join('\n'))
    .digest('hex');
}

export function verify(secret, parts, signature) {
  const expected = Buffer.from(sign(secret, parts), 'hex');
  const given = Buffer.from(String(signature || ''), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const digest = s => createHash('sha256').update(String(s)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));
const bearer = req => (req.headers.authorization || '').replace(/^Bearer /, '');

// Management endpoints are closed unless ADMIN_PASSWORD is set in the Vercel project.
export function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return same(bearer(req), expected);
}

// The WhatsApp forwarder on the OpenClaw server authenticates with OUTBOX_SECRET.
export function isOutbox(req) {
  const expected = process.env.OUTBOX_SECRET;
  if (!expected) return false;
  return same(bearer(req), expected);
}

// Inspectors sign in with INSPECTOR_ID / INSPECTOR_PASSWORD and get a signed 30-day token.
// The signing key is derived from the credentials, so changing either one signs everyone out.
const key = () => createHash('sha256').update(['inspector', process.env.INSPECTOR_ID, process.env.INSPECTOR_PASSWORD, process.env.ADMIN_PASSWORD].join('\0')).digest();
const sign = exp => createHmac('sha256', key()).update(String(exp)).digest('hex');

export function checkInspector(id, password) {
  const { INSPECTOR_ID, INSPECTOR_PASSWORD } = process.env;
  if (!INSPECTOR_ID || !INSPECTOR_PASSWORD) return false;
  const idOk = same(id, INSPECTOR_ID), passwordOk = same(password, INSPECTOR_PASSWORD);
  return idOk && passwordOk;
}

export function issueToken() {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return `${exp}.${sign(exp)}`;
}

export function validToken(token) {
  if (!process.env.INSPECTOR_ID || !process.env.INSPECTOR_PASSWORD) return false;
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  return same(sig, sign(exp));
}

export const inspectorAuthorized = req => validToken(bearer(req));

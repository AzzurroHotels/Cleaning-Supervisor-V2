const crypto = require('node:crypto');
const { HttpError } = require('./util');
const { nowIso } = require('./db');

const COOKIE_NAME = 'allen_session';
const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  if (!expected.length) return false;
  const candidate = crypto.scryptSync(password, parts[1], KEY_LENGTH);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function validatePassword(password, field = 'Password') {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, field + ' must be at least 8 characters.');
  }
  if (password.length > 200) {
    throw new HttpError(400, field + ' is too long.');
  }
  return password;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      cookies[key] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function cookieOptions(req, days) {
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: Boolean(req.secure),
    path: '/'
  };
  if (days) options.maxAge = days * 24 * 60 * 60 * 1000;
  return options;
}

function setSessionCookie(res, req, token, days) {
  res.cookie(COOKIE_NAME, token, cookieOptions(req, days));
}

function clearSessionCookie(res, req) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

function createSession(db, userId, days) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = hashToken(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, createdAt, expiresAt);
  return token;
}

function sessionMiddleware(db) {
  const lookup = db.prepare(`
    SELECT s.id AS session_hash, s.expires_at, u.id, u.name, u.username, u.role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.active = 1
  `);
  const remove = db.prepare('DELETE FROM sessions WHERE id = ?');

  return function attachSession(req, res, next) {
    req.auth = null;
    req.user = null;
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return next();

    const sessionHash = hashToken(token);
    const row = lookup.get(sessionHash, nowIso());
    if (!row) {
      remove.run(sessionHash);
      return next();
    }

    req.auth = {
      sessionHash,
      expiresAt: row.expires_at,
      user: {
        id: row.id,
        name: row.name,
        username: row.username,
        role: row.role
      }
    };
    req.user = req.auth.user;
    return next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
  return next();
}

function requireRole(role) {
  return function checkRole(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Please sign in to continue.' });
    if (req.user.role !== role) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    return next();
  };
}

function cleanupExpiredSessions(db) {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso()).changes;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  validatePassword,
  hashToken,
  parseCookies,
  cookieOptions,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  sessionMiddleware,
  requireAuth,
  requireRole,
  cleanupExpiredSessions
};

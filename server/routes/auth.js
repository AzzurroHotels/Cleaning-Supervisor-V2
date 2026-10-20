const express = require('express');
const {
  hashPassword,
  verifyPassword,
  validatePassword,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  requireAuth
} = require('../auth');
const { HttpError, wrap, requireText } = require('../util');
const { nowIso } = require('../db');

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function validateUsername(value) {
  const username = requireText(value, 'Username', { min: 3, max: 32 });
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(
      400,
      'Username must be 3–32 characters and can only use letters, numbers, dots, dashes or underscores.'
    );
  }
  return username;
}

function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000, enabled = true } = {}) {
  const attempts = new Map();

  function cleanup(now) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  return {
    check(key) {
      if (!enabled) return 0;
      const now = Date.now();
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + windowMs });
        return 0;
      }
      entry.count += 1;
      if (attempts.size > 5000) cleanup(now);
      if (entry.count > max) return Math.ceil((entry.resetAt - now) / 1000);
      return 0;
    },
    reset(key) {
      attempts.delete(key);
    }
  };
}

function createAuthRouter({ db, sessionDays, loginLimiter }) {
  const router = express.Router();
  const countUsers = db.prepare('SELECT COUNT(*) AS count FROM users');
  const findUser = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1');
  const createUser = db.prepare(`
    INSERT INTO users (name, username, password_hash, role, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  router.get('/status', (req, res) => {
    res.json({
      needsSetup: countUsers.get().count === 0,
      user: req.user || null
    });
  });

  router.post(
    '/setup',
    wrap((req, res) => {
      if (countUsers.get().count > 0) {
        throw new HttpError(409, 'Setup has already been completed. Please sign in.');
      }

      const supervisorName = requireText(req.body.supervisorName, 'Supervisor name', { min: 1, max: 80 });
      const supervisorUsername = validateUsername(req.body.supervisorUsername);
      const supervisorPassword = validatePassword(req.body.supervisorPassword, 'Supervisor password');
      const managerName = requireText(req.body.managerName, 'Manager name', { min: 1, max: 80 });
      const managerUsername = validateUsername(req.body.managerUsername);
      const managerPassword = validatePassword(req.body.managerPassword, 'Manager password');

      if (supervisorUsername.toLowerCase() === managerUsername.toLowerCase()) {
        throw new HttpError(400, 'Supervisor and manager usernames must be different.');
      }

      const now = nowIso();
      const insertBoth = db.transaction(() => {
        createUser.run(
          supervisorName,
          supervisorUsername,
          hashPassword(supervisorPassword),
          'supervisor',
          now,
          now
        );
        createUser.run(managerName, managerUsername, hashPassword(managerPassword), 'manager', now, now);
      });
      insertBoth();

      res.status(201).json({ ok: true });
    })
  );

  router.post(
    '/login',
    wrap((req, res) => {
      const retryAfter = loginLimiter.check(req.ip || 'unknown');
      if (retryAfter) {
        res.set('Retry-After', String(retryAfter));
        throw new HttpError(429, 'Too many sign-in attempts. Please wait a few minutes and try again.');
      }

      const username = requireText(req.body.username, 'Username', { min: 1, max: 64 });
      if (typeof req.body.password !== 'string' || req.body.password.length === 0) {
        throw new HttpError(400, 'Password is required.');
      }

      const user = findUser.get(username);
      if (!user || !verifyPassword(req.body.password, user.password_hash)) {
        throw new HttpError(401, 'Incorrect username or password.');
      }

      loginLimiter.reset(req.ip || 'unknown');
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso());
      const token = createSession(db, user.id, sessionDays);
      setSessionCookie(res, req, token, sessionDays);

      res.json({
        user: { id: user.id, name: user.name, username: user.username, role: user.role }
      });
    })
  );

  router.post('/logout', (req, res) => {
    if (req.auth) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.auth.sessionHash);
    }
    clearSessionCookie(res, req);
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  router.post(
    '/password',
    requireAuth,
    wrap((req, res) => {
      const currentPassword =
        typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
      const newPassword = validatePassword(req.body.newPassword, 'New password');
      if (!currentPassword) throw new HttpError(400, 'Current password is required.');

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      if (!user || !verifyPassword(currentPassword, user.password_hash)) {
        throw new HttpError(400, 'Current password is incorrect.');
      }
      if (currentPassword === newPassword) {
        throw new HttpError(400, 'New password must be different from the current password.');
      }

      db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
        .run(hashPassword(newPassword), nowIso(), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?')
        .run(req.user.id, req.auth.sessionHash);

      res.status(204).end();
    })
  );

  return router;
}

module.exports = { createAuthRouter, createLoginLimiter };

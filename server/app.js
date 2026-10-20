const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const multer = require('multer');
const { openDatabase } = require('./db');
const { sessionMiddleware, cleanupExpiredSessions } = require('./auth');
const { createAuthRouter, createLoginLimiter } = require('./routes/auth');
const { createInspectionsRouter } = require('./routes/inspections');
const { createStatsRouter } = require('./routes/stats');
const { createAttachmentsRouter } = require('./routes/attachments');
const { HttpError } = require('./util');

function createApp(options = {}) {
  const dbPath =
    options.dbPath || process.env.DB_PATH || path.join(process.cwd(), 'data', 'allen-cleaning.db');
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');
  const uploadDir =
    options.uploadDir || process.env.UPLOAD_DIR || path.join(path.dirname(dbPath), 'uploads');
  const sessionDays = Number(options.sessionDays || process.env.SESSION_DAYS || 7);
  const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
  const maxFileBytes = options.maxFileBytes || 20 * 1024 * 1024;
  const maxFailureBytes = options.maxFailureBytes || 60 * 1024 * 1024;
  const maxFiles = options.maxFiles || 10;

  const db = openDatabase(dbPath);
  const app = express();

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          fontSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          objectSrc: ["'none'"],
          scriptSrc: ["'self'"],
          scriptSrcAttr: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"]
        }
      }
    })
  );
  app.use(compression());
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next();
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    if (originHost !== req.get('host')) {
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    }
    return next();
  });

  app.use(sessionMiddleware(db));

  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: new Date().toISOString() });
  });

  const loginLimiter = createLoginLimiter(
    options.loginRateLimit === false ? { enabled: false } : options.loginRateLimit || {}
  );

  app.use(
    '/api/auth',
    createAuthRouter({ db, sessionDays, loginLimiter })
  );
  app.use(
    '/api/inspections',
    createInspectionsRouter({
      db,
      uploadDir,
      maxFileBytes,
      maxFailureBytes,
      maxFiles
    })
  );
  app.use('/api/stats', createStatsRouter({ db }));
  app.use('/api/attachments', createAttachmentsRouter({ db, uploadDir }));

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.get('/login', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  app.get('/', (req, res) => {
    if (!req.user) return res.redirect('/login');
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(
    express.static(publicDir, {
      etag: true,
      setHeaders(res, filePath) {
        res.set(
          'Cache-Control',
          filePath.endsWith('.html')
            ? 'no-cache'
            : 'public, max-age=0, must-revalidate'
        );
      }
    })
  );

  app.use((req, res) => {
    res.status(404).send('Not found');
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const message =
        error.code === 'LIMIT_FILE_SIZE'
          ? 'Each photo or video must be 20 MB or smaller.'
          : error.code === 'LIMIT_FILE_COUNT'
            ? 'You can upload up to 10 files at a time.'
            : 'The upload could not be processed.';
      return res.status(status).json({ error: message });
    }

    if (error instanceof HttpError || Number.isInteger(error.status)) {
      return res.status(error.status || 400).json({ error: error.message });
    }

    if (error instanceof SyntaxError && 'body' in error) {
      return res.status(400).json({ error: 'The request body is not valid JSON.' });
    }

    console.error(error);
    return res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  const cleanupTimer = setInterval(() => {
    try {
      cleanupExpiredSessions(db);
    } catch (error) {
      console.error('Session cleanup failed:', error.message);
    }
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  return {
    app,
    db,
    config: { dbPath, uploadDir, publicDir, sessionDays },
    close() {
      clearInterval(cleanupTimer);
      db.close();
    }
  };
}

module.exports = { createApp };

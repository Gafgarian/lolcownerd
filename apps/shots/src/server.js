import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

import { ClickerEngine } from './logic/clickerEngine.js';
import { sseRoutes } from './routes/sse.js';
import { adminRoutes } from './routes/admin.js';
import { viewerRoutes } from './routes/viewer.js';
import parserRouter from './routes/parser.js';

// --- app & config ---
const app = express();
const PORT = process.env.PORT || 8090;

const origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// CORS first
app.use(cors({
  origin: (o, cb) => {
    if (!o) return cb(null, true);          // same-origin / curl
    if (origins.length === 0) return cb(null, true);
    if (origins.includes(o)) return cb(null, true);
    if (o === 'null') return cb(null, true); // file:// during dev
    return cb(new Error('Not allowed by CORS'));
  }
}));

// JSON body for /api
app.use(express.json());
// Engine (singleton)
const engine = new ClickerEngine();

// Static
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ADMIN_PASS = process.env.ADMIN_PASS || '';

function adminAuth(req, res, next) {
  if (!ADMIN_PASS) return next(); // no password => open (dev)
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    try {
      const [, pass=''] = Buffer.from(hdr.slice(6), 'base64').toString('utf8').split(':');
      if (pass === ADMIN_PASS) return next();
    } catch {}
  }
  res.set('WWW-Authenticate', 'Basic realm="Pour Decisions Admin", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

// — Protect Admin UI (correct path; note ../public/admin)
const ADMIN_DIR = path.join(__dirname, '../public/admin');
app.use('/admin', adminAuth, express.static(ADMIN_DIR));
app.get('/admin/*', adminAuth, (_req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));

// — Protect Admin API & Admin SSE
app.use('/api/admin', adminAuth);
app.use('/api/sse/admin', adminAuth);

// Static
app.use('/viewer', express.static(path.join(__dirname, '../public/viewer')));
app.use('/assets', express.static(path.join(__dirname, '../public/assets'), {
  maxAge: '30d', immutable: true, etag: true
}));

// Routers (these come AFTER the guards above)
app.use('/api/parser', parserRouter);
app.use('/api/sse',   sseRoutes(engine));   // /api/sse/viewer is public; /api/sse/admin was guarded above
app.use('/api/admin', adminRoutes(engine)); // already guarded above
app.use('/api',       viewerRoutes());

// Health & root
app.get('/healthz', (_req, res) =>
  res.json({ ok: true, port: PORT, time: new Date().toISOString() })
);
app.get('/', (_req, res) =>
  res.send('Pour Decisions: /viewer /admin  |  SSE: /api/sse/viewer /api/sse/admin')
);

// Error handler (so test posts don’t fail silently)
app.use((err, _req, res, _next) => {
  console.error('[API ERROR]', err.stack || err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// Start (after routes)
const server = app.listen(PORT, () => {
  console.log(`Pour Decisions running on http://localhost:${PORT}`);
});

// Helpful diagnostics / SSE timeouts / graceful shutdown
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.keepAliveTimeout = 75_000;
server.headersTimeout   = 80_000;

server.on('connection', (socket) => {
  socket.setKeepAlive(true, 60_000);
});

function shutdown(sig) {
  console.log(`[${sig}] shutting down…`);
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
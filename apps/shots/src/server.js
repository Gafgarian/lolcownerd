import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

import { ClickerEngine } from './logic/clickerEngine.js';
import { sseRoutes } from './routes/sse.js';
import { adminRoutes } from './routes/admin.js';
import { viewerRoutes } from './routes/viewer.js';

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

// Static
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/viewer', express.static(path.join(__dirname, '../public/viewer')));
app.use('/admin',  express.static(path.join(__dirname, '../public/admin')));
// strong caching for assets (avatars, glass, sign, etc.)
app.use('/assets', express.static(
  path.join(__dirname, '../public/assets'),
  { maxAge: '30d', immutable: true, etag: true }
));

// Engine (singleton)
const engine = new ClickerEngine();

// Routes
app.use('/api/sse',   sseRoutes(engine));
app.use('/api/admin', adminRoutes(engine));
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
  console.log(`Pour Decisions running on :${PORT}`);
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
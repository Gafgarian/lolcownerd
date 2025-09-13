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
import { createGwGoalStore } from './db/gwGoalStore.js';

/* ---------------- basics ---------------- */
const app  = express();
const PORT = process.env.PORT || 8090;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, '../data')
);

const origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (o, cb) => {
    if (!o) return cb(null, true);
    if (!origins.length) return cb(null, true);
    if (origins.includes(o) || o === 'null') return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

/* ---------------- singletons ---------------- */
const store  = createGwGoalStore({ dataDir: DATA_DIR });
const engine = new ClickerEngine({ onEventForGoal: store.maybeAdvanceFromEvent });

/* ---------------- auth ---------------- */
const ADMIN_PASS = process.env.ADMIN_PASS || '';
function adminAuth(req, res, next) {
  if (!ADMIN_PASS) return next();
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

/* ---------------- static ---------------- */
const ADMIN_DIR  = path.join(__dirname, '../public/admin');
const VIEWER_DIR = path.join(__dirname, '../public/viewer');
const ASSETS_DIR = path.join(__dirname, '../public/assets');

app.use('/assets', express.static(ASSETS_DIR, { maxAge: '30d', immutable: true, etag: true }));
app.use('/admin', adminAuth, express.static(ADMIN_DIR));
app.get('/admin/*', adminAuth, (_req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));
app.use('/viewer', express.static(VIEWER_DIR));
app.get('/', (_req, res) => res.redirect(302, '/viewer/')); // default route

/* ---------------- build routers FIRST ---------------- */
const parserApi   = parserRouter({ onEvent: store.maybeAdvanceFromEvent });
const sseApi      = sseRoutes(engine, { extraSnapshot: () => store.snapshot(), onStore: store.onChange });
const adminApi    = adminRoutes(engine, store);
const adminMeta   = (() => {
  const r = express.Router();
  r.get('/graffiti', (_req,res)=> res.json({ ok:true, graffiti: store.getGraffiti() }));
  r.post('/graffiti/set', (req,res)=> { store.setGraffiti(req.body?.items || []); res.json({ ok:true }); });
  r.post('/graffiti/clear', (_req,res)=> { store.setGraffiti([]); res.json({ ok:true }); });

  r.get('/goal', (_req,res)=> res.json({ ok:true, goal: store.getGoal() }));
  r.post('/goal/save', (req,res)=> { store.saveGoal(req.body || {}, { keepProgress:true }); res.json({ ok:true }); });
  r.post('/goal/add',  (req,res)=> { store.addToGoal(Number(req.body?.delta || 1) | 0); res.json({ ok:true }); });
  r.post('/goal/delete', (_req,res)=> { store.clearGoal(); res.json({ ok:true }); });
  r.post('/reset-store', (_req,res)=> { store.setGraffiti([]); store.clearGoal(); res.json({ ok:true }); });
  return r;
})();

const viewerApi   = viewerRoutes();

/* safety: make sure none of these are undefined/non-functions */
for (const [name, r] of Object.entries({ parserApi, sseApi, adminApi, adminMeta, viewerApi })) {
  if (typeof r !== 'function') {
    throw new Error(`[server] ${name} is not a middleware/Router (got ${typeof r}). Check its export/import.`);
  }
}

/* ---------------- mount routers ---------------- */
app.use('/api/parser', parserApi);
app.use('/api/sse',    sseApi);

// guard once, then mount both admin routers
app.use('/api/admin', adminAuth, adminApi);
app.use('/api/admin', adminAuth, adminMeta);

app.use('/api', viewerApi);

/* ---------------- health + errors ---------------- */
app.get('/healthz', (_req, res) => res.json({ ok:true, port:PORT, time:new Date().toISOString() }));

app.use((err, _req, res, _next) => {
  console.error('[API ERROR]', err.stack || err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

/* ---------------- start ---------------- */
const server = app.listen(PORT, () => {
  console.log(`Pour Decisions running on http://localhost:${PORT}`);
});
server.keepAliveTimeout = 75_000;
server.headersTimeout   = 80_000;
server.on('connection', s => s.setKeepAlive(true, 60_000));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

function shutdown(sig) {
  console.log(`[${sig}] shutting down…`);
  server.close(() => { console.log('HTTP server closed'); process.exit(0); });
  setTimeout(() => process.exit(1), 5000);
}
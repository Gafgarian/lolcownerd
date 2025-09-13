// routes/viewer.js
import express from 'express';

/**
 * Viewer REST helpers. SSE provides live updates; this route is mostly for
 * health checks and quick diagnostics. Keeping it simple (no engine param),
 * because server.js wires this as: app.use('/api', viewerRoutes()).
 */
export function viewerRoutes() {
  const r = express.Router();

  // Lightweight health check the viewer can use before opening SSE
  r.get('/ping', (_req, res) => res.json({ ok: true, role: 'viewer', time: new Date().toISOString() }));

  // In case you want a one-off pre-hydration without SSE, you can forward the
  // merged state from the SSE hub by mounting a small adapter later. For now,
  // SSE (/api/sse/viewer) is the source of truth.
  return r;
}
import express from 'express';

/**
 * SSE hub for admin + viewer.
 * - Engine drives live updates via engine.addListener(res)
 * - We send initial + store-change composite snapshots (engine + extraSnapshot)
 * - Heartbeats are comments (:hb) so clients don't reset on keepalives
 */
export function sseRoutes(engine, { extraSnapshot = () => ({}), onStore } = {}) {
  const r = express.Router();
  const clients = { admin: new Set(), viewer: new Set() };

  const nowSnapshot = () => ({ ...engine.viewModel(), ...extraSnapshot() });

  function attach(kind, req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    // Let the engine stream its own updates into this response
    try { engine.addListener(res); } catch {}

    // Track for store-change broadcasts
    clients[kind].add(res);

    // Initial composite snapshot
    res.write(`data: ${JSON.stringify(nowSnapshot())}\n\n`);

    // Keep-alive (comment line → ignored by EventSource.onmessage)
    const ping = setInterval(() => {
      try { res.write(':hb\n\n'); } catch {}
    }, 20000);

    req.on('close', () => {
      clearInterval(ping);
      try { engine.removeListener(res); } catch {}
      clients[kind].delete(res);
    });
  }

  // When the persistent store changes (goal/graffiti), broadcast a composite snapshot
  if (typeof onStore === 'function') {
    onStore(() => {
      const payload = JSON.stringify(nowSnapshot());
      for (const set of Object.values(clients)) {
        for (const res of set) {
          try { res.write(`data: ${payload}\n\n`); } catch {}
        }
      }
    });
  }

  r.get('/admin',  (req, res) => attach('admin',  req, res));
  r.get('/viewer', (req, res) => attach('viewer', req, res));
  return r;
}
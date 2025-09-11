// src/routes/parser.js
import express from 'express';

// .env (server-side)
const PARSER_ORIGIN  = (process.env.PARSER_ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
const PARSER_API_KEY = process.env.PARSER_API_KEY || '';

const router = express.Router();

// --- helpers ----------------------------------------------------
function normalizeYoutube(input = '') {
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return `https://www.youtube.com/watch?v=${s}`;
  try {
    const u = new URL(s);
    const id = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
    return id ? `https://www.youtube.com/watch?v=${id}` : s;
  } catch {
    return s;
  }
}

async function parseJsonOrText(res) {
  const txt = await res.text();
  try { return { body: JSON.parse(txt), isJson: true }; }
  catch { return { body: txt, isJson: false }; }
}

async function pFetch(path, init = {}, { timeoutMs = 8000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${PARSER_ORIGIN}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PARSER_API_KEY,
        ...(init.headers || {})
      },
      signal: ctrl.signal
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function upErr(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

// --- routes -----------------------------------------------------

/** GET /api/parser/active → proxy to parser /parser/active */
router.get('/active', async (_req, res) => {
  try {
    const r = await pFetch('/parser/active');
    const { body, isJson } = await parseJsonOrText(r);
    if (!r.ok && r.status >= 500) return upErr(res, 502, 'parser_unreachable');
    return isJson
      ? res.status(r.status).json(body)
      : res.status(r.status).type('text/plain').send(body);
  } catch (e) {
    return upErr(res, 502, 'parser_unreachable');
  }
});

/**
 * POST /api/parser/ensure { youtube | url, force? }
 * - If force === true: stop current session first, then start the new one.
 * - Accepts bare video IDs and normalizes to a full watch URL.
 */
router.post('/ensure', async (req, res) => {
  try {
    const input  = req.body.youtube || req.body.url || '';
    if (!input) return upErr(res, 400, 'missing_youtube');

    const url    = normalizeYoutube(input);
    const force  = !!req.body.force;

    if (force) {
      // best-effort stop; ignore failures
      try { await pFetch('/parser/stop', { method: 'POST' }); } catch {}
      // tiny grace period so the parser can tear down
      await new Promise(r => setTimeout(r, 250));
    }

    const r = await pFetch('/parser/ensure', {
      method: 'POST',
      body: JSON.stringify({ url, force })
    });

    const { body, isJson } = await parseJsonOrText(r);
    if (!r.ok && r.status >= 500) return upErr(res, 502, 'parser_unreachable');
    return isJson
      ? res.status(r.status).json(body)
      : res.status(r.status).type('text/plain').send(body);
  } catch {
    return upErr(res, 502, 'parser_unreachable');
  }
});

// POST /api/parser/switch { youtube | url }
// Hard switch: stop current, then ensure new (normalized) URL.
router.post('/switch', async (req, res) => {
  const input = req.body.youtube || req.body.url || '';
  if (!input) return upErr(res, 400, 'missing_youtube');

  const url = normalizeYoutube(input);

  // try to stop; ignore failures
  try { await pFetch('/parser/stop', { method: 'POST' }); } catch {}
  await new Promise(r => setTimeout(r, 250)); // small grace

  try {
    const r = await pFetch('/parser/ensure', {
      method: 'POST',
      body: JSON.stringify({ url, force: true })
    });
    const { body, isJson } = await parseJsonOrText(r);
    if (!r.ok && r.status >= 500) return upErr(res, 502, 'parser_unreachable');
    return isJson
      ? res.status(r.status).json(body)
      : res.status(r.status).type('text/plain').send(body);
  } catch {
    return upErr(res, 502, 'parser_unreachable');
  }
});

/** POST /api/parser/stop → parser /parser/stop */
router.post('/stop', async (_req, res) => {
  try {
    const r = await pFetch('/parser/stop', { method: 'POST' });
    const { body, isJson } = await parseJsonOrText(r);
    if (!r.ok && r.status >= 500) return upErr(res, 502, 'parser_unreachable');
    return isJson
      ? res.status(r.status).json(body)
      : res.status(r.status).type('text/plain').send(body);
  } catch {
    return upErr(res, 502, 'parser_unreachable');
  }
});

export default router;
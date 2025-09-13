import express from 'express';

function normalizeVideoId(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    // ?v=ID or last non-empty pathname segment
    return (
      u.searchParams.get('v') ||
      u.pathname.split('/').filter(Boolean).pop() ||
      ''
    );
  } catch {
    return '';
  }
}

export default function parserRouter(opts = {}) {
  const r = express.Router();
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

  // Single shared state for the “parser”
  let state = {
    status: 'stopped',   // 'running' | 'stopped'
    videoId: null,
    since:  null,
  };

  // GET /api/parser/active  → { ok, status, videoId }
  r.get('/active', (_req, res) => {
    res.json({
      ok: true,
      status: state.status,
      videoId: state.videoId,
      since: state.since,
    });
  });

  // POST /api/parser/ensure { youtube, force? } → start or reuse the parser
  // Mirrors the expectations in Admin: it will poll /active until status === 'running'.
  r.post('/ensure', (req, res) => {
    const youtube = req.body?.youtube;
    const force   = !!req.body?.force;
    const vid     = normalizeVideoId(youtube);

    if (!vid) {
      return res.status(400).json({ ok: false, error: 'bad_youtube' });
    }

    const sameVideo = state.status === 'running' && state.videoId === vid;

    if (sameVideo && !force) {
      return res.json({
        ok: true,
        reused: true,
        status: state.status,
        videoId: state.videoId,
        since: state.since,
      });
    }

    // (Re)start
    state.status  = 'running';
    state.videoId = vid;
    state.since   = new Date().toISOString();

    return res.json({
      ok: true,
      started: !sameVideo || force,
      status: state.status,
      videoId: state.videoId,
    });
  });

  // Optional: stop endpoint (handy in dev)
  r.post('/stop', (_req, res) => {
    state = { status: 'stopped', videoId: null, since: null };
    res.json({ ok: true, status: 'stopped' });
  });

  // Optional: dev hook to emit a synthetic event to any listener (goal store, etc.)
  // POST /api/parser/emit { type:'superchat'|'gift', ... }
  r.post('/emit', (req, res) => {
    try { onEvent?.(req.body || {}); } catch {}
    res.json({ ok: true });
  });

  return r;
}
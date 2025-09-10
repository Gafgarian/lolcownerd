import express from 'express';
import { extractVideoId } from '../util/youtube.js';

// === Parser API config (via .env) ===
const PARSER_ORIGIN = process.env.PARSER_ORIGIN || 'http://localhost:8080';
const PARSER_API_KEY = process.env.PARSER_API_KEY || '';

// tiny fetch wrapper to hit the parser API
async function parserFetch(path, opts = {}) {
  const r = await fetch(`${PARSER_ORIGIN}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-api-key': PARSER_API_KEY,
      ...(opts.headers || {})
    }
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function videoIdFromInput(input) {
  try {
    const u = new URL(input);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch {
    return String(input).trim();
  }
}

// Poll the parser until it reports the wanted videoId as active (or timeout)
async function waitUntilParserActive(videoId, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const a = await parserFetch('/parser/active');
      if (a?.status === 'running' && a?.videoId === videoId) return true;
    } catch { /* parser not up yet */ }
    await sleep(1200);
  }
  return false;
}

// Bind engine to Supabase row by videoId, retrying briefly until the parser
// has inserted/updated the row in Supabase.
async function bindByVideoIdWithRetry(engine, videoId, tries = 12, delayMs = 1250) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await engine.bindByVideoId(videoId);
    } catch (e) {
      lastErr = e;
      // only retry on “not found” style failures
      const msg = String(e?.message || e);
      if (!/No stream found/i.test(msg)) throw e;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export function adminRoutes(engine) {
  const r = express.Router();

  // ----- Bind (with parser coordination) -----
  // body: { youtube: "<url or id>", forceSwitch?: boolean }
  r.post('/bind', async (req, res, next) => {
    try {
      const { youtube: ytFromBody, url, forceSwitch } = req.body || {};
      const youtube = ytFromBody || url;       // accept either key
      if (!youtube) throw new Error('Missing YouTube URL or ID');

      const wantVid = videoIdFromInput(youtube);

      // 1) Ask parser to ensure this stream is the active one
      const ensure = await parserFetch('/parser/ensure', {
        method: 'POST',
        body: JSON.stringify({ url: youtube, forceSwitch: !!forceSwitch })
      });

      // 2) If parser is running a *different* stream and the client didn’t
      //    authorize switching yet, tell the client to prompt the user.
      if (ensure?.status === 'mismatch' && !forceSwitch) {
        return res.json({
          ok: false,
          code: 'parser_mismatch',
          message: 'Parser is running a different stream.',
          currentVideoId: ensure.currentVideoId,
          meta: ensure.meta || {}
        });
      }

      // 3) If we started or switched, wait until it’s actually active
      if (ensure?.status === 'started' || ensure?.status === 'switched') {
        const ok = await waitUntilParserActive(wantVid, 30_000);
        if (!ok) return res.status(504).json({ ok: false, error: 'parser_not_ready' });
      }

      // 4) Bind to Supabase by video id (retry briefly until the row exists)
      const bound = await bindByVideoIdWithRetry(engine, wantVid);
      // start engine if not already running
      if (!engine.running) engine.start();

      return res.json({ ok: true, bound, videoId: wantVid });
    } catch (e) {
      next(e);
    }
  });

  // ----- Disconnect (snapshot + reset) -----
  r.post('/disconnect', (req, res, next) => {
    try {
      engine.stop();
      const snapshot = engine.viewModel();
      engine.resetAll();
      res.json({ ok: true, snapshot });
    } catch (e) { next(e); }
  });

  // ----- Test helpers -----
  r.post('/test/shot', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const n = Math.max(1, Math.min(5000, Number(req.body?.n) || 1));
      engine.testAddShots(n);
      res.json({ ok: true, queued: n });
    } catch (e) { next(e); }
  });

  r.post('/test/gift', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const seconds = Math.max(1, Math.min(3600, Number(req.body?.n) || 5));
      engine.testGiftSeconds(seconds);
      res.json({ ok: true, giftSeconds: seconds });
    } catch (e) { next(e); }
  });

  // (optional) small pass-through to expose parser /active to the UI
  r.get('/parser/active', async (_req, res) => {
    try { res.json(await parserFetch('/parser/active')); }
    catch { res.status(502).json({ ok: false, error: 'parser_unavailable' }); }
  });

  return r;
}
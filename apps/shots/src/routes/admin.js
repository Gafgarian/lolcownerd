// src/routes/admin.js
import express from 'express';

// === Parser API config (.env) ===
const PARSER_ORIGIN  = (process.env.PARSER_ORIGIN || 'http://localhost:8080').replace(/\/+$/,'');
const PARSER_API_KEY = process.env.PARSER_API_KEY || '';

// Small helpers
async function pFetch(path, init = {}) {
  return fetch(`${PARSER_ORIGIN}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-api-key': PARSER_API_KEY,
      ...(init.headers || {})
    }
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function videoIdFromInput(input){
  try {
    const u = new URL(input);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return String(input).trim();
  }
}

async function waitUntilParserActive(videoId, timeoutMs = 30_000){
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await pFetch('/parser/active');
      const j = await r.json();
      if (j?.status === 'running' && j?.videoId === videoId) return true;
    } catch {}
    await sleep(1200);
  }
  return false;
}

async function bindByVideoIdWithRetry(engine, videoId, tries = 12, delayMs = 1250){
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await engine.bindByVideoId(videoId);
    } catch (e) {
      lastErr = e;
      if (!/No stream found/i.test(String(e?.message || e))) throw e;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

export function adminRoutes(engine){
  const router = express.Router();

  // ----- Bind (coordinates with parser) -----
  router.post('/bind', async (req, res, next) => {
    try {
      const { youtube: ytFromBody, url, forceSwitch } = req.body || {};
      const youtube = ytFromBody || url;
      if (!youtube) throw new Error('Missing YouTube URL or ID');

      const wantVid = videoIdFromInput(youtube);

      const ensureRes = await pFetch('/parser/ensure', {
        method: 'POST',
        body: JSON.stringify({ url: youtube, force: !!forceSwitch })
      });
      const ensure = await ensureRes.json();

      if (ensure?.status === 'mismatch' && !forceSwitch) {
        return res.json({
          ok: false,
          code: 'parser_mismatch',
          currentVideoId: ensure.currentVideoId,
          meta: ensure.meta || {}
        });
      }

      if (ensure?.status === 'started' || ensure?.status === 'switched') {
        const ok = await waitUntilParserActive(wantVid, 30_000);
        if (!ok) return res.status(504).json({ ok:false, error:'parser_not_ready' });
      }

      const bound = await bindByVideoIdWithRetry(engine, wantVid);
      if (!engine.running) engine.start();

      res.json({ ok:true, bound, videoId: wantVid });
    } catch (e) { next(e); }
  });

  // ----- Admin alias for a hard parser switch (stop + ensure) -----
  router.post('/parser/switch', async (req, res, next) => {
    try {
      const { youtube, url } = req.body || {};
      const target = youtube || url;
      if (!target) return res.status(400).json({ ok:false, error:'missing_youtube' });

      const h = { 'content-type':'application/json', 'x-api-key': PARSER_API_KEY };
      await fetch(`${PARSER_ORIGIN}/parser/stop`, { method:'POST', headers:h }).catch(()=>{});
      const r  = await fetch(`${PARSER_ORIGIN}/parser/ensure`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ url: target, force: true })
      });
      const j = await r.json().catch(()=>({}));
      res.status(r.status).json(j);
    } catch (e) { next(e); }
  });

  // ----- Reset everything (stop parser, stop engine, clear state) -----
  router.post('/reset', async (_req, res) => {
    try { await fetch(`${process.env.SELF_ORIGIN || ''}/api/parser/stop`, { method:'POST' }); } catch {}
    try { engine.stop(); } catch {}
    try { engine.resetAll(); } catch {}
    engine.bound = null;
    engine.logs = [];
    try { engine.broadcast(); } catch {}
    res.json({ ok:true });
  });

  // ----- Disconnect (snapshot + reset) -----
  router.post('/disconnect', (req, res, next) => {
    try {
      engine.stop();
      const snapshot = engine.viewModel();
      engine.resetAll();
      res.json({ ok:true, snapshot });
    } catch (e) { next(e); }
  });

  // ----- Tests -----
  router.post('/test/shot', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const n = Math.max(1, Math.min(5000, Number(req.body?.n) || 1));
      engine.start();
      engine.testAddShots(Number(req.body?.n || 1), String(req.body?.author || 'Admin'));
      res.json({ ok:true, queued:n });
    } catch (e) { next(e); }
  });

  router.post('/test/gift', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const seconds = Math.max(1, Math.min(3600, Number(req.body?.n) || 5));
      engine.start();
      engine.testGiftSeconds(Number(req.body?.n || 5), String(req.body?.author || 'Admin'));
      res.json({ ok:true, giftSeconds:seconds });
    } catch (e) { next(e); }
  });

  // optional: expose parser /active to admin UI through this router
  router.get('/parser/active', async (_req, res) => {
    try { const r = await pFetch('/parser/active'); const j = await r.json(); res.json(j); }
    catch { res.status(502).json({ ok:false, error:'parser_unavailable' }); }
  });

  return router;
}
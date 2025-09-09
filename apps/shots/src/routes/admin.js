import express from 'express';
import { extractVideoId } from '../util/youtube.js';

export function adminRoutes(engine) {
  const r = express.Router();

  // Bind & start
  r.post('/bind', async (req, res, next) => {
    try {
      const { youtube } = req.body || {};
      const video_id = extractVideoId(youtube || '');
      if (!video_id) throw new Error('Invalid YouTube URL or ID');

      const bound = await engine.bindByVideoId(video_id);
      engine.start();
      res.json({ ok: true, bound });
    } catch (e) { next(e); }
  });

  // Disconnect, snapshot + reset
  r.post('/disconnect', (req, res, next) => {
    try {
      engine.stop();
      const snapshot = engine.viewModel();
      engine.resetAll();
      res.json({ ok: true, snapshot });
    } catch (e) { next(e); }
  });

  // Test: queue N shots
  r.post('/test/shot', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const n = Math.max(1, Math.min(5000, Number(req.body?.n) || 1)); // higher upper bound for stress tests
      engine.testAddShots(n);  // strictly N queued; viewer drains at ~9/s
      res.json({ ok: true, queued: n });
    } catch (e) { next(e); }
  });

  // Test: schedule gift auto-clicker (1..50)
  // Test: schedule gift auto-clicker SECONDS (uncapped test path)
  r.post('/test/gift', (req, res, next) => {
    try {
      if (!engine.running) engine.start();
      const seconds = Math.max(1, Math.min(3600, Number(req.body?.n) || 5)); // up to 1h for tests
      engine.testGiftSeconds(seconds);
      res.json({ ok: true, giftSeconds: seconds });
    } catch (e) { next(e); }
  });

  return r;
}
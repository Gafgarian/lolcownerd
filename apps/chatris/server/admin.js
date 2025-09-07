// server/admin.js
import express from 'express';
import { extractYouTubeVideoId } from './youtube.js';
import { resolveStreamFromVideoId } from './resolveStreamId.js';
import { supa } from './supabase.js';

export const admin = (game, emitLog = () => {}) => {
  const r = express.Router();

  // Start / Clear / End
  r.post('/start', (req, res) => {
    game.start();                       // spawns immediately
    emitLog('game_start');
    return res.json({ ok: true });
  });

  r.post('/clear', (req, res) => {
    game.clearBoard(true);              // keep score
    emitLog('board_cleared');
    return res.json({ ok: true });
  });

  r.post('/end', (req, res) => {
    game.end();                         // updates high score internally
    emitLog('game_end', { highScore: game.highScore });
    return res.json({ ok: true, highScore: game.highScore });
  });

  r.post('/setHighScore', (req, res) => {
    const { value } = req.body || {};
    game.highScore = Number(value) || 0;
    return res.json({ ok: true, highScore: game.highScore });
  });

  r.get('/save', (req, res) => {
    const payload = {
      board: game.board,
      score: game.score,
      highScore: game.highScore,
      nextQueue: game.nextQueue,
      current: game.current,
      sinceId: game.sinceId,
      emaViewers: game.emaViewers
    };
    return res.json(payload);
  });

  // >>> This is where you put "#3" (seed cursors to ignore history) <<<
  r.post('/stream', async (req, res) => {
    try {
      const { url, stream_id } = req.body || {};

      // Resolve stream id (from URL or raw UUID)
      if (url) {
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });

        const resolved = await resolveStreamFromVideoId(videoId);
        if (!resolved) return res.status(404).json({ ok: false, error: 'Unknown videoId', videoId });

        game.streamId = resolved.stream_id;
        game.videoId = videoId;
        game.streamTitle = resolved.title || null;
        game.streamMaxViewers = resolved.max_viewers || 0;
      } else if (stream_id) {
        game.streamId = stream_id;
        game.videoId = null;
        game.streamTitle = null;
        game.streamMaxViewers = 0;
      } else {
        return res.status(400).json({ ok: false, error: 'Provide `url` or `stream_id`.' });
      }

      // --- #3: Seed cursors so we only process *new* rows ---
      const [{ data: lastEv }, { data: lastSnap }] = await Promise.all([
        supa.from('stream_events')
            .select('id')
            .eq('stream_id', game.streamId)
            .order('id', { ascending: false })
            .limit(1)
            .maybeSingle(),
        supa.from('viewer_snapshots')
            .select('id, viewers')
            .eq('stream_id', game.streamId)
            .order('id', { ascending: false })
            .limit(1)
            .maybeSingle()
      ]);

      game.sinceId        = lastEv?.id ?? 0;
      game.sinceViewerId  = lastSnap?.id ?? 0;
      game.emaViewers     = lastSnap?.viewers ?? 0;

      emitLog('stream_set', { stream_id: game.streamId, video_id: game.videoId });

      // Optional: auto-start so a piece appears/falls immediately
      game.start();

      return res.json({ ok: true, stream_id: game.streamId, video_id: game.videoId || null });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  });

  r.post('/load', (req, res) => {
    const s = req.body || {};
    if (Array.isArray(s.board)) game.board = s.board;
    if (typeof s.score === 'number') game.score = s.score;
    if (typeof s.highScore === 'number') game.highScore = s.highScore;
    if (Array.isArray(s.nextQueue)) game.nextQueue = s.nextQueue;
    if (s.current && typeof s.current === 'object') game.current = s.current;
    if (typeof s.sinceId === 'number') game.sinceId = s.sinceId;
    if (typeof s.emaViewers === 'number') game.emaViewers = s.emaViewers;
    return res.json({ ok: true });
  });

  return r;
};
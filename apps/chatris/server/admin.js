import express from 'express';
import { extractYouTubeVideoId } from './youtube.js';
import { resolveStreamFromVideoId } from './resolveStreamId.js';
import { parseCommand, CHAT_COOLDOWN_MS, donationEffectFrom, effectFromSuperchat } from './rules.js';

export const admin = (game, emitLog = () => {}, broadcast = () => {}, utils = {}) => {
  const r = express.Router();

  // utils provided from server.js
  const {
    clearQueues = () => {},
    parser = null,           // parser connector instance
    pickParserEnv = null     // returns { baseUrl, token }
  } = utils;

  let authorCooldown = new Map();  // long cooldown window (CHAT_COOLDOWN_MS)
  const shortGuard   = new Map();  // 250ms de-dupe for accidental repeats

  function okToCountVote(who, ms = CHAT_COOLDOWN_MS) {
    if (!who) return false;

    // very short dedupe to prevent double fires from same message path
    const now = Date.now();
    const lastShort = shortGuard.get(who) || 0;
    if (now - lastShort < 250) return false;
    shortGuard.set(who, now);

    // standard author cooldown
    const last = authorCooldown.get(who) || 0;
    if (now - last < ms) return false;
    authorCooldown.set(who, now);

    return true;
  }

  function addVote(cmd) {
    if (typeof game?.queueVote === 'function') {
      game.queueVote(cmd);      
    } else {
      game._windowCounts = game._windowCounts || { left:0, right:0, rotate:0 };
    }
  }

  // --- Basic controls --------------------------------------------------------
  r.post('/start', (_req, res) => { game.start(); emitLog('game_start'); res.json({ ok:true }); });
  r.post('/clear', (_req, res) => { game.clearBoard(true); emitLog('board_cleared'); res.json({ ok:true }); });
  r.post('/end',   (_req, res) => { game.end(); emitLog('game_end', { highScore: game.highScore }); res.json({ ok:true, highScore: game.highScore }); });
  r.post('/setHighScore', (req, res) => { game.highScore = Number(req.body?.value) || 0; res.json({ ok:true, highScore: game.highScore }); });

  r.get('/save', (_req, res) => {
    res.json({
      board: game.board, score: game.score, highScore: game.highScore,
      nextQueue: game.nextQueue, current: game.current,
      sinceId: game.sinceId, emaViewers: game.emaViewers
    });
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
    res.json({ ok:true });
  });

  // --- Stream binding + parser wiring ---------------------------------------
  r.post('/stream', async (req, res) => {
    try {
      emitLog('admin_stream_called', { gotParser: !!parser, gotPicker: !!pickParserEnv, bodyKeys: Object.keys(req.body || {}) });
      if (!parser || !pickParserEnv) throw new Error('parser integration not wired');

      const { url, stream_id } = req.body || {};

      // Resolve stream metadata (keeps your current behavior)
      if (url) {
        const videoId = extractYouTubeVideoId(url);
        if (!videoId) return res.status(400).json({ ok:false, error:'Invalid YouTube URL' });
        const resolved = await resolveStreamFromVideoId(videoId);
        if (!resolved) return res.status(404).json({ ok:false, error:'Unknown videoId', videoId });
        game.streamId         = resolved.stream_id;
        game.videoId          = videoId;
        game.streamTitle      = resolved.title || null;
        game.streamMaxViewers = resolved.max_viewers || 0;
      } else if (stream_id) {
        game.streamId = stream_id;
        game.videoId  = null;
        game.streamTitle = null;
        game.streamMaxViewers = 0;
      } else {
        return res.status(400).json({ ok:false, error:'Provide `url` or `stream_id`.' });
      }

      // Choose parser origin (local vs prod based on env vars)
      const env = pickParserEnv();
      emitLog('parser_env_selected', { baseUrl: env.baseUrl, hasToken: !!env.token });

      // Stop any duplicate sessions already running for this video id (best effort)
      if (game.videoId) {
        try {
          const killed = await parser.killByVideoId(game.videoId);
          emitLog('parser_dupes_stopped', { videoId: game.videoId, killed });
        } catch (e) {
          emitLog('parser_dupes_stop_error', { error: String(e) });
        }
      }

      // Fresh parser run
      await parser.stop();

      // Configure + start the parser
      parser.configure(env, {
        // Persist selector so /start doesn’t need args
        streamUrl: url || undefined,
        videoId  : game.videoId || undefined,

        // Fires after SSE is connected
        onOpen: ({ sessionId, events }) => {
          emitLog('parser_onopen', { sessionId, events });

          // 3-second countdown; freeze gravity while counting down
          clearQueues();
          broadcast('countdown', { seconds: 3 });
          game.freezeUntil = Date.now() + 3000;

          game.resetAll();
          game.start();            // will not fall while freezeUntil is in the future
          game.useParser = true;   // just a flag for your server.js if you need it
        },

        onEvent: (e) => {
          try {
            const type = String(e.type || e.kind || e.event || '').toLowerCase();

            if (type === 'chat') {
              const msg = String(e.message || '');
              const cmd = parseCommand(msg);
              if (!cmd) return true;                // consumed (ignored)
              const who = e.author || e.channel || 'anon';
              if (!okToCountVote(who)) return true; // consumed (ignored due to cooldown)
              addVote(cmd);
              emitLog('chat_cmd', { author: who, cmd });
              return true;
            }

            if (type === 'superchat') {
              // Always log receipt
              emitLog('superchat_seen', {
                author: e.author,
                message: e.message,
                tier: e.tier || null,
                color: e.color || e.colorVars?.primary || null,
                amount: e.amountFloat ?? e.amount ?? null
              });

              const effect = effectFromSuperchat({
                tier: e.tier,
                color: e.color,
                colorVars: e.colorVars,
                amount: e.amount,
                amount_float: e.amountFloat
              });
              if (!effect) return;

              // Apply with score policy
              const scoreBefore = game.score;
              const rowsBefore  = game.board.reduce((n, row) => n + (row.some(Boolean) ? 1 : 0), 0);

              const added = game.applyEffect(effect);

              // Revert score if this tier doesn't grant points
              if (effect.scoreCredit === false) {
                game.score = scoreBefore;
              }
              const scoreDelta = game.score - scoreBefore;
              const rowsAfter  = game.board.reduce((n, row) => n + (row.some(Boolean) ? 1 : 0), 0);

              broadcast('toast', {
                kind: 'superchat',
                author: e.author,
                message: e.message,
                effect,
                tier: e.tier || null
              });

              emitLog('donation_effect', {
                author: e.author,
                effect,
                scoreDelta,
                scoreCredited: effect.scoreCredit !== false,
                rowsBefore,
                rowsAfter,
                added
              });
              return;
            }

            if (type === 'gift' || type === 'gifted' || type === 'gifted_members') {
              const n = Number(e.count ?? e.gift_count ?? 0);
              if (!n) return;
              game.giftsRecent += n;
              broadcast('toast', { kind: 'gift', author: e.author, count: n });
              emitLog('gift', { author: e.author, count: n });  // ensure gifts show in the admin log
              return;
            }
            
            return true;
          } catch (err) {
            emitLog('parser_event_error', { error: String(err) });
            return false;  
          }
        },

        onError: (err) => {
          emitLog('parser_error', { error: String(err?.message || err) });
          broadcast('modal', { reason: 'parser_error' });
        }
      });

      await parser.start(url || (game.videoId ? `https://www.youtube.com/watch?v=${game.videoId}` : undefined));
      emitLog('stream_set', { stream_id: game.streamId, video_id: game.videoId, sessionId: parser.sessionId });

      res.json({ ok:true, stream_id: game.streamId, video_id: game.videoId, sessionId: parser.sessionId });
    } catch (e) {
      emitLog('admin_stream_error', { error: String(e), stackTop: String(e.stack || '').split('\n')[0] });
      res.status(500).json({ ok:false, error: String(e) });
    }
  });

  // Optional “hard restart” used by the overlay modal
  r.post('/restart', (_req, res) => {
    clearQueues?.();
    game.resetAll();
    broadcast('countdown', { seconds: 3 });
    setTimeout(() => { game.start(); }, 3000);
    emitLog('game_restart');
    res.json({ ok:true });
  });

  return r;
};
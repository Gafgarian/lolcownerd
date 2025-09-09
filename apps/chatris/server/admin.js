import express from 'express';
import { extractYouTubeVideoId } from './youtube.js';
import { resolveStreamFromVideoId } from './resolveStreamId.js';
import { parseCommand, CHAT_COOLDOWN_MS, donationEffectFromTier, effectFromSuperchat } from './rules.js';

// written-number dictionary (extend as you like)
const WORDNUM = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
  seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40,
  fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
  couple:2, few:3, dozen:12
};

// "twenty one", "forty-five" → 21/45; "one eighty" → 180
function wordsToInt(text) {
  const tokens = text.toLowerCase().replace(/-/g, ' ').split(/\s+/);
  let total = 0, acc = 0, seen = false;
  for (const t of tokens) {
    if (t === 'and') continue;
    const n = WORDNUM[t];
    if (n == null) continue;
    seen = true;
    // simple tens+units (we're not handling thousands here)
    if (n >= 20 && n % 10 === 0) acc += n;
    else acc += n;
  }
  if (!seen) return null;
  total += acc;
  return total || null;
}

// Find a count in text (numbers, xN, or words). Default 1.
function extractCount(text, fallback = 1) {
  // explicit xN: "x5", "x 10"
  const x = text.match(/\bx\s*([0-9]{1,3})\b/i);
  if (x) return Math.min(99, parseInt(x[1], 10));

  // plain number
  const d = text.match(/\b([0-9]{1,3})\b/);
  if (d) return Math.min(99, parseInt(d[1], 10));

  // words
  const w = wordsToInt(text);
  if (w != null) return Math.min(99, w);

  return fallback;
}

// Degrees: “180°”, “180 deg/degrees”, or written “one eighty”
function extractDegrees(text) {
  const withUnit = text.match(/\b([0-9]{1,3})\s*(?:°|deg|degree|degrees)\b/i);
  if (withUnit) return parseInt(withUnit[1], 10);

  const plain = text.match(/\b([0-9]{2,3})\b/);
  if (plain) return parseInt(plain[1], 10);

  const words = wordsToInt(text); // “one eighty”
  if (words != null) return words;

  return null;
}

// Normalize degrees to # of 90° rotations (45→1, 90→1, 180→2, 270→3)
function rotationsFromDegrees(deg) {
  if (deg == null) return 1;
  const r = Math.max(0, Math.round(Number(deg) / 90));
  return Math.min(3, r || 1);
}

// Parse a light-blue movement sentence
// returns { kind: 'left'|'right'|'rotate', steps, degrees? }
function parseLightBlueMove(text) {
  const t = String(text || '').toLowerCase();

  // Prefer rotate if it’s explicitly mentioned
  if (/\b(rotate|spin|turn)\b/.test(t)) {
    const deg = extractDegrees(t);
    return { kind: 'rotate', steps: rotationsFromDegrees(deg), degrees: deg ?? 90 };
  }

  if (/\bleft\b/.test(t))  return { kind: 'left',  steps: extractCount(t, 1) };
  if (/\bright\b/.test(t)) return { kind: 'right', steps: extractCount(t, 1) };

  // Fallback: treat lone numbers with “spin” intent as rotate
  const deg = extractDegrees(t);
  if (deg != null) return { kind: 'rotate', steps: rotationsFromDegrees(deg), degrees: deg };

  return { kind: null, steps: 0 };
}

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

            // 100% ignore normal chat now
            if (type === 'chat') return;

            // ----- Superchats drive gameplay -----
            if (type === 'superchat') {
              const tier = (String(e.tier || '').toLowerCase())
                       || tierFromPrimaryColor(e?.colorVars?.primary || e?.color);

              // BLUE = hard drop now
              if (tier === 'blue') {
                const fell = game.hardDrop();
                emitLog('hard_drop', { author: e.author, tier, fell });
                return;
              }

              // LIGHT BLUE = movement / rotation (from message text)
              if (tier === 'lblue') {
                const spec = parseLightBlueMove(String(e.message || ''));
                const MAX_STEPS = 20;       // sane caps
                const MAX_ROTS  = 3;

                if (spec.kind === 'left' || spec.kind === 'right') {
                  const want = Math.min(MAX_STEPS, Math.max(1, spec.steps|0));
                  let applied = 0;

                  for (let i = 0; i < want; i++) {
                    const before = game.current ? game.current.x : null;
                    if (spec.kind === 'left')  game.moveLeft();
                    else                       game.moveRight();
                    // stop if we didn’t actually move (blocked)
                    if (!game.current || game.current.x === before) break;
                    applied++;
                  }

                  emitLog('move_cmd', {
                    author: e.author, tier, dir: spec.kind,
                    requested: want, applied
                  });
                  return;
                }

                if (spec.kind === 'rotate') {
                  const want = Math.min(MAX_ROTS, Math.max(1, spec.steps|0));
                  let applied = 0;
                  for (let i = 0; i < want; i++) {
                    const before = game.current ? game.current.r : null;
                    game.rotate();
                    if (!game.current || game.current.r === before) break;
                    applied++;
                  }

                  emitLog('rotate_cmd', {
                    author: e.author, tier,
                    requestedDegrees: spec.degrees ?? 90,
                    requestedTurns: want, applied
                  });
                  return;
                }

                // No recognizable instruction
                emitLog('lblue_ignored', { author: e.author, message: e.message });
                return;
              }
            }

            // Gifts still slow the game slightly & are logged
            if (type === 'gift' || type === 'gifted' || type === 'gifted_members') {
              const n = Number(e.count ?? e.gift_count ?? 0);
              if (!n) return;
              game.giftsRecent += n;
              broadcast('toast', { kind: 'gift', author: e.author, count: n });
              emitLog('gift', { author: e.author, count: n });
              return;
            }

            // Everything else (meta/title/etc.) ignored here
          } catch (err) {
            emitLog('parser_event_error', { error: String(err) });
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
import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { supa } from './supabase.js';
import { GameState } from './state.js';
import { makeParserConnector } from './parser.js';
import { parseCommand, CMD_WINDOW_MS, CHAT_COOLDOWN_MS, SPEED_DAMP, donationEffectFromTier, gravityFrom, effectFromSuperchat } from './rules.js';
import { admin } from './admin.js';
import { extractYouTubeVideoId } from './youtube.js';
import { resolveStreamFromVideoId } from './resolveStreamId.js';

console.log(process.env.SUPABASE_URL);

import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(bodyParser.json());

const game = new GameState();
const authorCooldown = new Map();
let windowCounts = { left:0, right:0, rotate:0 };
let windowStart = Date.now();
let lastPhysicsAt = Date.now();
const sseClients = new Set();

function logLine(msg, data = {}) {
  const payload = { t: Date.now(), msg, ...data };
  broadcast('log', payload);
  // also console.log for your own sanity
  console.log('[LOG]', payload);
}

let countdownUntil = 0;
function startCountdown(ms = 3000) {
  countdownUntil = Date.now() + ms;
  broadcast('countdown', { seconds: Math.ceil(ms/1000) });
}

// choose parser origin
function pickParserEnv() {
  // Prefer a single PARSER_URL everywhere
  const baseUrl =
    (process.env.PARSER_URL && process.env.PARSER_URL.trim()) ||
    (process.env.NODE_ENV === 'production'
      ? (process.env.PARSER_URL_PROD && process.env.PARSER_URL_PROD.trim())
      : (process.env.PARSER_URL_LOCAL && process.env.PARSER_URL_LOCAL.trim())) ||
    // last-ditch local fallback only if nothing else is set
    'http://localhost:8080';

  const token =
    (process.env.PARSER_TOKEN && process.env.PARSER_TOKEN.trim()) ||
    (process.env.NODE_ENV === 'production'
      ? (process.env.PARSER_TOKEN_PROD && process.env.PARSER_TOKEN_PROD.trim())
      : (process.env.PARSER_TOKEN_LOCAL && process.env.PARSER_TOKEN_LOCAL.trim())) ||
    '';

  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('PARSER_URL must include http(s)://');
  }

  return { baseUrl, token };
}

const parser = makeParserConnector(game, { emitLog, broadcast });

// Simple bearer token check
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

app.use('/admin', (req, res, next) => {
  if (!ADMIN_TOKEN) return next(); // allow if not set (dev)
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/,'');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});

app.use('/admin', admin(
  game,
  emitLog,
  broadcast,
  {
    clearQueues: () => {
      game._windowCounts = { left:0, right:0, rotate:0 };
      windowStart = Date.now();
    },
    addVote: (cmd) => {
      game._windowCounts = game._windowCounts || { left:0, right:0, rotate:0 };
    },
    parser,                                   
    pickParserEnv                           
  }
));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/', express.static(path.join(__dirname, '..', 'client')));

// Allow admin to set streamId dynamically
game.streamId = null; // set via /admin/stream
setInterval(() => {
  if (!game.streamId) return;
  if (!game.useParser) {
    // legacy path (not used once parser is active)
    // pollEvents(game.streamId);
  }
  // always keep EMA via viewer_snapshots
  pollViewerSnapshots(game.streamId);
}, 500);


app.post('/admin/restart', async (req, res) => {
  try {
    // clear queued chat votes
    windowCounts = { left:0, right:0, rotate:0 };
    windowStart = Date.now();

    // wipe board/score but keep stream binding
    game.resetAll();
    game.start();

    startCountdown(3000);

    emitLog('game_restarted');
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e) });
  }
});

// SSE to client overlay

app.post('/stream', async (req, res) => {
  try {
    const { url, stream_id } = req.body || {};

    // Option A: URL → videoId → resolve from streams table
    if (url) {
      const videoId = extractYouTubeVideoId(url);
      if (!videoId) return res.status(400).json({ ok: false, error: 'Invalid YouTube URL' });

      const resolved = await resolveStreamFromVideoId(videoId);
      if (!resolved) {
        return res.status(404).json({
          ok: false,
          error: 'No streams row found for that videoId',
          videoId
        });
      }

      game.streamId = resolved.stream_id;
      game.videoId = videoId;
      game.streamTitle = resolved.title || null;
      game.streamMaxViewers = resolved.max_viewers || 0;
      game.sinceId = 0;

      return res.json({ ok: true, video_id: videoId, ...resolved });
    }

    // Option B: direct stream_id fallback
    if (stream_id) {
      game.streamId = stream_id;
      game.videoId = null;
      game.streamTitle = null;
      game.streamMaxViewers = 0;
      game.sinceId = 0;

      return res.json({ ok: true, stream_id });
    }

    return res.status(400).json({ ok: false, error: 'Provide `url` or `stream_id`.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/state', (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const ping = setInterval(()=>res.write(`event: ping\ndata: {}\n\n`), 20000);
  req.on('close', ()=>{ clearInterval(ping); sseClients.delete(res); });
});

app.get('/admin/ui', (req, res) => {
  res.type('html').send(`
<!doctype html>
<meta charset="utf-8" />
<title>Chatris Admin</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap');
  body{margin:24px;background:#0b0e12;color:#e7eefb;font-family:"Press Start 2P",system-ui,Arial}
  input,button{font-size:14px;padding:10px;border-radius:10px;border:2px solid #2d3a57;background:#0f1626;color:#e7eefb}
  button{cursor:pointer}
  .row{display:flex;gap:8px;align-items:center;margin-bottom:12px}
  .card{background:linear-gradient(180deg,#0d1320,#0f1626);border:2px solid #2d3a57;border-radius:12px;box-shadow:0 12px 30px rgba(0,0,0,.45),inset 0 2px 0 rgba(255,255,255,.04);padding:14px;margin-bottom:18px}
  .votes{display:flex;gap:18px;font-size:14px}
  .votes .pill{background:#0f1626;border:2px solid #2d3a57;border-radius:10px;padding:10px 14px;min-width:140px;text-align:center}
  pre#out{white-space:pre-wrap}
</style>
<div class="card">
  <h2>Chatris Admin</h2>
  <div class="row">
    <input id="yt" placeholder="Paste YouTube URL (watch/live/live_chat/youtu.be)" style="flex:1" />
    <button onclick="setByUrl()">Set Stream</button>
  </div>
  <div class="row">
    <input id="sid" placeholder="...or paste raw stream_id (UUID)" style="flex:1" />
    <button onclick="setById()">Set by ID</button>
  </div>
  <div class="row">
    <button onclick="startGame()">Start</button>
    <button onclick="clearBoard()">Clear Board</button>
    <button onclick="endGame()">End</button>
  </div>
  <pre id="out"></pre>
</div>

<div class="card">
  <h3>Command Queue</h3>
  <div class="votes">
    <div class="pill">left: <b id="vleft">0</b></div>
    <div class="pill">right: <b id="vright">0</b></div>
    <div class="pill">rotate: <b id="vrot">0</b></div>
    <div class="pill">viewers: <b id="adminViewers">0</b></div>
  </div>
</div>

<div class="card">
  <h3>Log</h3>
  <div id="log" style="max-height:260px; overflow:auto; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.35; white-space:pre-wrap;"></div>
</div>

<script>
  async function setById(){
    const stream_id = document.getElementById('sid').value.trim();
    const r = await fetch('/admin/stream', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({stream_id})});
    const txt = await r.text(); try { document.getElementById('out').textContent = JSON.stringify(JSON.parse(txt), null, 2); } catch { document.getElementById('out').textContent = txt; }
  }
  async function startGame(){ const r = await fetch('/admin/start', {method:'POST'}); document.getElementById('out').textContent = await r.text(); }
  async function clearBoard(){ const r = await fetch('/admin/clear', {method:'POST'}); document.getElementById('out').textContent = await r.text(); }
  async function endGame(){ const r = await fetch('/admin/end', {method:'POST'}); document.getElementById('out').textContent = await r.text(); }

  const es = new EventSource('/state');

  es.addEventListener('votes', e => {
    const v = JSON.parse(e.data);
    document.getElementById('vleft').textContent = v.left || 0;
    document.getElementById('vright').textContent = v.right || 0;
    document.getElementById('vrot').textContent = v.rotate || 0;
  });
  es.addEventListener('log', e => {
    const line = JSON.parse(e.data);
    const el = document.createElement('div');
    const ts = new Date(line.t).toLocaleTimeString();
    el.textContent = '[' + ts + '] ' + line.msg + ' ' + JSON.stringify(line);
    const box = document.getElementById('log');
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  });
  es.addEventListener('state', e=>{
    const s = JSON.parse(e.data);
    const el = document.getElementById('adminViewers');
    if (el) el.textContent = s.emaViewers ?? 0;
  });
  async function setByUrl(){
    const url = document.getElementById('yt').value.trim();
    const r = await fetch('/admin/stream', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ url })
    });
    const txt = await r.text();
    try { document.getElementById('out').textContent = JSON.stringify(JSON.parse(txt), null, 2); }
    catch { document.getElementById('out').textContent = txt; }
  }    
</script>
  `);
});

function broadcast(type, data){
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) c.write(payload);
}

function emitLog(msg, data = {}) {
  const payload = { t: Date.now(), msg, ...data };
  broadcast('log', payload);
  console.log('[LOG]', payload);
}

// bucket speed so we log only on noticeable changes (0.05x steps)
let lastSpeedBucket = null;
function speedBucket(gravityMs) {
  const x = 1000 / Math.max(1, gravityMs);          // x-multiplier vs 1000ms
  return Math.round(x * 20) / 20;                    // 0.05 increments
}
function maybeLogSpeedChange(gravityMs, ema) {
  const b = speedBucket(gravityMs);
  if (lastSpeedBucket === null) { lastSpeedBucket = b; return; }
  if (b !== lastSpeedBucket) {
    emitLog('speed_changed', { from: lastSpeedBucket, to: b, ema: Math.round(ema) });
    lastSpeedBucket = b;
  }
}

// count occupied rows (for dono deltas)
function occupiedRowCount(board) {
  let n = 0;
  for (let y = 0; y < board.length; y++) if (board[y].some(c => c)) n++;
  return n;
}

// Simple EMA
game.sinceViewerId = 0; // add this to your GameState or store alongside

let ema = 0;
function updateEMA(viewers, alpha=0.2){ ema = (1-alpha)*ema + alpha*viewers; return ema; }

async function pollViewerSnapshots(stream_id){
  if (!stream_id) return;
  const { data, error } = await supa
    .from('viewer_snapshots')
    .select('id, viewers')
    .eq('stream_id', stream_id)
    .gt('id', game.sinceViewerId || 0)
    .order('id', { ascending: true })
    .limit(500);
  if (error) { console.error('viewer poll error', error); return; }

  for (const r of data) {
    game.emaViewers = updateEMA(Number(r.viewers)); // no log here
    game.sinceViewerId = Math.max(game.sinceViewerId || 0, r.id);
  }
}

// Poll Supabase for new events (id cursor)
async function pollEvents(stream_id){
  const { data, error } = await supa
    .from('stream_events')
    .select('*')
    .eq('stream_id', stream_id)
    .gt('id', game.sinceId)
    .order('id', { ascending: true })
    .limit(500);
  if (error) return console.error('poll error', error);

  for (const e of data) {
    game.sinceId = Math.max(game.sinceId, e.id);

    if (e.type === 'chat') {
      const cmd = parseCommand(e.message || '');
      if (!cmd) continue;
      const last = authorCooldown.get(e.author) || 0;
      if (Date.now() - last < CHAT_COOLDOWN_MS) continue;
      authorCooldown.set(e.author, Date.now());
      windowCounts[cmd] = (windowCounts[cmd]||0) + 1;
    }

    if (e.type === 'superchat') {
      const effect = effectFromSuperchat({
        tier: e.tier,
        color: e.color,
        colorVars: e.colorVars,
        amount: e.amount,
        amount_float: e.amount_float
      });
      if (effect) {
        const scoreBefore = game.score;
        const rowsBefore  = occupiedRowCount(game.board);

        const added = game.applyEffect(effect);

        if (effect.scoreCredit === false) {
          game.score = scoreBefore; // cancel any score the effect awarded
        }
        const scoreDelta = game.score - scoreBefore;
        const rowsAfter  = occupiedRowCount(game.board);

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
      }
    }

    if (e.type === 'gift' && e.gift_count) {
      game.giftsRecent += Number(e.gift_count);
      game.hudToast = { kind: 'gift', author: e.author, count: Number(e.gift_count) };
      broadcast('toast', game.hudToast);
      logLine('gift', { author: e.author, count: Number(e.gift_count) });
    }

    if (e.type === 'meta' && typeof e.viewers === 'number') {
      game.emaViewers = updateEMA(e.viewers);
    }
  }
}

// Window resolution loop (quiet)
const VOTES_DEBUG = process.env.VOTES_DEBUG === '1';  // opt-in extra logs

setInterval(() => {
  const now = Date.now();
  if (now - windowStart < CMD_WINDOW_MS) return;
  windowStart = now;

  const wc = game._windowCounts || { left:0, right:0, rotate:0 };
  const left   = wc.left   | 0;
  const right  = wc.right  | 0;
  const rotate = wc.rotate | 0;

  // Only log snapshots when there is activity (or when explicitly debugged)
  if (left || right || rotate) {
    // emitLog('votes_snapshot', { left, right, rotate });
  } else if (VOTES_DEBUG) {
    emitLog('votes_idle', {});
  }

  let cmd = null;
  if (left>right && left>rotate) cmd='left';
  else if (right>left && right>rotate) cmd='right';
  else if (rotate>left && rotate>right) cmd='rotate';

  broadcast('votes', { left, right, rotate });
  if (left || right || rotate) emitLog('votes_snapshot', { left, right, rotate });

  if (cmd) {
    if (cmd === 'left') game.moveLeft();
    if (cmd === 'right') game.moveRight();
    if (cmd === 'rotate') game.rotate();
    emitLog('move_applied', { cmd, counts: { left, right, rotate } });
  }

  game._windowCounts = { left:0, right:0, rotate:0 };
}, 50);

// Gravity loop
setInterval(() => {
  const now = Date.now();
  const dt  = now - lastPhysicsAt;
  lastPhysicsAt = now;

  // Gate physics while countdown is showing (set game.pausedUntil = Date.now()+3000 when you broadcast the countdown)
  if (game.freezeUntil && now < game.freezeUntil) {
    // Still broadcast HUD so UI stays live, but do NOT advance physics
    broadcast('state', {
      board: game.board,
      score: game.score,
      highScore: game.highScore,
      emaViewers: Math.round(game.emaViewers),
      gravityMs: 0, // paused
      nextQueue: game.nextQueue?.slice(0, 3) ?? [],
      current: game.current ? { id: game.current.id, x: game.current.x, y: game.current.y, r: game.current.r } : null,
      next: game.nextQueue?.[0] ?? null,
      sinceId: game.sinceId,
      floorRows: game.floorRows,
      boardW: game.board[0]?.length,
      boardH: game.board.length
    });
    return;
  }

  // Apply global damp (≈ +0.25% slower) on top of viewer/gift-derived gravity
  const gmsBase = gravityFrom(game.emaViewers, undefined, game.giftsRecent);
  const gms     = Math.round(gmsBase * (Number(SPEED_DAMP) || 1.0025));
  maybeLogSpeedChange(gms, game.emaViewers);

  // Optional: decay gifts slowdown once per second
  game._giftDecayAcc = (game._giftDecayAcc || 0) + dt;
  if (game._giftDecayAcc >= 1000) {
    if (game.giftsRecent > 0) game.giftsRecent -= 1;
    game._giftDecayAcc = 0;
  }

  // Advance physics with damped gravity
  game.tick(dt, gms);

  // Broadcast state to the overlay
  broadcast('state', {
    board: game.board,
    score: game.score,
    highScore: game.highScore,
    emaViewers: Math.round(game.emaViewers),
    gravityMs: gms,
    nextQueue: game.nextQueue?.slice(0, 3) ?? [],
    current: game.current ? { id: game.current.id, x: game.current.x, y: game.current.y, r: game.current.r } : null,
    next: game.nextQueue?.[0] ?? null,
    sinceId: game.sinceId,
    floorRows: game.floorRows,
    boardW: game.board[0]?.length,
    boardH: game.board.length
  });
}, 120);

app.listen(process.env.PORT || 8080, ()=>console.log('server up'));

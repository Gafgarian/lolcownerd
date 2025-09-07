import 'dotenv/config'; 
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { supa } from './supabase.js';
import { GameState } from './state.js';
import { parseCommand, CMD_WINDOW_MS, CHAT_COOLDOWN_MS, donationEffectFrom, gravityFrom } from './rules.js';
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

// Simple bearer token check
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
app.use('/admin', (req, res, next) => {
  if (!ADMIN_TOKEN) return next(); // allow if not set (dev)
  const token = req.headers['x-admin-token'] || req.headers['authorization']?.replace(/^Bearer\s+/,'');
  if (token !== ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'unauthorized' });
  next();
});
app.use('/admin', admin(game, emitLog));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/', express.static(path.join(__dirname, '..', 'client')));

// Allow admin to set streamId dynamically
game.streamId = null; // set via /admin/stream
setInterval(() => {
  if (game.streamId) {
    pollEvents(game.streamId);
    pollViewerSnapshots(game.streamId);
  }
}, 500);

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
  body{font-family:system-ui,Arial;margin:24px;background:#0b0e12;color:#e8eef7}
  input,button{font-size:16px;padding:8px;border-radius:8px;border:1px solid #273244;background:#111623;color:#e8eef7}
  button{cursor:pointer}
  .row{display:flex;gap:8px;align-items:center;margin-bottom:12px}
  .card{background:#121722;border:1px solid #263040;padding:12px;border-radius:10px;max-width:840px;margin-bottom:12px}
  .votes{display:flex;gap:18px;font-size:18px}
  .votes .pill{background:#0f1626;border:1px solid #2a3a55;border-radius:10px;padding:10px 14px;min-width:120px;text-align:center}
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
  <h3>Live Votes</h3>
  <div class="votes">
    <div class="pill">left: <b id="vleft">0</b></div>
    <div class="pill">right: <b id="vright">0</b></div>
    <div class="pill">rotate: <b id="vrot">0</b></div>
  </div>
</div>

<div class="card">
  <h3>Log</h3>
  <div id="log" style="max-height:260px; overflow:auto; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; line-height:1.35; white-space:pre-wrap;"></div>
</div>

<script>
async function setByUrl(){
  const url = document.getElementById('yt').value.trim();
  const r = await fetch('/admin/stream', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url})});
  const txt = await r.text(); try { document.getElementById('out').textContent = JSON.stringify(JSON.parse(txt), null, 2); } catch { document.getElementById('out').textContent = txt; }
}
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

    if (e.type === 'superchat' && e.amount_float) {
      const effect = donationEffectFrom(Number(e.amount_float));
      if (effect) {
        const scoreBefore = game.score;
        const rowsBefore = occupiedRowCount(game.board);
        const added = game.applyEffect(effect);
        const scoreDelta = game.score - scoreBefore;
        const rowsAfter = occupiedRowCount(game.board);
        broadcast('toast', { kind:'superchat', author:e.author, message:e.message, amount:e.amount_float, effect, added });
        emitLog('donation_effect', {
          author: e.author, amount: Number(e.amount_float), effect,
          scoreDelta, rowsBefore, rowsAfter
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

// Window resolution loop
setInterval(()=>{
  const now = Date.now();
  if (now - windowStart >= CMD_WINDOW_MS) {
    const { left, right, rotate } = windowCounts;
    let cmd = null;
    if (left>right && left>rotate) cmd='left';
    else if (right>left && right>rotate) cmd='right';
    else if (rotate>left && rotate>right) cmd='rotate';
    
    broadcast('votes', { left, right, rotate });    
    if (cmd) {
      if (cmd === 'left') game.moveLeft();
      if (cmd === 'right') game.moveRight();
      if (cmd === 'rotate') game.rotate();
      emitLog('move_applied', { cmd, counts: { left, right, rotate } });
    }
    windowCounts = { left:0, right:0, rotate:0 };
    windowStart = now;
  }
}, 50);

// Gravity loop
setInterval(()=>{
  const now = Date.now();
  const dt = now - lastPhysicsAt;
  lastPhysicsAt = now;

  const gms = gravityFrom(game.emaViewers, undefined, game.giftsRecent);
  maybeLogSpeedChange(gms, game.emaViewers);

  // Optional: decay gifts slowdown once per second
  game._giftDecayAcc = (game._giftDecayAcc || 0) + dt;
  if (game._giftDecayAcc >= 1000) {
    if (game.giftsRecent > 0) game.giftsRecent -= 1;
    game._giftDecayAcc = 0;
  }

  game.tick(dt, gms);

  // Broadcast state to the overlay
  broadcast('state', {
    board: game.board,
    score: game.score,
    highScore: game.highScore,
    emaViewers: Math.round(game.emaViewers),
    gravityMs: Math.round(gms),
    nextQueue: game.nextQueue.slice(0,3),
    current: game.current
      ? { id: game.current.id, x: game.current.x, y: game.current.y, r: game.current.r }
      : null,
    next: game.nextQueue && game.nextQueue.length ? game.nextQueue[0] : null,
    sinceId: game.sinceId
  });
}, 120);

app.listen(process.env.PORT || 8080, ()=>console.log('server up'));

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import { WORLD, STRAIGHT_THRESH, TEAMS, CAR_ACROSS } from '../../sim-core/config.mjs';
import { buildTrackGeometry } from '../../sim-core/track.mjs';
import { buildPit } from '../../sim-core/pit.mjs';
import { createCars, applyCoeffs } from '../../sim-core/cars.mjs';
import { initSplits, updateHalfSplit } from '../../sim-core/splits.mjs';
import { step as physicsStep } from '../../sim-core/physics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme';

// --- Express
const app = express();
app.use(express.static(path.join(__dirname, '../../public')));
const server = app.listen(PORT, ()=> console.log('[LCU GP] server on', PORT));

// --- WebSocket (same HTTP server)
const wss = new WebSocketServer({ server });

// ---- helpers ---------------------------------------------------------------

// compute a simple pit meta from geometry (longest straight)
function computePitMeta(geom, STRAIGHT_THRESH=0.001) {
  const cl = geom.centerline || [];
  if (!cl.length) return { pitIds: [], pitEntryIdx: 0, pitExitIdx: 0 };

  // find longest run of "straight-ish"
  let best = {len:0,start:0}, cur = {len:0,start:0};
  for (let k=0; k<cl.length*2; k++) {
    const i = k % cl.length;
    const straight = (cl[i].curv < STRAIGHT_THRESH);
    if (straight) {
      if (cur.len === 0) cur.start = i;
      cur.len++;
      if (cur.len > best.len) best = { len: cur.len, start: cur.start };
    } else {
      cur.len = 0;
    }
  }
  // collect indices (inclusive)
  const pitIds = [];
  if (best.len) {
    let i = best.start;
    for (let n=0; n<best.len; n++) { pitIds.push(i); i = (i+1) % cl.length; }
  }
  const n = pitIds.length || 1;
  const pitEntryIdx = Math.floor(n * 0.18);
  const pitExitIdx  = Math.floor(n * 0.86);
  return { pitIds, pitEntryIdx, pitExitIdx };
}

// ---------------------------------------------------------------------------

async function loadStatsJSON(){
  try {
    const p = path.join(__dirname, '../../public/assets/config/cars.json');
    const json = JSON.parse(await readFile(p, 'utf8'));
    if (json.teams) return json.teams; // id->stats
    return json;
  } catch {
    return {};
  }
}

// --- Build geometry + cars
const geom  = buildTrackGeometry(WORLD);
const pit = buildPit({ ...geom, teamsCount: TEAMS.length });
const stats = await loadStatsJSON();
const cars  = createCars(TEAMS, geom.totalLen);
applyCoeffs(cars, stats);

// embed sim
const sim = {
  ...geom,
  pit,
  cars,
  STRAIGHT_THRESH,
  CORNER_PASS_K: STRAIGHT_THRESH * 2.2,
  CAR_ACROSS,
  LANE_W: geom.LANE_W,
  startLineS: pit.startLineS,
  startLineIndex: pit.startLineIndex,
  paused: true,
  raceState: 'grid',
  clockMs: Date.now(),
  lapSamples: [],
  splits: initSplits(geom, pit),
  updateHalfSplit,
};

function makeWorldPayload(){
  // pit-lane meta derived from geometry so the viewer can draw it
  const { pitIds, pitEntryIdx, pitExitIdx } = computePitMeta(geom, STRAIGHT_THRESH);

  return {
    type:'world',
    world: WORLD,
    teams: TEAMS,
    geom: {
      width: geom.width, height: geom.height, totalLen: geom.totalLen,
      centerline: geom.centerline.map(p=>({x:p.x,y:p.y,theta:p.theta,curv:p.curv,ksign:p.ksign,s:p.s})),
      leftPts: geom.leftPts, rightPts: geom.rightPts,
      startLineIndex: sim.startLineIndex, startLineS: sim.startLineS, carAcross: CAR_ACROSS,
      LANE_W: sim.LANE_W, HALF_W_NORMAL: geom.HALF_W_NORMAL, HALF_W_STRAIGHT: geom.HALF_W_STRAIGHT,
      pitIds, pitEntryIdx, pitExitIdx
    }
  };
}

function makeSnapshot(S){
  const rows = S.cars.map(c=>({
    id: c.team.id,
    s: c.s,                  // should be a number
    v: c.v,                  // should be a number
    lap: c.lap|0,
    lateral: c.lateral,
    inPit: c.inPit,
    pitState: c.pitState,
    bestLapMs: c.bestLapMs,
    lastLapMs: c.lastLapMs
  }));

  // Debug guard: log if any bad values escape
  if (rows.some(r => !Number.isFinite(r.s) || !Number.isFinite(r.v))) {
    console.warn('[SNAP_BAD]', rows
      .filter(r => !Number.isFinite(r.s) || !Number.isFinite(r.v))
      .map(r => `${r.id}: s=${r.s} v=${r.v}`).join(', '));
  }

  return {
    t: S.clockMs,
    state: S.raceState,
    startLineS: S.startLineS,
    halfLapNumber: S.splits.halfLapNumber,
    halfGaps: Object.fromEntries(S.splits.halfGaps),
    cars: rows
  };
}

const clients = new Set();

function broadcastState(){
  const msg = JSON.stringify({ type:'state', state: sim.raceState, paused: sim.paused });
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
}

wss.on('connection', (ws, req) => {
  const isAdminReq = req.url.includes('role=admin');
  const hdr = req.headers['sec-websocket-protocol'];
  const protoToken = Array.isArray(hdr) ? hdr[0] : (hdr ? String(hdr).split(',')[0].trim() : '');
  const qsToken = new URL('http://x' + req.url).searchParams.get('token');
  const token = protoToken || qsToken;
  ws.isAdmin = isAdminReq && token === ADMIN_TOKEN;

  clients.add(ws);

  // send world + first snapshot + current state
  ws.send(JSON.stringify(makeWorldPayload()));
  ws.send(JSON.stringify({ type:'snapshot', payload: makeSnapshot(sim) }));
  ws.send(JSON.stringify({ type:'state', state: sim.raceState, paused: sim.paused }));

  ws.on('message', (buf)=>{
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'cmd' && ws.isAdmin) handleAdmin(msg);
    } catch {}
  });
  ws.on('close', ()=> clients.delete(ws));
});

function lineupGrid(S) {
  const across = S.CAR_ACROSS;               // sprite “height”
  const rowGap = 2.4 * across;               // spacing between rows
  const lanes  = [-S.LANE_W * 0.85, +S.LANE_W * 0.85];  // left/right

  const sHead = (S.startLineS - 3.0 * across + S.totalLen) % S.totalLen;

  S.cars.forEach((c, i) => {
    const row = Math.floor(i / 2), col = i % 2;
    const s   = (sHead - row * rowGap + S.totalLen) % S.totalLen;

    c.s = s;
    c.v = 0;
    c.lateral = lanes[col];
    c.inPit = false;
    c.pitState = 'none';
    c.boost = 0;

    // timing counters
    c.lap = 0;
    c.bestLapMs = Infinity;
    c.lastLapMs = Infinity;
  });
}

function resetRace(S) {
  lineupGrid(S);
  S.clockMs = Date.now();
  S.splits = initSplits(S, S.pit);   // refresh split/half-lap bookkeeping
  S.raceState = 'grid';
  S.paused = true;
}

function handleAdmin(msg){
  switch (msg.name) {
    case 'start':
      sim.paused = false; sim.raceState = 'green'; broadcastState(); 
      console.log('[SNAP COUNT]', sim.cars.length, sim.cars.map(c=>c.team.id).join(','));
      break;
    case 'pause':
      sim.paused = true;  broadcastState(); break;
    case 'resume':
      sim.paused = false; sim.raceState = 'green'; broadcastState(); break;
    case 'finish':
      sim.paused = true;  sim.raceState = 'finished'; broadcastState(); break;
    case 'grid':
      resetRace(sim); 
      broadcastState();
      // push a fresh snapshot right away so clients jump to grid
      {
        const snap = JSON.stringify({ type:'snapshot', payload: makeSnapshot(sim) });
        for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(snap);
      }
      break;
  }
}

// --- Loop (unchanged except the block below)
const TICK = 1000/120;
const SNAP_EVERY = 4;
let tick = 0;

setInterval(()=>{
  sim.clockMs += TICK;
  if (!sim.paused) physicsStep(TICK, sim);
  if (tick % SNAP_EVERY === 0) {
    const snap = JSON.stringify({ type:'snapshot', payload: makeSnapshot(sim) });
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(snap);
  }
  tick++;
}, TICK);
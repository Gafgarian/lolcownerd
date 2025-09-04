import express from 'express';
import { WebSocketServer } from 'ws';
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
const pit   = buildPit(geom);
const stats = await loadStatsJSON();
const cars  = createCars(TEAMS, geom.totalLen);
applyCoeffs(cars, stats);

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
  updateHalfSplit, // fn from splits.mjs
};

function makeWorldPayload(){
  return {
    type:'world',
    world: WORLD,
    teams: TEAMS,
    geom: {
      width: geom.width, height: geom.height, totalLen: geom.totalLen,
      centerline: geom.centerline.map(p=>({x:p.x,y:p.y,theta:p.theta,curv:p.curv,ksign:p.ksign,s:p.s})),
      leftPts: geom.leftPts, rightPts: geom.rightPts,
      startLineIndex: sim.startLineIndex, startLineS: sim.startLineS,
      LANE_W: sim.LANE_W, HALF_W_NORMAL: geom.HALF_W_NORMAL, HALF_W_STRAIGHT: geom.HALF_W_STRAIGHT
    }
  };
}
function makeSnapshot(S){
  return {
    t: S.clockMs,
    state: S.raceState,
    startLineS: S.startLineS,
    halfLapNumber: S.splits.halfLapNumber,
    halfGaps: Object.fromEntries(S.splits.halfGaps),
    cars: S.cars.map(c=>({
      id: c.team.id, s: c.s, v: c.v, lap: c.lap,
      lateral: c.lateral, inPit: c.inPit, pitState: c.pitState,
      bestLapMs: c.bestLapMs, lastLapMs: c.lastLapMs
    }))
  };
}

const clients = new Set();
wss.on('connection', (ws, req) => {
  const isAdminReq = req.url.includes('role=admin');
  const token = req.headers['sec-websocket-protocol'];
  ws.isAdmin = isAdminReq && token === ADMIN_TOKEN;

  clients.add(ws);
  // send world and first snapshot
  ws.send(JSON.stringify(makeWorldPayload()));
  ws.send(JSON.stringify({ type:'snapshot', payload: makeSnapshot(sim) }));

  ws.on('message', (buf)=>{
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.type === 'cmd' && ws.isAdmin) handleAdmin(msg);
    } catch {}
  });
  ws.on('close', ()=> clients.delete(ws));
});

function handleAdmin(msg){
  switch (msg.name) {
    case 'start':
      sim.paused = false; sim.raceState = 'green'; break;
    case 'pause':
      sim.paused = true;  break;
    case 'finish':
      sim.paused = true;  sim.raceState = 'finished'; break;
    case 'boost': {
      const c = sim.cars.find(x=>x.team.id===msg.teamId);
      if (c) c.boost += msg.delta ?? 0.06;
      break;
    }
  }
}

// --- Loop
const TICK = 1000/120;
const SNAP_EVERY = 4; // 120Hz sim -> ~30fps broadcast
let tick = 0;

setInterval(()=>{
  sim.clockMs += TICK;
  if (!sim.paused) physicsStep(TICK, sim);
  if (tick % SNAP_EVERY === 0) {
    const snap = JSON.stringify({ type:'snapshot', payload: makeSnapshot(sim) });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(snap);
  }
  tick++;
}, TICK);
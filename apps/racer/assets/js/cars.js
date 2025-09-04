import { State } from './lib/state.js';
import { sampleAtS } from './track.js';
import { OVERHEAD, SIDE, TEAMS, CARS_JSON, SPRITE_HEADING_OFFSET } from './lib/config.js';
import { loadImage } from './lib/util.js';


export function buildCoefficients(stats){
  const f = (x, lo=0.70, step=0.06)=> lo + step*x;
  const clip = (v,a,b)=>Math.max(a,Math.min(b,v));

  const speedF = 0.88 + 0.03*stats.spd;
  const accelF = f(stats.acc, 0.65, 0.055);
  const brakeF = 1.0;
  const cornerK= 120 / f(stats.han, 0.70, 0.06);

  const risk   = stats.rsk;
  const safeGap = clip(65 * (1.20 - 0.05*risk), 35, 85);
  const overtakeDelta = 0.02 * (1 - 0.05*(risk-5));

  const pitSpeed = 0.12 * f(stats.pit, 0.70, 0.05);
  const refillRate = 0.00040 * f(stats.pit, 0.80, 0.05);
  const wearRate   = 0.000022 * (1.20 - 0.07*stats.end);

  return {
    V_STRAIGHT_BASE: 0.25 * speedF,
    V_MIN: 0.08,
    ACCEL: 0.00022 * accelF,
    BRAKE: 0.00042 * brakeF,
    CORNER_COEF: cornerK,
    SAFE_GAP: safeGap,
    OVERTAKE_DELTA: overtakeDelta,
    PIT_SPEED: pitSpeed,
    REFILL_RATE: refillRate,
    WEAR_RATE: wearRate,
  };
}

export async function loadCarStats(){
  State.CAR_STATS = {};
  let data = null;
  const inline = document.getElementById('cars-config');
  if (inline && inline.textContent.trim()) {
    try { data = JSON.parse(inline.textContent); } catch(e){ console.warn('cars-config parse failed', e); }
  }
  if (!data) {
    try {
      const url = new URL(CARS_JSON, window.location.href);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      data = await res.json();
    } catch (err) {
      console.warn('cars.json load failed; neutral stats', err);
      data = null;
    }
  }
  const add = (id,row={})=>{
    if(!id) return;
    const k=String(id).toLowerCase();
    const pick=(...ks)=>{ for(const kk of ks) if(row[kk]!=null) return +row[kk]; };
    State.CAR_STATS[k] = {
      spd: pick('spd','SPD') ?? 5,
      acc: pick('acc','ACC') ?? 5,
      han: pick('han','HAN') ?? 5,
      pit: pick('pit','PIT') ?? 5,
      end: pick('end','END') ?? 5,
      rsk: pick('rsk','RSK') ?? 5,
    };
  };
  if (data) {
    if (Array.isArray(data)) data.forEach(r=>add(r.id||r.show||r.name, r));
    else if (Array.isArray(data.cars||data.shows)) (data.cars||data.shows).forEach(r=>add(r.id||r.show||r.name, r));
    else if (data.teams && typeof data.teams==='object') for(const [id,row] of Object.entries(data.teams)) add(id,row);
  }
  if (Object.keys(State.CAR_STATS).length===0) TEAMS.forEach(t=>State.CAR_STATS[t.id]={spd:5,acc:5,han:5,pit:5,end:5,rsk:5});
}

function buildGridSlots(n){
  const { centerline, startLineIndex, totalLen, LANE_W, DPR } = State;
  const baseS = centerline[startLineIndex].s;           // S/F
  const rowGap = Math.max(120*DPR, LANE_W*2.0);         // distance between rows (px along centerline)
  const cols   = [-LANE_W*0.75, +LANE_W*0.75];          // two columns (left/right of center)
  const slots = [];
  let row = 0;
  for (let i=0;i<n;i++){
    const col = i % 2;
    if (col === 0 && i>0) row++;                        // advance a row every two cars
    // walk BACK from S/F for rows so the first row is nearest the line
    let s = baseS - row*rowGap;
    while (s < 0) s += totalLen;
    slots.push({ s, lateral: cols[col] });
  }
  return slots;
}

export function gridCars() {
  if (!State.cars.length || !State.totalLen) return;

  // geometry
  const CAR_W    = (State.dims?.CAR_ACROSS) || 56 * (State.DPR || 1);
  const rowGapS  = CAR_W * 2.0;            // along-track spacing
  const colOff   = State.LANE_W * 0.55;    // lateral offset from center
  const s0       = State.startLineS || 0;  // place rows behind S/F

  // order cars deterministically (by team id) so grid is stable
  const ordered = [...State.cars].sort((a,b)=> (a.team.id > b.team.id ? 1 : -1));

  ordered.forEach((c, i) => {
    const col = i % 2;                     // 0=inside, 1=outside
    const row = (i / 2) | 0;
    const s   = (s0 - (row+1) * rowGapS + State.totalLen) % State.totalLen;

    const p   = sampleAtS(s);
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const lat = (col === 0 ? -colOff : colOff);

    c.s = s; c.v = 0; c.lateral = lat; c.targetLateral = lat;

    c.rx = p.x + nx*lat;
    c.ry = p.y + ny*lat;
    c.rTheta = p.theta + (Math.PI/2);
    c.rY = c.ry;

    // prime interpolation buffers so first frame draws correctly
    c.px = c.rx; c.py = c.ry; c.pTheta = c.rTheta; c.pY = c.rY;
    c.prevS = s;
  });

  // remember who’s “selected” in panel
  State.selectedCarIdx = 0;
}

export function populateKartSelect() {
  const sel = document.getElementById('kartSelect');
  if (!sel) return;
  sel.innerHTML = State.cars.map((c,i)=>`<option value="${i}">${c.team.name}</option>`).join('');
  sel.value = '0';
}

export async function setupCars(){
  State.cars.length = 0;
  const slots = buildGridSlots(TEAMS.length);
  for (let idx=0; idx<TEAMS.length; idx++){
    const team = TEAMS[idx];
    let img;
    try {
      img = await loadImage(OVERHEAD(team.id));
    } catch (e) {
      // Fallback: tiny in-memory 1×1 canvas so the car still renders
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0,0,1,1);
      img = c;
      console.warn('Overhead sprite missing for', team.id, e);
    }

    // Place on the grid slot (s + lateral), facing the track heading
    const { s, lateral } = slots[idx];
    const p0 = sampleAtS(s);
    const x=p0.x, y=p0.y, th=p0.theta + SPRITE_HEADING_OFFSET;

    const stats = State.CAR_STATS[team.id] || {spd:5,acc:5,han:5,pit:5,end:5,rsk:5};
    const cfg   = buildCoefficients(stats);

    State.cars.push({
      team, img, aspect: img.naturalWidth/img.naturalHeight,
      s, v:0, boost:0, lap:0,                     // v=0 until START
      lateral, targetLateral:lateral,
      energy: 1, wantPit:false, inPit:false,
      pitState:'none', pitStall:-1, pitStartMs:0, pitElapsedMs:0, pitTargetMs:0, bestPitMs:Infinity,
      pitSpin:0, lapStartMs:performance.now(), bestLapMs:Infinity, lastLapMs:Infinity, lapsSincePit:0,
      prevS: 0, stats, cfg,
      px:x,py:y,pTheta:th,pY:y, rx:x,ry:y,rTheta:th,rY:y
    });
  }
}

export function drawCars(alpha = 1) {
  const { ctx, DPR, cars } = State;
  ctx.save();
  ctx.setTransform(1,0,0,1,0,0);    
  ctx.globalCompositeOperation = 'source-over';
  const W = (State.dims?.CAR_ACROSS) || 56 * (State.DPR || DPR || 1);

  // painter's algorithm: draw far-to-near by world Y
  const order = [...cars].sort((a, b) => (a.rY - b.rY));
  for (const c of order) {
    if (!c) continue;
    // simple interpolation for smoothness (optional)
    const x = c.px + (c.rx - c.px) * alpha;
    const y = c.py + (c.ry - c.py) * alpha;
    const th = c.pTheta + (c.rTheta - c.pTheta) * alpha;

    const h = W / (c.aspect || 1);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(th);
    // draw even if the image hasn’t completed yet
    if (c.img && (c.img.complete !== false)) {
      ctx.drawImage(c.img, -W/2, -h/2, W, h);
    } else {
      ctx.fillStyle = '#ffc107';
      ctx.fillRect(-W/2, -h/2, W, h); // simple placeholder box
    }
    ctx.restore();
  }
  ctx.restore();
}
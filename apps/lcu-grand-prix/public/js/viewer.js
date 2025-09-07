// Renders server snapshots; NO physics here.

const canvas = document.getElementById('racerCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = true;

const DPR = Math.min(2, window.devicePixelRatio || 1);

// Assets
const IMG_BASE = "assets/images";
const OVERHEAD = id => `${IMG_BASE}/cars/overhead/${id}.png`;
const SIDE     = id => `${IMG_BASE}/cars/side/${id}-side.png`;
const GRASS_TILE = `${IMG_BASE}/other/grassBg.png`;

// ===== Modal (same structure as your original racer.html) =====
const modal          = document.getElementById('carModal');
const modalImgSide   = document.getElementById('modalSideImg');
const modalImgTop    = document.getElementById('modalTopImg');
const modalTitle     = document.getElementById('carModalTitle');
const modalPos       = document.getElementById('modalPos');
const modalLap       = document.getElementById('modalLap');
const modalSpd       = document.getElementById('modalSpd');
const modalStatGrid  = document.getElementById('modalStatGrid');
let   modalCarId     = null; // team id (lowercased)

// --- Image cache (URL -> HTMLImageElement) ---
const IMG_CACHE = new Map();
function getImg(url) {
  let im = IMG_CACHE.get(url);
  if (!im) {
    im = new Image();
    im.src = url;
    IMG_CACHE.set(url, im);
  }
  return im;
}

function fmtPit(ms){
  if (!Number.isFinite(ms)) return '00:00';
  const s  = Math.floor(ms/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
}

function showModal(){ if (!modal) return; modal.classList.add('show'); modal.setAttribute('aria-hidden','false'); }
function hideModal(){ if (!modal) return; modal.classList.remove('show'); modal.setAttribute('aria-hidden','true'); modalCarId=null; }
modal?.addEventListener('click', (e)=>{ if (e.target?.dataset?.close!==undefined) hideModal(); });
document.addEventListener('keydown', (e)=>{ if (e.key==='Escape') hideModal(); });

// ===== Load car stats (cars.json) so the modal can show the chips =====
const CARS_JSON="assets/config/cars.json";
let CAR_STATS = {}; // id -> {spd,acc,han,pit,end,rsk}
async function loadCarStats(){
  try {
    const inline = document.getElementById('cars-config');
    let data = null;
    if (inline?.textContent?.trim()) { try { data = JSON.parse(inline.textContent); } catch {} }
    if (!data) { const res = await fetch(CARS_JSON); if (res.ok) data = await res.json(); }
    const pick = (row,k1,k2)=> row[k1]!=null ? +row[k1] : (row[k2]!=null ? +row[k2] : undefined);
    const add = (id,row={})=>{
      if(!id) return;
      const key=String(id).toLowerCase();
      CAR_STATS[key] = {
        spd: pick(row,'SPD','spd') ?? 5, acc: pick(row,'ACC','acc') ?? 5, han: pick(row,'HAN','han') ?? 5,
        pit: pick(row,'PIT','pit') ?? 5, end: pick(row,'END','end') ?? 5, rsk: pick(row,'RSK','rsk') ?? 5
      };
    };
    if (data?.teams) for (const [id,row] of Object.entries(data.teams)) add(id,row);
    else if (Array.isArray(data)) data.forEach(r=>add(r.id||r.name||r.show,r));
  } catch {}
}
loadCarStats();

// One-time injection of the "Team Records" area; returns refs to its fields.
let _modalRecordRefs = null;
function ensureModalRecordsSection() {
  if (_modalRecordRefs) return _modalRecordRefs;

  const info = modal.querySelector('.modal-info') || modal; // fall back safely
  const block = document.createElement('div');
  block.className = 'records-block';

  const title = document.createElement('div');
  title.className = 'stat-title';
  title.textContent = 'Team Records';
  block.appendChild(title);

  const makeLine = (label, id) => {
    const row = document.createElement('div');
    row.className = 'stat-line';
    row.innerHTML = `<span>${label}</span><strong id="${id}">—</strong>`;
    block.appendChild(row);
  };

  makeLine('Fastest Lap',  'modalFastLap');
  makeLine('Fastest PIT',  'modalFastPit');
  makeLine('Top Speed',    'modalTopSpeed');

  // Place the block just above your chips/grid, if present
  const gridParent = modalStatGrid?.parentElement;
  if (gridParent) gridParent.parentElement.insertBefore(block, gridParent);
  else info.appendChild(block);

  _modalRecordRefs = {
    fastLapEl:  block.querySelector('#modalFastLap'),
    fastPitEl:  block.querySelector('#modalFastPit'),
    topSpdEl:   block.querySelector('#modalTopSpeed'),
  };
  return _modalRecordRefs;
}

function fillModalForTeam(teamId, orderList){
  const key  = String(teamId).toLowerCase();
  const team = teams.find(t => String(t.id).toLowerCase() === key) || { id:key, name:teamId };
  const side = SIDE(team.id), top = OVERHEAD(team.id);

  modalImgSide.src = side;
  modalImgTop.src  = top;
  modalTitle.textContent = team.name;

  const idx = orderList.findIndex(c => String(c.id).toLowerCase() === key);
  modalPos.textContent = idx >= 0 ? `#${idx+1}` : '—';
  const car = orderList[idx];

  // Basics
  modalLap.textContent = String(car?.lap ?? 0);
  modalSpd.textContent = (car && Number.isFinite(car.v)) ? `${(car.v*1000).toFixed(1)} px/s` : '—';

  // --- Team Records section ---
  const { fastLapEl, fastPitEl, topSpdEl } = ensureModalRecordsSection();

  // Fastest Lap
  if (fastLapEl) {
    const ms = Number(car?.bestLapMs);
    fastLapEl.textContent = Number.isFinite(ms) && ms > 0 ? fmtLap(ms) : '—';
  }

  // Fastest PIT (server-updated when service completes)
  if (fastPitEl) {
    const ms = Number(car?.bestPitMs);
    fastPitEl.textContent = Number.isFinite(ms) && ms < Infinity ? fmtCs(ms) : '—';
  }

  // Top Speed (viewer-side rolling record that we update on each snapshot)
  if (topSpdEl) {
    const topPxPerSec = topSpeeds?.[key] ?? 0;     // ← comes from snapshot handler
    topSpdEl.textContent = topPxPerSec > 0 ? `${topPxPerSec.toFixed(1)} px/s` : '—';
  }

  // Keep your stat chips
  const s = CAR_STATS[key] || {spd:5,acc:5,han:5,pit:5,end:5,rsk:5};
  if (modalStatGrid) {
    modalStatGrid.innerHTML = [
      ['SPD',s.spd],['ACC',s.acc],['HAN',s.han],
      ['PIT',s.pit],['END',s.end],['RSK',s.rsk]
    ].map(([k,v]) => `<div class="stat-chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');
  }

  modalCarId = key;       // used by your live-updater while the modal is open
  showModal();
}


// Side-panel (from original racer UI)
const toggleBtn  = document.getElementById('togglePanel');
const sidePanel  = document.getElementById('sidePanel');
const lbList     = document.getElementById('leaderboardList');
const viewerCtEl = document.getElementById('viewerCount');

toggleBtn?.addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  sidePanel?.setAttribute('aria-hidden', String(!open));
  toggleBtn?.setAttribute('aria-expanded', String(open));
});

// State from server
let world = null;     // { width, height }
let geom  = null;     // { centerline,leftPts,rightPts,totalLen,LANE_W,HALF_W_STRAIGHT,startLineIndex, pitIds,pitEntryIdx,pitExitIdx }
let teams = [];       // [{ id, name, color, label }]

// Snapshots for interpolation
let prevSnap = null;
let lastSnap = null;
let lastSnapAt = 0;
const pitLive = new Map(); 
const topSpeeds = Object.create(null); 

// caches
let grassPattern = null;
const carImgs  = new Map(); // key: lowercased teamId -> HTMLImageElement (overhead)
const sideImgs = new Map(); // key: lowercased teamId -> HTMLImageElement (side icon)
const _missingOnce = new Set();  // debug: which ids we couldn’t draw (logged once)
const CAR_ACROSS = geom?.carAcross ?? 60; // ADJUST CAR SIZE
let miniLBHits = []; // hit boxes for click -> modal

// RAF control
let rafStarted = false;
let ready = false;

// --- WebSocket ---
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.host}/?role=view`);

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'world') {
    world = msg.world || null;
    geom  = msg.geom  || null;
    teams = msg.teams || [];
    await preloadAssets();
    buildLeaderboardRows(); 
    resize();
    ready = true;
    if (!rafStarted) { rafStarted = true; requestAnimationFrame(frame); }
    return;
  }

  if (msg.type === 'snapshot') {
    prevSnap = lastSnap;
    lastSnap = msg.payload || null;
    lastSnapAt = performance.now();

    // ensure map exists
    if (!topSpeeds) Object.assign(topSpeeds, Object.create(null));
    const nowCars = msg.payload?.cars || [];
    for (const c of nowCars) {
      const k = String(c.id).toLowerCase();
      const vPxS = Number(c.v) * 1000 || 0;
      const simTop = Number(c.topSpeed) || 0;
      const best = Math.max(topSpeeds[k] || 0, vPxS, simTop);
      if (best > (topSpeeds[k] || 0)) topSpeeds[k] = best;
    } 

    if (lastSnap?.cars) {
      for (const c of lastSnap.cars) {
        const key = String(c.id).toLowerCase();

        // TOP SPEED (viewer-side, from incoming v)
        if (Number.isFinite(c.v)) {
          const pxPerSec = c.v * 1000;
          topSpeeds[key] = Math.max(topSpeeds[key] || 0, pxPerSec);
        }

        // PIT LIVE CLOCK
        if (c.pitState === 'servicing') {
          const rec = pitLive.get(key);
          const snapMs = Number(c.pitElapsedMs) || 0;

          if (!rec || rec.stateTag !== 'servicing') {
            // just entered service (or we didn't have state)
            pitLive.set(key, { baseMs: snapMs, startedAt: performance.now(), stateTag: 'servicing' });
          } else {
            // still servicing: if server progressed forward, sync base and restart local delta
            if (snapMs > rec.baseMs + 25) {            // tolerate tiny jitter
              rec.baseMs = snapMs;
              rec.startedAt = performance.now();
            }
          }
        } else {
          // not servicing anymore -> stop showing live timer
          pitLive.delete(key);
        }
      }
    }
    if (ready && !rafStarted) { rafStarted = true; requestAnimationFrame(frame); }
  }
};

// ===== Admin: drag-sort lineup (only when state === 'grid')
const ul       = document.getElementById('gridList');
const applyBtn = document.getElementById('applyGridBtn');

// drag-sort (safe if UL is not on the page)
let draggingLi = null;
ul?.addEventListener('dragstart', e => {
  draggingLi = e.target.closest('li'); draggingLi?.classList.add('dragging');
});
ul?.addEventListener('dragend', () => {
  draggingLi?.classList.remove('dragging'); draggingLi = null;
});
ul?.addEventListener('dragover', e => {
  if (!draggingLi) return;
  e.preventDefault();
  const li = e.target.closest('li'); if (!li || li === draggingLi) return;
  const r = li.getBoundingClientRect();
  ul.insertBefore(draggingLi, (e.clientY < r.top + r.height/2) ? li : li.nextSibling);
});

applyBtn?.addEventListener('click', ()=>{
  if (lastSnap?.state !== 'grid') return;
  const order = [...ul.querySelectorAll('li')].map(li => li.dataset.id);
  ws.send(JSON.stringify({ type:'grid-order', order }));
});

function raceDistanceView(c){
  // works even if startLineIndex/s is not in payload
  const L = geom.totalLen || 1;
  return (c.lap || 0) * L + ((c.s || 0) % L);
}

function renderGridList() {
  if (!ul || !teams?.length) return;             // ← guard
  ul.innerHTML = teams.map(t =>
    `<li draggable="true" data-id="${t.id}">${t.name}</li>`
  ).join('');
}
if (ul) renderGridList();

// --- Assets ---
async function preloadAssets() {
  try {
    const grass = new Image(); grass.src = GRASS_TILE; await grass.decode();
    grassPattern = ctx.createPattern(grass, 'repeat');
    if (grassPattern && grassPattern.setTransform && 'DOMMatrix' in window) {
      grassPattern.setTransform(new DOMMatrix());
    }
  } catch {}

  await Promise.all((teams || []).map(async t => {
    const key = String(t.id).toLowerCase();

    if (!carImgs.has(key)) {
      const top  = getImg(OVERHEAD(t.id));
      try { await top.decode(); } catch {}
      carImgs.set(key, top);
    }
    if (!sideImgs.has(key)) {
      const side = getImg(SIDE(t.id));
      try { await side.decode(); } catch {}
      sideImgs.set(key, side);
    }
  }));
}

// --- Canvas size ---
function resize(){
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const hud = document.querySelector('.hud');
  const hudH = hud ? Math.round(hud.getBoundingClientRect().height) : 0;

  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight - hudH;

  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width  = Math.round(w * DPR);
  canvas.height = Math.round(h * DPR);
}
window.addEventListener('resize', resize, { passive: true });

// ===== helpers (define BEFORE any usage) =====
const TAU = Math.PI * 2;
function lerp(a, b, t){ return a + (b - a) * t; }
function lerpAng(a, b, t){
  const d = ((b - a + Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
}

function sampleAtS(s) {
  if (!geom || !geom.centerline || !geom.centerline.length) {
    return { x: 0, y: 0, theta: 0, curv: 0, ksign: 1, i: 0 };
  }
  const cl = geom.centerline, totalLen = geom.totalLen || 1;
  s = (s % totalLen + totalLen) % totalLen;
  let lo = 0, hi = cl.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cl[mid].s < s) lo = mid + 1; else hi = mid; }
  const i1 = lo, i0 = (i1 - 1 + cl.length) % cl.length;
  const a = cl[i0], b = cl[i1];
  const t = (s - a.s) / Math.max(b.s - a.s, 1e-6);
  const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
  let th = a.theta + (b.theta - a.theta) * t;
  while (th - a.theta > Math.PI) th -= TAU;
  while (th - a.theta < -Math.PI) th += TAU;
  const curv = a.curv + (b.curv - a.curv) * t, ksign = Math.sign((b.ksign + a.ksign) / 2 || 1);
  return { x, y, theta: th, curv, ksign, i: i0 };
}

// --- Drawing ---
function drawCarSpriteAt(carId, x, y, theta){
  const key = String(carId).toLowerCase();
  const img = carImgs.get(key);
  const across = CAR_ACROSS;
  const h = across;
  const w = across * ((img?.naturalWidth || 2) / (img?.naturalHeight || 1));

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(theta);
  if (img && img.complete && img.naturalWidth > 0) {
    ctx.drawImage(img, -w/2, -h/2, w, h);
  } else {
    ctx.fillStyle = '#111a';
    ctx.beginPath(); ctx.arc(0,0, h*0.52, 0, TAU); ctx.fill();
  }
  ctx.restore();

  return {w, h}; // so callers may use sprite dims if they need them
}
function drawBackground() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = grassPattern || '#4a6a3f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
function setWorldScale() {
  if (!world || !world.width || !world.height) { ctx.setTransform(1,0,0,1,0,0); return; }
  const sx = canvas.width / world.width;
  const sy = canvas.height / world.height;
  ctx.setTransform(sx, 0, 0, sy, 0, 0);
}

function drawStartFinishChecker(ctx, sf, halfW, laneW = 28) {
  ctx.save();
  ctx.translate(sf.x, sf.y);
  ctx.rotate(sf.theta);

  // 4 vertical columns; width scales with lane width
  const cols  = 4;
  const colW  = Math.max(4, laneW * 0.22);     // world-units
  const totalW = cols * colW;

  const height = halfW * 0.92;                 // extend across the roadway
  const rows   = Math.max(14, Math.round((2 * height) / (colW * 0.9)));
  const cellH  = (2 * height) / rows;

  // subtle dark border behind the checkerboard
  ctx.fillStyle = '#0c0d10';
  ctx.fillRect(-totalW / 2 - 1, -height - 1, totalW + 2, 2 * height + 2);

  // checker pattern: alternate by (column + row)
  for (let c = 0; c < cols; c++) {
    const x0 = -totalW / 2 + c * colW;
    for (let r = 0; r < rows; r++) {
      const white = ((c + r) % 2) === 0;
      ctx.fillStyle = white ? '#fff' : '#000';
      ctx.fillRect(x0, -height + r * cellH, colW, cellH);
    }
  }

  ctx.restore();
}

function drawTrack(){
  if (!geom || !geom.leftPts || !geom.rightPts) return;
  setWorldScale();

  const L = geom.leftPts, R = geom.rightPts;

  // build ribbon once so we can fill and also clip safely
  const ribbon = new Path2D();
  ribbon.moveTo(L[0].x, L[0].y);
  for (let i=1;i<L.length;i++) ribbon.lineTo(L[i].x, L[i].y);
  for (let i=R.length-1;i>=0;i--) ribbon.lineTo(R[i].x, R[i].y);
  ribbon.closePath();

  // asphalt
  ctx.fillStyle = '#393B3E';
  ctx.fill(ribbon);

  // subtle darker centerline, clipped to asphalt
  if (geom.centerline?.length){
    ctx.save();
    ctx.clip(ribbon);
    ctx.lineWidth   = Math.max(14, (geom.LANE_W||28)*1.3);
    ctx.strokeStyle = 'rgba(20,20,22,0.20)';
    ctx.beginPath();
    const CL = geom.centerline;
    ctx.moveTo(CL[0].x, CL[0].y);
    for (let i=1;i<CL.length;i++) ctx.lineTo(CL[i].x, CL[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // edges
  ctx.lineWidth = 3; ctx.strokeStyle = '#e9edf2'; ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(L[0].x, L[0].y); for (let i=1;i<L.length;i++) ctx.lineTo(L[i].x, L[i].y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(R[0].x, R[0].y); for (let i=1;i<R.length;i++) ctx.lineTo(R[i].x, R[i].y); ctx.stroke();

  // pit + checker
  drawPitRoad();
  const idx = Number.isFinite(geom.startLineIndex) ? geom.startLineIndex : 0;
  const sf  = (geom.centerline || [])[idx] ?? {x:0,y:0,theta:0};
  drawStartFinishChecker(ctx, sf, geom.HALF_W_STRAIGHT || 180, geom.LANE_W || 28);
}

function drawPitRoad() {
  const cl = geom.centerline || [];
  const ids = geom.pitIds || [];
  if (!cl.length || !ids.length || geom.pitEntryIdx == null || geom.pitExitIdx == null) return;

  // dashed separator path (rebuild deterministically from geometry)
  const laneW = geom.LANE_W || 28;
  const insideEdge = geom.HALF_W_STRAIGHT || 180;
  const smooth = t => t * t * (3 - 2 * t);

  ctx.save();
  ctx.lineWidth = 4;
  ctx.setLineDash([12, 10]);
  ctx.strokeStyle = '#ffffff';

  ctx.beginPath();
  let started = false;
  for (let j = geom.pitEntryIdx; j <= geom.pitExitIdx; j++) {
    const idx = ids[j];
    const p = cl[idx];
    const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const t = (j - geom.pitEntryIdx) / Math.max(1, (geom.pitExitIdx - geom.pitEntryIdx));
    const wFactor = Math.min(
      smooth(Math.min(1, t / 0.12)),
      smooth(Math.min(1, (1 - t) / 0.12))
    );
    const sepOff = insideEdge - wFactor * laneW;  // offset from centerline
    const x = p.x + nx * sepOff, y = p.y + ny * sepOff;
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // entry / exit commit lines
  const entryCL = cl[ids[geom.pitEntryIdx]];
  const exitCL  = cl[ids[geom.pitExitIdx]];
  const markLen = (geom.HALF_W_STRAIGHT || 180) * 0.90;

  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffffff';

  let nx = -Math.sin(entryCL.theta), ny = Math.cos(entryCL.theta);
  ctx.beginPath();
  ctx.moveTo(entryCL.x - nx * markLen, entryCL.y - ny * markLen);
  ctx.lineTo(entryCL.x + nx * markLen, entryCL.y + ny * markLen);
  ctx.stroke();

  nx = -Math.sin(exitCL.theta); ny = Math.cos(exitCL.theta);
  ctx.beginPath();
  ctx.moveTo(exitCL.x - nx * markLen, exitCL.y - ny * markLen);
  ctx.lineTo(exitCL.x + nx * markLen, exitCL.y + ny * markLen);
  ctx.stroke();

  ctx.restore();
}

// seconds:centiseconds (ss:cc) for pit timer
function fmtCs(ms){
  const s  = Math.floor((ms||0)/1000);
  const cs = Math.floor(((ms||0)%1000)/10);
  return `${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
}
function teamById(id){
  const key = String(id).toLowerCase();
  return teams.find(t => String(t.id).toLowerCase() === key) || {};
}

// quick luminance to pick black/white text
function _luma(hex){
  const m = String(hex||'').replace('#','').match(/^([0-9a-f]{6})$/i);
  if(!m) return 0.5;
  const r=parseInt(m[1].slice(0,2),16)/255,
        g=parseInt(m[1].slice(2,4),16)/255,
        b=parseInt(m[1].slice(4,6),16)/255;
  return 0.2126*r + 0.7152*g + 0.0722*b;
}
function fillRoundRect(ctx, x,y,w,h,r){
  if (ctx.roundRect){ ctx.beginPath(); ctx.roundRect(x,y,w,h,r); ctx.fill(); return; }
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath(); ctx.fill();
}

// simple luminance to pick white/black text for a given HEX color
function textColorFor(bgHex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(bgHex||'').trim());
  if(!m) return '#111';
  const n = parseInt(m[1],16);
  const r = (n>>16)&255, g=(n>>8)&255, b=n&255;
  // perceived luminance
  const L = 0.2126*r + 0.7152*g + 0.0722*b;
  return L > 160 ? '#111' : '#fff';
}

// tiny rounded-rect helper (falls back if roundRect isn’t available)
function roundRect(ctx, x, y, w, h, r){
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x,y,w,h,r); return; }
  const rr = Math.min(r, Math.abs(w)/2, Math.abs(h)/2);
  ctx.beginPath();
  ctx.moveTo(x+rr,y);
  ctx.arcTo(x+w,y,x+w,y+h,rr);
  ctx.arcTo(x+w,y+h,x,y+h,rr);
  ctx.arcTo(x,y+h,x,y,rr);
  ctx.arcTo(x,y,x+w,y,rr);
}

// ----- grid helper (client-side fallback before green) -----
function gridPoseForIndex(i) {
  if (!geom || !geom.centerline || !geom.centerline.length) return { x: 0, y: 0, theta: 0 };
  const across = CAR_ACROSS;
  const rowGap = 2 * across;
  const lanes = [-(geom.LANE_W || 28) * 0.85, +(geom.LANE_W || 28) * 0.85];
  const startIdx = Number.isFinite(geom.startLineIndex) ? geom.startLineIndex : 0;
  const sHead = (geom.centerline[startIdx]?.s || 0) - 3.0 * across;

  const row = Math.floor(i / 2), col = i % 2;
  const sPos = (sHead - row * rowGap + (geom.totalLen || 1)) % (geom.totalLen || 1);
  const p = sampleAtS(sPos);
  const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);
  const lateral = lanes[col];
  return { x: p.x + nx * lateral, y: p.y + ny * lateral, theta: p.theta + Math.PI / 2 };
}

function drawCars(alpha = 1) {
  if (!geom) return;
  setWorldScale();

  // Only use grid when the server is explicitly in grid state
  const useGrid = !lastSnap || lastSnap.state === 'grid';
  
  if (useGrid) {
    const ids = (lastSnap.gridOrder?.length
      ? lastSnap.gridOrder
      : (teams || []).map(t => t.id));

    for (let i = 0; i < ids.length; i++) {
      const pose = gridPoseForIndex(i);
      drawCarSpriteAt(ids[i], pose.x, pose.y, pose.theta);
    }
    return;
  }

  if (!lastSnap) return;

  // z-sort by world y (pit poses) or sampled path y fallback
  const list  = Array.isArray(lastSnap.cars) ? lastSnap.cars : [];
  const carsZ = [...list].sort((a,b)=>{
    const ay = Number.isFinite(a.rY) ? a.rY : sampleAtS(a.s||0).y;
    const by = Number.isFinite(b.rY) ? b.rY : sampleAtS(b.s||0).y;
    return ay - by;
  });

  ctx.font = `${12*DPR}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  for (const a of carsZ) {
    const b = (prevSnap?.cars?.find(c=>c.id===a.id)) || a;

    // world pose (rx/ry/rTheta) during pit phases; else path-projected pose
    const haveWorldA = Number.isFinite(a.rx) && Number.isFinite(a.ry) && Number.isFinite(a.rTheta);
    const haveWorldB = Number.isFinite(b.rx) && Number.isFinite(b.ry) && Number.isFinite(b.rTheta);

    let x,y,theta;
    if (haveWorldA || haveWorldB) {
      const ax = haveWorldA ? a.rx : sampleAtS(a.s||0).x;
      const ay = haveWorldA ? a.ry : sampleAtS(a.s||0).y;
      const bx = haveWorldB ? b.rx : sampleAtS(b.s||0).x;
      const by = haveWorldB ? b.ry : sampleAtS(b.s||0).y;
      const at = haveWorldA ? a.rTheta : (sampleAtS(a.s||0).theta + Math.PI/2);
      const bt = haveWorldB ? b.rTheta : (sampleAtS(b.s||0).theta + Math.PI/2);

      x = lerp(bx, ax, alpha);
      y = lerp(by, ay, alpha);
      theta = lerpAng(bt, at, alpha);
    } else {
      const aS = Number.isFinite(a.s) ? a.s : (Number.isFinite(b.s) ? b.s : 0);
      const bS = Number.isFinite(b.s) ? b.s : aS;
      const s  = lerp(bS, aS, alpha);

      const aLat = Number.isFinite(a.lateral) ? a.lateral : 0;
      const bLat = Number.isFinite(b.lateral) ? b.lateral : aLat;
      const lateral = lerp(bLat, aLat, alpha);

      const p = sampleAtS(s);
      const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);
      x = p.x + nx * lateral;
      y = p.y + ny * lateral;
      theta = p.theta + Math.PI/2;
    }

    const { w:sw, h:sh } = drawCarSpriteAt(a.id, x, y, theta);

    // PIT TIMER overlay when servicing (use distinct vars to avoid shadowing)
    if (a.pitState === 'servicing') {
      const key = String(a.id).toLowerCase();
      const color = teamById(key).color || '#ffd400';

      const live = pitLive.get(key);
      let ms = Number(a.pitElapsedMs) || 0;
      if (live) ms = live.baseMs + (performance.now() - live.startedAt);

      const text = fmtCs(ms);

      const pad  = 6*DPR;
      const bh   = 16*DPR;           // badge height
      const bw   = ctx.measureText(text).width + pad*2;
      const bx   = x - bw/2;
      const by   = y - CAR_ACROSS*0.65 - bh;

      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = color;
      fillRoundRect(ctx, bx, by, bw, bh, 4*DPR);
      ctx.restore();

      ctx.fillStyle = _luma(color) > 0.6 ? '#111' : '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, by + bh/2 + 0.5*DPR);
    }
  }
}

/* ===== side-panel leaderboard (replaces on-canvas overlay) ===== */
function fmtLap(ms) {
  if (!isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
}
function fmtDelta(ms) {
  if (!isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `+${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const lbRowById = new Map();
let _lbLast = 0;

function buildLeaderboardRows() {
  if (!lbList) return;
  lbList.innerHTML = '';
  (teams || []).forEach(t => {
    const idKey = String(t.id).toLowerCase();
    const li  = document.createElement('li');
    li.className = 'lb-item';
    li.dataset.team = t.id;

    const pos = document.createElement('span');
    pos.className = 'lb-pos';

    // A flex cell that holds team name (left) and car image (right)
    const teamCell = document.createElement('div');
    teamCell.className = 'lb-teamCell';

    const name = document.createElement('span');
    name.className = 'lb-show';
    name.textContent = t.name;

    const carImg = document.createElement('img');
    carImg.className = 'lb-car';
    // src pulled from our cache; same object forever -> no network
    carImg.src = getImg(SIDE(t.id)).src;

    teamCell.appendChild(name);
    teamCell.appendChild(carImg);

    const lap = document.createElement('span');
    lap.className = 'lb-lap';

    li.appendChild(pos);
    li.appendChild(teamCell);
    li.appendChild(lap);

    lbList.appendChild(li);
    lbRowById.set(idKey, { li, pos, name, lap });
  });
}

const LB_ROWS = new Map();   // id -> {li, posEl, lapEl, teamEl, img}
function ensureLbRow(team){
  const k = String(team.id);
  let row = LB_ROWS.get(k);
  if (row) return row;

  const li = document.createElement('li');
  li.className = 'lb-item';
  li.dataset.team = team.id;

  const pos = document.createElement('span'); pos.className = 'lb-pos';
  const lap = document.createElement('span'); lap.className = 'lb-lap';
  const name= document.createElement('span'); name.className= 'lb-team';
  const img = document.createElement('img');  img.className  = 'lb-car';

  name.style.color = team.color || '#fff';
  img.alt = team.name;
  // IMPORTANT: set src ONCE; browser will cache; we never recreate this node
  img.src = SIDE(team.id);

  li.appendChild(pos);
  li.appendChild(lap);
  li.appendChild(name);
  li.appendChild(img);

  li.addEventListener('click', ()=> {
    // we rebuild the ORDER below each render; reuse that
    const order = [...(lastSnap.cars||[])].sort(
      (a,b)=> ((b.lap||0)+(b.s||0)/(geom.totalLen||1)) -
             ((a.lap||0)+(a.s||0)/(geom.totalLen||1))
    );
    fillModalForTeam(team.id, order);
  });

  LB_ROWS.set(k, {li, posEl:pos, lapEl:lap, teamEl:name, img});
  return LB_ROWS.get(k);
}

function renderLeaderboard(now){
  if (!lbList || !lastSnap || !geom) return;
  if (now - _lbLast < 250) return;
  _lbLast = now;

  const order = [...(lastSnap.cars||[])].sort(
    (a,b)=> ((b.lap||0)+(b.s||0)/(geom.totalLen||1)) -
           ((a.lap||0)+(a.s||0)/(geom.totalLen||1))
  );

  // Create missing rows once; update content; then reorder DOM without rebuilding
  for (const c of order) {
    const team = teams.find(t=>String(t.id)===String(c.id)) || { id:c.id, name:c.id, color:'#fff' };
    const row = ensureLbRow(team);
    row.posEl.textContent = String(order.indexOf(c)+1);
    row.lapEl.textContent = String(c.lap ?? 0);
    row.teamEl.textContent= team.name;
  }

  // Reorder DOM to match 'order' without replacing the <img> nodes
  const frag = document.createDocumentFragment();
  for (const c of order) {
    const t = teams.find(t=>String(t.id)===String(c.id)) || {id:c.id};
    const row = ensureLbRow(t);
    frag.appendChild(row.li);
  }
  lbList.appendChild(frag);
}

function paintKerbs(){
  if (!geom || !geom.centerline || !geom.leftPts || !geom.rightPts) return;
  const cl = geom.centerline;
  const L  = geom.leftPts;
  const R  = geom.rightPts;

  const KTH = 0.0053;      // curvature threshold for “corner”
  const STRIDE = 3;        // step along the centerline indices
  const kerbW = 10*DPR;    // width (toward track)
  const kerbL = 24*DPR;    // length along the edge

  for (let i=0; i<cl.length; i+=STRIDE){
    const p = cl[i];
    if (p.curv < KTH) continue;
    const edge = (p.ksign > 0) ? R[i] : L[i];
    if (!edge) continue;

    ctx.save();
    ctx.translate(edge.x, edge.y);
    ctx.rotate(p.theta);
    ctx.fillStyle = ((i/STRIDE)%2<1) ? '#d33' : '#fff';
    ctx.fillRect(-kerbL/2, -kerbW, kerbL, kerbW);
    ctx.restore();
  }
}

/* ===== Infield mini-leaderboard (panel style) ===== */
function drawMiniLeaderboardStyled(){
  if (!lastSnap || !geom) return;
  const order = [...(lastSnap.cars||[])].sort(
    (a,b)=> ((b.lap||0)+(b.s||0)/geom.totalLen) - ((a.lap||0)+(a.s||0)/geom.totalLen)
  );

  ctx.setTransform(1,0,0,1,0,0);

  const w = 300*DPR, rowH = 24*DPR, rows = order.length;
  const pad = 12*DPR, h = (rows+1)*rowH + pad*2;
  const x = canvas.width*0.22 - w/2, y = canvas.height*0.38 - h/2;

  ctx.fillStyle = 'rgba(14,16,20,0.62)';
  ctx.strokeStyle= 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 1;
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 10*DPR); ctx.fill(); ctx.stroke();

  const inset = 12*DPR; const px = x + inset; const py = y + inset;
  ctx.font = `${14*DPR}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText('P', px,               py);
  ctx.fillText('Lap', px + 25*DPR,    py);
  ctx.fillText('Team', px + 90*DPR,   py);

  miniLBHits = [];
  for (let i=0;i<rows;i++){
    const c   = order[i];
    const key = String(c.id).toLowerCase();
    const t   = teams.find(t=>String(t.id).toLowerCase()===key) || {name:c.id,color:'#fff'};
    const rowY= py + (i+1)*rowH;

    // row bg
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath(); roundRect(ctx, px-4*DPR, rowY-15*DPR, w-(px-x)-pad, 22*DPR, 16*DPR); ctx.fill();

    // P & Lap
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.fillText(String(i+1), px, rowY);
    ctx.fillText(String(c.lap ?? 0), px + 26*DPR, rowY);

    // Team (left)
    ctx.fillStyle = t.color || '#fff';
    ctx.textAlign = 'start';
    ctx.fillText(t.name, px + 110*DPR, rowY);

    // Car icon (right-aligned)
    const icon = sideImgs.get(key);
    if (icon && icon.complete){
      const ih = 15*DPR, iw = ih*(icon.naturalWidth/icon.naturalHeight);
      const right = x + w - pad - iw;
      ctx.save(); ctx.globalAlpha = 0.85;
      ctx.drawImage(icon, right, rowY - ih + 2*DPR, iw, ih);
      ctx.restore();
    }

    const hit = { x: px-4*DPR, y: rowY-16*DPR, w: w-(px-x)-pad, h: 18*DPR, id: key };
    miniLBHits.push(hit);
  }
}

canvas.addEventListener('click', (ev)=>{
  if (!miniLBHits.length || !lastSnap) return;
  const r   = canvas.getBoundingClientRect();
  const mx  = (ev.clientX - r.left) * (canvas.width  / r.width);
  const my  = (ev.clientY - r.top)  * (canvas.height / r.height);
  const hit = miniLBHits.find(h => mx>=h.x && mx<=h.x+h.w && my>=h.y && my<=h.y+h.h);
  if (!hit) return;
  // build the same order list we used to draw:
  const order = [ ...(lastSnap?.cars || []) ].sort(
    (a, b) =>
      ((b.lap || 0) + (b.s || 0) / (geom.totalLen || 1)) -
      ((a.lap || 0) + (a.s || 0) / (geom.totalLen || 1))
  );
  fillModalForTeam(hit.id, order);
});

// --- RAF loop ---
function frame(now) {
  drawBackground();
  if (world && geom) {
    drawTrack();
    drawCars(0.5);
    drawMiniLeaderboardStyled(); // infield mini leaderboard
    renderLeaderboard(now);      // keep side panel in sync (optional) 
  }
  requestAnimationFrame(frame);
}

// kick
resize();
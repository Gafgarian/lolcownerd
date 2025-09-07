// public/assets/js/admin.js
/* ====================== canvas boot ====================== */
const canvas = document.getElementById('racerCanvas');
const ctx = canvas.getContext('2d', { alpha:false });
ctx.imageSmoothingEnabled = true;

let world, geom, teams = [];
let simState   = { state:'grid', paused:true };
let lastSnap   = null;

/* grid editor state */
let gridDirty          = false;      // user is editing list; don't auto-rerender
let _renderedOrder     = [];         // last UL order we rendered
let localGridOrder     = null;       // what to draw on the track immediately
let pendingGridOrder   = null;       // order we've sent but not yet confirmed by server

/* ====================== WS ====================== */
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const token   = new URLSearchParams(location.search).get('token') || 'changeme';
const ws      = new WebSocket(`${wsProto}://${location.host}/?role=admin&token=${encodeURIComponent(token)}`, token);

/* ====================== assets (cached) ====================== */
const IMG_BASE  = "assets/images";
const OVERHEAD  = id => `${IMG_BASE}/cars/overhead/${id}.png`;
const SIDE      = id => `${IMG_BASE}/cars/side/${id}-side.png`;

const carImgs = new Map(); // key: `${id}::kind`
function getCarImg(id, kind='overhead'){
  const key = `${String(id).toLowerCase()}::${kind}`;
  let img = carImgs.get(key);
  if (!img){
    img = new Image();
    img.src = (kind === 'side' ? SIDE(id) : OVERHEAD(id));
    carImgs.set(key, img);
  }
  return img;
}
function drawCarSpriteAt(carId, x, y, theta){
  const img = getCarImg(carId, 'overhead');
  const h = CAR_ACROSS;
  const w = h * ((img?.naturalWidth || 2) / (img?.naturalHeight || 1));
  ctx.save(); ctx.translate(x,y); ctx.rotate(theta);
  if (img && img.complete && img.naturalWidth) ctx.drawImage(img, -w/2, -h/2, w, h);
  else { ctx.fillStyle='#111a'; ctx.beginPath(); ctx.arc(0,0,h*0.52,0,TAU); ctx.fill(); }
  ctx.restore();
}

const $ = (id)=>document.getElementById(id);
const arrEq = (a, b)=> Array.isArray(a) && Array.isArray(b) && a.length===b.length && a.every((v,i)=>String(v)===String(b[i]));

/* ====================== Parser connect (kept simple for now) ====================== */
let es = null;
function logAdmin(msg){
  const t = new Date().toLocaleTimeString();
  const log = $('adminLog'); if (!log) return;
  log.textContent += `[${t}] ${msg}\n`;
  log.scrollTop = log.scrollHeight;
}
function hookParserButtons(){
  const urlInp  = $('parserUrl');
  $('parserConnect')?.addEventListener('click', ()=>{
    const origin = (urlInp?.value || '').trim();
    if (!origin) return;
    try { es?.close(); } catch {}
    const base = origin.replace(/\/+$/, '');
    es = new EventSource(`${base}/events`);
    es.onopen    = ()=> logAdmin('Parser: connected');
    es.onerror   = ()=> logAdmin('Parser: error');
    es.onmessage = ev => { logAdmin(`Parser: ${ev.data}`); };
  });
  $('parserDisconnect')?.addEventListener('click', ()=>{
    try { es?.close(); } finally { es = null; }
    logAdmin('Parser: disconnected');
  });
}
document.addEventListener('DOMContentLoaded', hookParserButtons);

/* ====================== WS wiring ====================== */
ws.addEventListener('open', ()=> console.log('[admin] ws connected'));

ws.addEventListener('message', (ev)=>{
  const msg = JSON.parse(ev.data);

  if (msg.type === 'world') {
    teams = msg.teams || [];
    for (const t of (teams || [])) getCarImg(t.id, 'overhead'); // warm cache

    simState.state = 'grid';   // baseline until real state arrives
    initViewerScaffold(msg);
    updateButtons();

    const baseIds = (teams || []).map(t=>t.id);
    _renderedOrder = baseIds.slice();
    renderGridList(baseIds);

    secGrid.hidden = false;
    applyGridBtn.disabled = false;
  }

  if (msg.type === 'state') {
    simState = { state: msg.state, paused: !!msg.paused };
    updateButtons();

    const inGrid = simState.state === 'grid';
    secGrid.hidden = !inGrid;
    applyGridBtn.disabled = !inGrid;

    if (!inGrid) { localGridOrder = null; gridDirty = false; pendingGridOrder = null; }
  }

  if (msg.type === 'snapshot') {
    lastSnap = msg.payload || null;

    const snapOrder = lastSnap?.gridOrder?.length ? lastSnap.gridOrder.slice() : null;

    // If we have a pending order we sent, wait until the server echoes it back.
    if (pendingGridOrder) {
      if (snapOrder && arrEq(snapOrder, pendingGridOrder)) {
        // confirmed — hand control back to server
        localGridOrder    = snapOrder.slice();
        pendingGridOrder  = null;
        gridDirty         = false;
        if (simState.state === 'grid' && !arrEq(_renderedOrder, snapOrder)) {
          renderGridList(snapOrder);
        }
      } else {
        // keep drawing our local/pending order; don't touch the list
      }
    } else if (!gridDirty) {
      // not pending, not editing — follow the server
      localGridOrder = snapOrder;
      if (simState.state === 'grid') {
        const ids = snapOrder || (teams || []).map(t=>t.id);
        if (!arrEq(ids, _renderedOrder)) renderGridList(ids);
      }
    }

    const isGrid = (lastSnap?.state === 'grid') || (simState.state === 'grid');
    secGrid.hidden = !isGrid;
    applyGridBtn.disabled = !isGrid;
  }
});

/* ====================== Panel controls ====================== */
function sendCmd(name, payload={}) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type:'cmd', name, ...payload }));
}
function updateButtons(){
  const start = $('startBtn');
  if (start) {
    if (simState.state === 'green') { start.textContent = 'FINISH'; start.dataset.mode = 'finish'; }
    else                            { start.textContent = 'START';  start.dataset.mode = 'start';  }
  }
  const pause = $('pauseBtn');
  if (pause) {
    pause.textContent = simState.paused ? '▶︎' : '⏸';
    pause.title       = simState.paused ? 'Resume' : 'Pause';
  }
}
$('pauseBtn')?.addEventListener('click', ()=>{
  if (simState.state !== 'green') return;
  if (simState.paused) sendCmd('resume'); else sendCmd('pause');
});
$('startBtn')?.addEventListener('click', async ()=>{
  const mode = $('startBtn').dataset.mode || 'start';
  if (mode === 'start') {
    await runCountdown();
    sendCmd('start');
  } else {
    sendCmd('finish');
    openFinishModal();
  }
});

/* ====================== Grid editor ====================== */
const secGrid      = document.getElementById('adminGrid');
const gridList     = document.getElementById('gridList');
const applyGridBtn = document.getElementById('applyGridBtn');

function renderGridList(ids){
  if (!gridList) return;
  _renderedOrder = ids.slice();
  gridList.innerHTML = ids.map(id=>{
    const t = teams.find(x=>String(x.id)===String(id));
    return `<li draggable="true" data-id="${id}">${t?.name ?? id}</li>`;
  }).join('');
}
function currentListIds(){
  return [...gridList.querySelectorAll('li')].map(li => li.dataset.id);
}

// drag behaviour (no jump + persistent until Apply)
let draggingLi = null;
gridList?.addEventListener('dragstart', e=>{
  draggingLi = e.target.closest('li');
  draggingLi?.classList.add('dragging');
  e.dataTransfer?.setData('text/plain','x');
  gridDirty = true;
});
gridList?.addEventListener('dragover', e=>{
  if (!draggingLi) return; e.preventDefault();
  const li = e.target.closest('li'); if (!li || li===draggingLi) return;
  const r = li.getBoundingClientRect();
  const before = e.clientY < r.top + r.height/2;
  gridList.insertBefore(draggingLi, before ? li : li.nextSibling);
});
gridList?.addEventListener('drop', ()=>{
  localGridOrder = currentListIds(); // draw this order right away
});
gridList?.addEventListener('dragend', ()=>{
  draggingLi?.classList.remove('dragging'); draggingLi = null;
  localGridOrder = currentListIds();
});

// Apply: send and keep using local order until server confirms
applyGridBtn?.addEventListener('click', ()=>{
  if (simState.state !== 'grid'){ logAdmin('Grid is only editable before the start.'); return; }
  const order = currentListIds();
  localGridOrder   = order.slice();  // immediate visual feedback on track
  pendingGridOrder = order.slice();  // wait for echo
  ws.send(JSON.stringify({ type:'grid-order', order, token }));
  logAdmin(`Sent grid-order: [${order.join(', ')}]`);
  // stay in "dirty" mode so snapshots don't revert us until confirmed
  gridDirty = true;
});

/* ====================== Podium modal ====================== */
function openFinishModal(){
  const modal = $('finishModal'); if (!modal) return;

  const order = [...(lastSnap?.cars || [])].sort(
    (a,b)=> ((b.lap||0) + (b.s||0)/(geom?.totalLen||1)) - ((a.lap||0) + (a.s||0)/(geom?.totalLen||1))
  );
  const ids = [order[0]?.id, order[1]?.id, order[2]?.id].map(x => String(x||'').toLowerCase());
  const byId = k => teams.find(t => String(t.id).toLowerCase()===k) || { id:k, name:k };

  const t1 = byId(ids[0]), t2 = byId(ids[1]), t3 = byId(ids[2]);

  $('pod1').src = getCarImg(t1.id, 'side').src; $('lab1').textContent = t1.name;
  $('pod2').src = getCarImg(t2.id, 'side').src; $('lab2').textContent = t2.name;
  $('pod3').src = getCarImg(t3.id, 'side').src; $('lab3').textContent = t3.name;

  modal.classList.add('show'); modal.setAttribute('aria-hidden','false');
}
function closeFinishModal(){
  const modal = $('finishModal'); if (!modal) return;
  modal.classList.remove('show'); modal.setAttribute('aria-hidden','true');
}
$('finishModal')?.addEventListener('click', (e)=>{ if (e.target.dataset.close !== undefined) closeFinishModal(); });
$('resetRaceBtn')?.addEventListener('click', ()=>{
  sendCmd('grid');
  closeFinishModal();
});

/* ====================== Admin panel toggle ====================== */
const openAdmin  = document.getElementById('openAdminPanel');
const adminPanel = document.getElementById('adminPanel');

openAdmin?.addEventListener('click', ()=>{
  const open = !document.body.classList.contains('panel-open');
  document.body.classList.toggle('panel-open', open);
  adminPanel?.setAttribute('aria-hidden', String(!open));
  openAdmin.setAttribute('aria-expanded', String(open));
  openAdmin.setAttribute('aria-pressed', String(open));
});

/* ====================== Countdown ====================== */
function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function runCountdown(){
  const btn = $('startBtn');
  const cues   = ['●', '● ●', '● ● ●', 'GO!'];
  const colors = ['#d33','#d33','#ffb400','#19c523'];
  btn.disabled = true;
  for (let i=0;i<cues.length;i++){
    btn.textContent = cues[i]; btn.style.borderColor = colors[i]; btn.style.color = colors[i];
    await wait(650);
  }
  btn.style.borderColor = ''; btn.style.color = ''; btn.disabled = false;
  btn.textContent = 'FINISH'; btn.dataset.mode = 'finish';
}

/* ====================== mini viewer ====================== */
let rafStarted=false;
const DPR = Math.min(2, window.devicePixelRatio || 1);

function initViewerScaffold({ world: w, geom: g, teams: t }) {
  world=w; geom=g; teams=t||teams;
  resize();
  if (!rafStarted) { rafStarted = true; requestAnimationFrame(frame); }
  window.addEventListener('resize', resize, {passive:true});
}
function resize(){
  const hud = document.querySelector('.hud');
  const hudH = hud ? Math.round(hud.getBoundingClientRect().height) : 0;
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight - hudH;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width  = Math.round(w * DPR);
  canvas.height = Math.round(h * DPR);
}
function setWorldScale(){ const sx = canvas.width/world.width, sy = canvas.height/world.height; ctx.setTransform(sx,0,0,sy,0,0); }

/* ---------- track rendering ---------- */
function drawTrack(){
  if (!geom || !geom.leftPts || !geom.rightPts) return;
  setWorldScale();

  const L = geom.leftPts, R = geom.rightPts;

  const ribbon = new Path2D();
  ribbon.moveTo(L[0].x, L[0].y);
  for (let i=1;i<L.length;i++) ribbon.lineTo(L[i].x, L[i].y);
  for (let i=R.length-1;i>=0;i--) ribbon.lineTo(R[i].x, R[i].y);
  ribbon.closePath();

  ctx.fillStyle = '#393B3E';
  ctx.fill(ribbon);

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

  ctx.lineWidth = 3; ctx.strokeStyle = '#e9edf2'; ctx.lineJoin='round'; ctx.lineCap='round';
  ctx.beginPath(); ctx.moveTo(L[0].x, L[0].y); for (let i=1;i<L.length;i++) ctx.lineTo(L[i].x, L[i].y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(R[0].x, R[0].y); for (let i=1;i<R.length;i++) ctx.lineTo(R[i].x, R[i].y); ctx.stroke();

  drawPitRoad();
  const idx = Number.isFinite(geom.startLineIndex) ? geom.startLineIndex : 0;
  const sf  = (geom.centerline || [])[idx] ?? {x:0,y:0,theta:0};
  drawStartFinishChecker(ctx, sf, geom.HALF_W_STRAIGHT || 180, geom.LANE_W || 28);
}
function drawPitRoad(){
  const cl = geom.centerline || [];
  const ids = geom.pitIds || [];
  if (!cl.length || !ids.length) return;

  const smooth = t => t*t*(3-2*t);
  ctx.save(); ctx.lineWidth=4; ctx.setLineDash([12,10]); ctx.strokeStyle='#ffffff';
  ctx.beginPath();
  let started=false;
  for (let j=geom.pitEntryIdx; j<=geom.pitExitIdx; j++){
    const idx=ids[j], p=cl[idx], nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
    const t=(j-geom.pitEntryIdx)/Math.max(1,(geom.pitExitIdx-geom.pitEntryIdx));
    const sepOff = (geom.HALF_W_STRAIGHT||180) - smooth(Math.min(1,Math.min(t,1-t)/0.12))*(geom.LANE_W||28);
    const x=p.x+nx*sepOff, y=p.y+ny*sepOff;
    if(!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
  }
  ctx.stroke(); ctx.restore();

  const markLen = (geom.HALF_W_STRAIGHT||180) * 0.90;
  const entryCL = cl[ids[geom.pitEntryIdx]], exitCL = cl[ids[geom.pitExitIdx]];
  ctx.save(); ctx.lineWidth=3; ctx.strokeStyle='#ffffff';
  let nx=-Math.sin(entryCL.theta), ny=Math.cos(entryCL.theta);
  ctx.beginPath(); ctx.moveTo(entryCL.x-nx*markLen, entryCL.y-ny*markLen);
  ctx.lineTo(entryCL.x+nx*markLen, entryCL.y+ny*markLen); ctx.stroke();
  nx=-Math.sin(exitCL.theta); ny=Math.cos(exitCL.theta);
  ctx.beginPath(); ctx.moveTo(exitCL.x-nx*markLen, exitCL.y-ny*markLen);
  ctx.lineTo(exitCL.x+nx*markLen, exitCL.y+ny*markLen); ctx.stroke();
  ctx.restore();
}
function drawStartFinishChecker(ctx, sf, halfW, laneW = 28) {
  const p = sf || {x:0,y:0,theta:0}; if (!p) return;
  ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.theta);
  const cols=4, colW=Math.max(4,laneW*0.22), totalW=cols*colW;
  const height=halfW*0.92, rows=Math.max(14, Math.round((2*height)/(colW*0.9)));
  const cellH=(2*height)/rows;
  ctx.fillStyle='#0c0d10';
  ctx.fillRect(-totalW/2-1, -height-1, totalW+2, 2*height+2);
  for (let c=0;c<cols;c++){
    const x0=-totalW/2 + c*colW;
    for (let r=0;r<rows;r++){
      ctx.fillStyle = ((c+r)%2===0) ? '#fff' : '#000';
      ctx.fillRect(x0, -height + r*cellH, colW, cellH);
    }
  }
  ctx.restore();
}

/* ---------- grid helpers ---------- */
const TAU = Math.PI*2;
const CAR_ACROSS = 60;

function sampleAtS(s){
  if (!geom?.centerline?.length) return {x:0,y:0,theta:0,i:0};
  const cl=geom.centerline, L=geom.totalLen||1;
  s = (s%L+L)%L;
  let lo=0, hi=cl.length-1;
  while (lo<hi){ const mid=(lo+hi)>>1; if (cl[mid].s < s) lo=mid+1; else hi=mid; }
  const i1=lo, i0=(i1-1+cl.length)%cl.length;
  const a=cl[i0], b=cl[i1], t=(s-a.s)/Math.max(b.s-a.s,1e-6);
  const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
  let th=a.theta+(b.theta-a.theta)*t;
  while (th-a.theta>Math.PI) th-=TAU;
  while (th-a.theta<-Math.PI) th+=TAU;
  return {x,y,theta:th,i:i0};
}
function gridPoseForIndex(i){
  if (!geom?.centerline?.length) return {x:0,y:0,theta:0};
  const across=CAR_ACROSS, rowGap=2*across;
  const lanes=[-(geom.LANE_W||28)*0.85, +(geom.LANE_W||28)*0.85];
  const startIdx = Number.isFinite(geom.startLineIndex) ? geom.startLineIndex : 0;
  const sHead = (geom.centerline[startIdx]?.s || 0) - 3.1*across;
  const row=Math.floor(i/2), col=i%2;
  const sPos = (sHead - row*rowGap + (geom.totalLen||1)) % (geom.totalLen||1);
  const p = sampleAtS(sPos);
  const nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
  const lateral = lanes[col];
  return { x:p.x + nx*lateral, y:p.y + ny*lateral, theta:p.theta + Math.PI/2 };
}

/* ---------- overlay + RAF ---------- */
function fmtLap(ms){ if(!isFinite(ms)) return '—'; const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000), cs=Math.floor((ms%1000)/10); return `${m}:${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`; }
function fmtDelta(ms){ if(!isFinite(ms)) return '—'; const s=Math.floor(ms/1000), cs=Math.floor((ms%1000)/10); return `+${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`; }

function drawOverlay(){
  if(!lastSnap || !geom) return;
  ctx.setTransform(1,0,0,1,0,0);
  const x = canvas.width*0.14, y = canvas.height*0.22;
  const w = 260*DPR, h = 220*DPR;
  ctx.fillStyle='rgba(14,16,20,0.78)'; ctx.strokeStyle='rgba(255,255,255,0.10)';
  ctx.beginPath(); ctx.moveTo(x+10,y); ctx.arcTo(x+w,y, x+w,y+h, 10*DPR);
  ctx.arcTo(x+w,y+h, x,y+h, 10*DPR); ctx.arcTo(x,y+h, x,y, 10*DPR); ctx.arcTo(x,y, x+w,y, 10*DPR); ctx.closePath();
  ctx.fill(); ctx.stroke();

  const px=x+10*DPR, py=y+9*DPR, lh=16*DPR;
  ctx.font = `${11*DPR}px Inter, system-ui, sans-serif`;
  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.fillText('P', px, py); ctx.fillText('Lap', px+18*DPR, py); ctx.fillText('Team', px+54*DPR, py); ctx.fillText('Time', x+w-62*DPR, py);

  const order=[...(lastSnap?.cars || [])].sort((a,b)=> ((b.lap||0)+(b.s||0)/(geom.totalLen||1)) - ((a.lap||0)+(a.s||0)/(geom.totalLen||1)));
  const lead = order[0]; const leadTime = lead?.lastLapMs ?? Infinity;

  for(let i=0;i<Math.min(order.length, 12);i++){
    const c=order[i];
    const t=teams.find(t=>t.id===c.id) || {name:c.id};
    const rowY=py+(i+1)*lh+5*DPR;
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.fillText(String(i+1), px, rowY);
    ctx.fillText(String(c.lap ?? 0), px+18*DPR, rowY);
    ctx.fillText(t.name, px+60*DPR, rowY);
    const txt = (i===0 && Number.isFinite(c.lastLapMs))
      ? fmtLap(c.lastLapMs)
      : fmtDelta((c.lastLapMs??Infinity)-leadTime);
    const tw = ctx.measureText(txt).width;
    ctx.fillText(txt, x + w - 10*DPR - tw, rowY);
  }
}

function frame(){
  if (!world || !geom){ requestAnimationFrame(frame); return; }
  ctx.setTransform(1,0,0,1,0,0);
  ctx.fillStyle='#3f5f39'; ctx.fillRect(0,0,canvas.width,canvas.height);

  drawTrack();

  // Draw grid cars strictly while we're in grid
  if ((lastSnap?.state || simState.state) === 'grid' && teams.length){
    setWorldScale();
    const order = (localGridOrder && localGridOrder.length)
      ? localGridOrder
      : (lastSnap?.gridOrder?.length ? lastSnap.gridOrder : teams.map(t=>t.id));
    for (let i=0;i<order.length;i++){
      const p = gridPoseForIndex(i);
      drawCarSpriteAt(order[i], p.x, p.y, p.theta);
    }
  }

  drawOverlay();
  requestAnimationFrame(frame);
}
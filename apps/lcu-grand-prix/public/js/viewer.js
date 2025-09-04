// Renders server snapshots; NO physics here.
const canvas = document.getElementById('racerCanvas');
const ctx = canvas.getContext('2d', { alpha:false });
ctx.imageSmoothingEnabled = true;

const DPR = Math.min(2, window.devicePixelRatio || 1);

// Assets
const IMG_BASE = "assets/images";
const OVERHEAD = id => `${IMG_BASE}/cars/overhead/${id}.png`;
const GRASS_TILE = `${IMG_BASE}/other/grassBg.png`;

let world, geom, teams;
let grassPattern = null;

// Snapshots for interpolation
let prevSnap = null, lastSnap = null;

const carImgs = new Map(); // id -> HTMLImageElement

// Connect
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${wsProto}://${location.host}/?role=view`);
ws.onmessage = async (ev)=>{
  const msg = JSON.parse(ev.data);
  if (msg.type === 'world') {
    ({ world, geom, teams } = msg);
    await preload();
    resize();
  } else if (msg.type === 'snapshot') {
    prevSnap = lastSnap;
    lastSnap = msg.payload;
  }
};

// Preload
async function preload(){
  try {
    const grass = new Image(); grass.src = GRASS_TILE; await grass.decode();
    grassPattern = ctx.createPattern(grass, 'repeat');
    if (grassPattern && grassPattern.setTransform && 'DOMMatrix' in window) {
      grassPattern.setTransform(new DOMMatrix());
    }
  } catch {}
  await Promise.all(teams.map(async t=>{
    const img = new Image(); img.src = OVERHEAD(t.id); await img.decode(); carImgs.set(t.id, img);
  }));
}

function resize(){
  const hud = document.querySelector('.hud');
  const hudH = hud ? hud.getBoundingClientRect().height : 56;
  const w = Math.max(720, window.innerWidth-16);
  const h = Math.max(500, window.innerHeight - hudH - 16);
  canvas.style.width  = `${w}px`; canvas.style.height = `${h}px`;
  canvas.width  = Math.round(w*DPR); canvas.height = Math.round(h*DPR);
}
window.addEventListener('resize', resize, { passive:true });

// Utilities
const TAU = Math.PI*2;
const lerp = (a,b,t)=>a+(b-a)*t;

function sampleAtS(s){
  const cl = geom.centerline, totalLen = geom.totalLen;
  s=(s%totalLen + totalLen)%totalLen;
  let lo=0, hi=cl.length-1;
  while(lo<hi){ const mid=(lo+hi)>>1; if(cl[mid].s < s) lo=mid+1; else hi=mid; }
  const i1=lo, i0=(i1-1+cl.length)%cl.length;
  const a=cl[i0], b=cl[i1];
  const t=(s-a.s)/Math.max(b.s-a.s,1e-6);
  const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
  let th=a.theta+(b.theta-a.theta)*t; while(th-a.theta>Math.PI) th-=TAU; while(th-a.theta<-Math.PI) th+=TAU;
  const curv=a.curv+(b.curv-a.curv)*t, ksign=Math.sign((b.ksign+a.ksign)/2 || 1);
  return {x,y,theta:th,curv,ksign,i:i0};
}

// Drawing
function drawBackground(){
  if (grassPattern) {
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = grassPattern;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  } else {
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = '#4a6a3f';
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }
}

function setWorldScale(){
  const sx = canvas.width  / world.width;
  const sy = canvas.height / world.height;
  ctx.setTransform(sx,0,0,sy,0,0);
}

function drawTrack(){
  setWorldScale();
  // asphalt fill
  ctx.fillStyle = '#393B3E';
  ctx.beginPath();
  const L = geom.leftPts, R = geom.rightPts;
  ctx.moveTo(L[0].x, L[0].y);
  for (let i=1;i<L.length;i++) ctx.lineTo(L[i].x, L[i].y);
  for (let i=R.length-1;i>=0;i--) ctx.lineTo(R[i].x, R[i].y);
  ctx.closePath();
  ctx.fill();

  // edges
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#e9edf2';
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  ctx.beginPath(); ctx.moveTo(L[0].x,L[0].y); for(let i=1;i<L.length;i++) ctx.lineTo(L[i].x,L[i].y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(R[0].x,R[0].y); for(let i=1;i<R.length;i++) ctx.lineTo(R[i].x,R[i].y); ctx.stroke();

  // start/finish short checker
  const sf = geom.centerline[geom.startLineIndex ?? geom.startLineIndex || 0] || geom.centerline[0];
  ctx.save(); ctx.translate(sf.x, sf.y); ctx.rotate(sf.theta);
  const w=8, h = (geom.HALF_W_STRAIGHT || 180) * 0.92;
  ctx.fillStyle = '#0c0d10'; ctx.fillRect(-w/2, -h, w, 2*h);
  const cells=18, cellH=(2*h)/cells;
  for(let i=0;i<cells;i++){ ctx.fillStyle = (i%2 ? '#fff' : '#000'); ctx.fillRect(-w/2, -h + i*cellH, w, cellH); }
  ctx.restore();
}

function drawCars(alpha=1){
  if (!lastSnap) return;
  setWorldScale();

  // z-sort by y to keep simple overlap
  const cars = [...lastSnap.cars].sort((a,b)=> {
    const pa = sampleAtS(a.s), pb = sampleAtS(b.s);
    return (pa.y - pb.y);
  });

  for (const a of cars){
    const b = (prevSnap && prevSnap.cars.find(c=>c.id===a.id)) || a;
    const s = lerp(b.s, a.s, alpha);
    const pos = sampleAtS(s);
    const nx = -Math.sin(pos.theta), ny = Math.cos(pos.theta);
    const lateral = lerp(b.lateral ?? 0, a.lateral ?? 0, alpha);
    const x = pos.x + nx*lateral, y = pos.y + ny*lateral;

    const img = carImgs.get(a.id);
    if (!img) continue;
    const across = 56*1.3;
    const h = across, w = across*(img.naturalWidth/img.naturalHeight);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(pos.theta + Math.PI/2);
    ctx.drawImage(img, -w/2, -h/2, w, h);
    ctx.restore();
  }
}

function fmtLap(ms){
  if (!isFinite(ms)) return '—';
  const m = Math.floor(ms/60000);
  const s = Math.floor((ms%60000)/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${m}:${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
}
function fmtDelta(ms){
  if (!isFinite(ms)) return '—';
  const s  = Math.floor(ms/1000);
  const cs = Math.floor((ms%1000)/10);
  return `+${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function drawOverlay(){
  if (!lastSnap) return;
  // UI space (device pixels)
  ctx.setTransform(1,0,0,1,0,0);
  const x = canvas.width*0.14, y = canvas.height*0.22;
  const w = 300*DPR, h = 260*DPR;

  // panel
  ctx.fillStyle = 'rgba(14,16,20,0.78)';
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  roundRect(ctx, x, y, w, h, 10*DPR);
  ctx.fill(); ctx.stroke();

  // headers
  const px = x + 12*DPR, py = y + 10*DPR, lh = 18*DPR;
  ctx.font = `${12*DPR}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText('P', px, py);
  ctx.fillText('Lap', px + 22*DPR, py);
  ctx.fillText('Team', px + 62*DPR, py);
  ctx.fillText('Time', px + w - 68*DPR, py);

  // order and times (use last lap from snapshot)
  const byDist = [...lastSnap.cars].sort((a,b)=> ((b.lap||0)+(b.s||0)/geom.totalLen) - ((a.lap||0)+(a.s||0)/geom.totalLen));
  const lead = byDist[0];
  const leadTime = lead?.lastLapMs ?? Infinity;

  for (let i=0;i<byDist.length;i++){
    const c = byDist[i];
    const team = teams.find(t=>t.id===c.id) || {name:c.id, color:'#fff', label:{bg:'#111', fg:'#fff'}};
    const rowY = py + (i+1)*lh + 6*DPR;
    ctx.fillStyle='rgba(255,255,255,0.95)';
    ctx.fillText(String(i+1), px, rowY);
    ctx.fillText(String(c.lap ?? 0), px + 22*DPR, rowY);
    ctx.fillText(team.name, px + 72*DPR, rowY);
    const txt = (i===0 && isFinite(c.lastLapMs)) ? fmtLap(c.lastLapMs) : fmtDelta((c.lastLapMs ?? Infinity) - leadTime);
    const tw = ctx.measureText(txt).width;
    ctx.fillText(txt, x + w - 12*DPR - tw, rowY);
  }

  // Half-split panel stub (right of main panel)
  const sx = x + w + 10*DPR, sy = y;
  const sw = 200*DPR, sh = 220*DPR;
  roundRect(ctx, sx, sy, sw, sh, 10*DPR);
  ctx.fillStyle = 'rgba(14,16,20,0.78)'; ctx.fill();
  ctx.stroke();

  ctx.fillStyle='rgba(255,255,255,0.9)';
  ctx.fillText(`Half ${lastSnap.halfLapNumber}`, sx + 12*DPR, sy + 10*DPR);

  const entries = Object.entries(lastSnap.halfGaps || {}).sort((a,b)=> (a[1]-b[1]));
  for (let i=0;i<Math.min(entries.length, 10); i++){
    const [id, gap] = entries[i];
    const t = teams.find(t=>t.id===id) || { name:id };
    ctx.fillText(i===0 ? t.name : `${t.name}  ${fmtDelta(gap)}`, sx + 12*DPR, sy + (i+2)*lh);
  }
}

function roundRect(ctx, x, y, w, h, r){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
}

function frame(){
  drawBackground();
  drawTrack();
  drawCars(0.5);
  drawOverlay();
  requestAnimationFrame(frame);
}
frame();
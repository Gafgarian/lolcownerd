/* LCU Grand Prix – config-driven stats + endurance/pit refresh + pit crew timing + 3-wide */

const IMG_BASE = "assets/images";
const OVERHEAD = id => `${IMG_BASE}/cars/overhead/${id}.png`;
const SIDE     = id => `${IMG_BASE}/cars/side/${id}-side.png`;
const GRASS_TILE = `${IMG_BASE}/other/grassBg.png`;
const CARS_JSON  = "assets/config/cars.json";

const SPRITE_HEADING_OFFSET = Math.PI / 2;

/* visual identity only; driving stats from cars.json */
const TEAMS = [
  { id:'cafe',     name:'Cafe',     color:'#ffce9e', label:{ bg:'#3b2f2f', fg:'#ffce9e' } },
  { id:'reaper',   name:'Reapers',  color:'#76ff03', label:{ bg:'#2a2a2a', fg:'#76ff03' } },
  { id:'test',     name:'Test',     color:'#ffd600', label:{ bg:'#ffd600', fg:'#111' } },
  { id:'nerd',     name:'Nerds',    color:'#c2afff', label:{ bg:'#7a2b86', fg:'#c2afff' } },
  { id:'queens',   name:'Queens',   color:'#ff5aa5', label:{ bg:'#d4af37', fg:'#ff5aa5' } },
  { id:'live',     name:'Live',     color:'#1e88e5', label:{ bg:'#e53935', fg:'#1e88e5' } },
  { id:'shortbus', name:'ShortBus', color:'#9be7ff', label:{ bg:'#2e7d32', fg:'#9be7ff' } },
  { id:'rewind',   name:'Rewind',   color:'#ef5350', label:{ bg:'#111',    fg:'#ef5350' } },
  { id:'balls',    name:'Balls',    color:'#ff5aa5', label:{ bg:'#ff5aa5', fg:'#111' } },
  { id:'aussy',    name:'Aussy',    color:'#ffd180', label:{ bg:'#5a3d2b', fg:'#ffd180' } },
  { id:'chubby',   name:'Chubby',   color:'#ff5aa5', label:{ bg:'#1e88e5', fg:'#ff5aa5' } },
  { id:'nuts',     name:'Nuts',     color:'#ffcc80', label:{ bg:'#8e24aa', fg:'#ffcc80' } },
];

/* ====== DOM ====== */
const canvas = document.getElementById('racerCanvas');
const ctx = canvas.getContext('2d', { alpha:false });
ctx.imageSmoothingEnabled = true;
const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

const toggleBtn = document.getElementById('togglePanel');
const sidePanel = document.getElementById('sidePanel');
toggleBtn.addEventListener('click', () => {
  const open = document.body.classList.toggle('panel-open');
  sidePanel.setAttribute('aria-hidden', String(!open));
  toggleBtn.setAttribute('aria-expanded', String(open));
});

let raceState = 'grid'; // 'grid' | 'countdown' | 'green' | 'finished'
const hud = document.querySelector('.hud');

// center START/FINISH button
const startBtn = document.createElement('button');
startBtn.className = 'icon-btn';
startBtn.id = 'startBtn';
startBtn.textContent = 'START';
hud.insertBefore(startBtn, document.querySelector('.hud-spacer')); // middle area

// small pause button (hidden until we go green)
const tinyPause = document.createElement('button');
tinyPause.className = 'icon-btn';
tinyPause.id = 'tinyPauseBtn';
tinyPause.style.marginLeft = '8px';
tinyPause.style.display = 'none';
tinyPause.textContent = 'Pause';
hud.insertBefore(tinyPause, document.querySelector('.hud-right'));

/* ====== Modal ====== */
const modal = document.getElementById('carModal');
const modalImgSide = document.getElementById('modalSideImg');
const modalImgTop  = document.getElementById('modalTopImg');
const modalTitle   = document.getElementById('carModalTitle');
const modalPos     = document.getElementById('modalPos');
const modalLap     = document.getElementById('modalLap');
const modalSpd     = document.getElementById('modalSpd');
const modalBoost   = document.getElementById('modalBoost');
const modalStatGrid= document.getElementById('modalStatGrid');

let currentModalCar = null;
let modalExtra = null; // {fastLapEl, fastPitEl}
modal.addEventListener('click', (e)=>{ if (e.target.dataset.close !== undefined) hideModal(); });
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') hideModal(); });
function showModal(){ modal.classList.add('show'); modal.setAttribute('aria-hidden','false'); }
function hideModal(){ modal.classList.remove('show'); modal.setAttribute('aria-hidden','true'); currentModalCar=null; }

/* ====== Utils ====== */
const clamp=(v,min,max)=>v<min?min:v>max?max:v;
const TAU=Math.PI*2;
function loadImage(src){
  return new Promise((res, rej) => {
    const img=new Image();
    img.onload=()=>res(img);
    img.onerror=()=>rej(new Error(`Failed to load image: ${src}`));
    img.src=src;
  });
}
const fmtCs = ms => {
  const s = Math.floor(ms/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};
const fmtLap = ms => {
  const m = Math.floor(ms/60000);
  const s = Math.floor((ms%60000)/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${m}:${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};

/* ====== Pre-rotated sprite cache ====== */
const rotCache=new Map();
function getRotatedSprite(img, angle, across, aspect, quant=48){
  angle=(angle%TAU+TAU)%TAU;
  const idx=Math.round(angle/TAU*quant)%quant;

  const baseH=Math.round(across);
  const baseW=Math.round(across*aspect);
  const diag = Math.ceil(Math.hypot(baseW, baseH));

  let entry=rotCache.get(img);
  if(!entry || entry.quant!==quant || entry.baseW!==baseW || entry.baseH!==baseH || entry.diag!==diag){
    entry={quant, baseW, baseH, diag, canvases:new Array(quant)};
    rotCache.set(img, entry);
  }
  if(!entry.canvases[idx]){
    const c=('OffscreenCanvas'in window)
      ? new OffscreenCanvas(entry.diag, entry.diag)
      : Object.assign(document.createElement('canvas'), {width: entry.diag, height: entry.diag});
    const g=c.getContext('2d');
    g.imageSmoothingEnabled=true;
    g.translate(entry.diag/2, entry.diag/2);
    g.rotate(idx*TAU/quant);
    g.drawImage(img, -entry.baseW/2, -entry.baseH/2, entry.baseW, entry.baseH);
    entry.canvases[idx]=c;
  }
  return entry.canvases[idx];
}

/* ====== Track (reverted to stable control points) ====== */
const CTRL_BASE = [
  /* Top */
  [0.1,0.1],[0.2,0.1],[0.3,0.1],
  [0.4,0.15],[0.45,0.2],[0.5,0.22],[0.55,0.2],[0.6,0.15],
  [0.7,0.1],[0.8,0.1],[0.9,0.15],

  /* Right */
  [0.92,0.2],[0.9,0.25],
  [0.86,0.29],[0.78,0.33],[0.4,0.41],
  [0.5,0.66],[0.78,0.5],[0.85,0.65],
  [0.9,0.76],

  /* Bottom */
  [0.85,0.85],[0.78,0.85],[0.75,0.85],[0.7,0.85],
  [0.65,0.85],[0.6,0.85],[0.55,0.85],[0.5,0.85],[0.45,0.85],
  [0.4,0.85],[0.35,0.85],[0.3,0.85],[0.25,0.85],[0.23,0.85],
  [0.17,0.85],

  /* Left */
  [0.11,0.8],[0.1,0.75],[0.1,0.7],
  [0.1,0.6],[0.1,0.5],[0.1,0.4],
  [0.1,0.3],[0.1,0.28],[0.1,0.23],
  [0.1,0.12],[0.2,0.1],[0.3,0.1],
];

let centerline=[], totalLen=1;
let leftPts=[], rightPts=[];
let asphaltPath=null;
let LANE_W=28, HALF_W_NORMAL=1, HALF_W_STRAIGHT=1;
let grassPattern=null;

/* pit geometry + helpers */
let startLineIndex = 0;
let startLineS = 0;

function sizeCanvas(){
  const hud=document.querySelector('.hud');
  const hudH=hud?hud.getBoundingClientRect().height:56;
  const w=Math.max(720, window.innerWidth-16);
  const h=Math.max(500, window.innerHeight-hudH-16);

  canvas.style.width=`${w}px`; canvas.style.height=`${h}px`;
  canvas.width=Math.round(w*DPR); canvas.height=Math.round(h*DPR);

  LANE_W=Math.max(28*DPR, canvas.width*0.024);

  const WIDEN = 1.30;
  HALF_W_NORMAL=1.25*LANE_W*WIDEN;
  HALF_W_STRAIGHT=2.00*LANE_W*WIDEN;

  buildTrack();
}
window.addEventListener('resize', sizeCanvas, {passive:true});

function catmullRom(p0,p1,p2,p3,t){
  const t2=t*t,t3=t2*t;
  return [
    0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
    0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
  ];
}
function catmullRomTangent(p0,p1,p2,p3,t){
  const t2=t*t;
  return [
    0.5*((-p0[0]+p2[0])+2*(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t+3*(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t2),
    0.5*((-p0[1]+p2[1])+2*(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t+3*(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t2),
  ];
}
function normToPx(pts,W,H){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [x,y] of pts){ if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; }
  const bw=maxX-minX, bh=maxY-minY, margin=0.07;
  const S=Math.min((1-2*margin)/bw,(1-2*margin)/bh);
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  return pts.map(([x,y])=>[(x-cx)*S*W + W/2, (y-cy)*S*H + H/2]);
}

const STRAIGHT_THRESH=0.0010;
let straightRange={start:0,end:0};

function buildTrack(){
  const CTRL=normToPx(CTRL_BASE, canvas.width, canvas.height);

  const samples=[];
  for(let i=0;i<CTRL.length-3;i++){
    const p0=CTRL[i], p1=CTRL[i+1], p2=CTRL[i+2], p3=CTRL[i+3];
    const steps=56;
    for(let j=0;j<steps;j++){
      const t=j/steps;
      const [x,y]=catmullRom(p0,p1,p2,p3,t);
      const [tx,ty]=catmullRomTangent(p0,p1,p2,p3,t);
      samples.push({x,y,theta:Math.atan2(ty,tx)});
    }
  }
  samples.push({...samples[0]});

  centerline=[]; let s=0;
  for(let i=0;i<samples.length;i++){
    const a=samples[i], b=samples[(i+1)%samples.length], m=samples[(i-1+samples.length)%samples.length];
    const ds=Math.hypot(b.x-a.x, b.y-a.y);
    let dth=b.theta - m.theta; while(dth> Math.PI)dth-=2*Math.PI; while(dth< -Math.PI)dth+=2*Math.PI;
    const v1x=a.x-m.x, v1y=a.y-m.y, v2x=b.x-a.x, v2y=b.y-a.y;
    const cross=v1x*v2y - v1y*v2x;
    const curvSigned=(Math.abs(ds)<1e-6)?0:(dth/Math.max(ds,1e-6))*Math.sign(cross||1);
    s+=ds;
    centerline.push({x:a.x,y:a.y,theta:a.theta,curv:Math.abs(dth)/Math.max(ds,1e-6),ksign:Math.sign(curvSigned),s});
  }
  totalLen=s;

  findMainStraight();

  leftPts=[]; rightPts=[];
  asphaltPath=new Path2D();
  for(let i=0;i<centerline.length;i++){
    const p=centerline[i], w=halfWidthAt(i), nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
    leftPts.push({x:p.x+w*nx, y:p.y+w*ny, nx,ny});
    rightPts.push({x:p.x-w*nx, y:p.y-w*ny, nx,ny});
  }
  asphaltPath.moveTo(leftPts[0].x,leftPts[0].y);
  for(let i=1;i<leftPts.length;i++) asphaltPath.lineTo(leftPts[i].x,leftPts[i].y);
  for(let i=rightPts.length-1;i>=0;i--) asphaltPath.lineTo(rightPts[i].x,rightPts[i].y);
  asphaltPath.closePath();

  buildPitRoad();
}

function findMainStraight(){
  let bestLen=0,bestStart=0,curLen=0,curStart=0;
  for(let i=0;i<centerline.length*2;i++){
    const idx=i%centerline.length;
    const straight=centerline[idx].curv<STRAIGHT_THRESH;
    if(straight){ if(curLen===0) curStart=idx; curLen++; if(curLen>bestLen){bestLen=curLen; bestStart=curStart;} }
    else curLen=0;
  }
  straightRange.start=bestStart;
  straightRange.end=(bestStart+bestLen)%centerline.length;
}
function straightBlend(i){
  const len=centerline.length, ramp=Math.floor(len*0.02);
  const s=straightRange.start,e=straightRange.end;
  const inRange=(a,b,k)=> a<=b ? (k>=a && k<=b) : (k>=a || k<=b);
  const sRamp=(s - ramp + len)%len, eRamp=(e + ramp)%len;
  if(inRange(s,e,i)) return 1;
  if(inRange(sRamp,s,i)){ const d=(i - sRamp + len)%len; return d/ramp; }
  if(inRange(e,eRamp,i)){ const d=(eRamp - i + len)%len; return d/ramp; }
  return 0;
}
function halfWidthAt(i){
  const t=straightBlend(i);
  return HALF_W_NORMAL*(1-t) + HALF_W_STRAIGHT*t;
}

/* ====== Pit lane & start/finish ====== */
let pitSep=null, pitEntryIdx=0, pitExitIdx=0, pitIds=[];
let pitIdSet = new Set();
let pitLanePoints = []; 

function buildPitRoad(){
  pitSep = new Path2D();
  pitIds = [];
  pitIdSet.clear();
  pitIdSet = new Set(pitIds);
  pitLanePoints.length = 0;

  // all indices along the longest straight
  let i = straightRange.start;
  while (true) {
    pitIds.push(i);
    pitIdSet.add(i);
    if (i === straightRange.end) break;
    i = (i + 1) % centerline.length;
  }
  const n = pitIds.length;

  // where pit lane "window" begins/ends on the straight
  pitEntryIdx = Math.floor(n * 0.18);
  pitExitIdx  = Math.floor(n * 0.86);

  // separation line geometry (ramps in/out)
  const laneW      = LANE_W;
  const insideEdge = HALF_W_STRAIGHT;
  const smooth = t => t*t*(3-2*t);

  let started = false;
  for (let j = pitEntryIdx; j <= pitExitIdx; j++) {
    const idx = pitIds[j];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);

    // ramp the separator in/out so it looks real
    const t = (j - pitEntryIdx) / Math.max(1, (pitExitIdx - pitEntryIdx));
    const wFactor = Math.min(
      smooth(Math.min(1, t/0.12)),
      smooth(Math.min(1, (1-t)/0.12))
    );
    const sepOff = insideEdge - wFactor * laneW;     // separator offset from CL
    const x = p.x + nx*sepOff, y = p.y + ny*sepOff;

    // draw the dashed separator path
    if (!started) { pitSep.moveTo(x, y); started = true; }
    else pitSep.lineTo(x, y);

    // sample the *center* of the pit lane for steering (slightly inside)
    const laneCenter = HALF_W_STRAIGHT - LANE_W*0.60;
    pitLanePoints.push({ i: idx, x: p.x + nx*laneCenter, y: p.y + ny*laneCenter });
  }

  // choose start/finish in the middle of the lower straight
  const midJ = Math.floor((pitEntryIdx + pitExitIdx)/2);
  let best = { j: midJ, score: -Infinity };
  for (let j = pitEntryIdx; j <= pitExitIdx; j++) {
    const idx = pitIds[j], p = centerline[idx];
    const score = p.y - Math.abs(j - midJ)*4; // prefer lower (larger y) & near middle
    if (score > best.score) best = { j, score };
  }
  startLineIndex = pitIds[Math.max(0, pitEntryIdx)];  
  startLineS     = centerline[startLineIndex].s;

  buildPitStalls();
}

const pitStalls = []; // {idx, x,y,theta, occupied:false}
function buildPitStalls(){
  pitStalls.length = 0;
  const usable = pitExitIdx - pitEntryIdx + 1;
  const count = TEAMS.length;
  const step  = Math.max(1, Math.floor(usable/(count+1)));
  for(let k=1;k<=count;k++){
    const j = pitEntryIdx + k*step;
    const idx = pitIds[Math.min(j, pitIds[pitExitIdx])];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const sep = HALF_W_STRAIGHT - LANE_W*0.75;
    pitStalls.push({
      idx,
      x: p.x + nx*sep,
      y: p.y + ny*sep,
      theta: p.theta,
      occupied:false
    });
  }
}

/* lateral offset needed to align with pit-lane center near index i */
function pitLaneTargetLateral(i){
  if (!pitLanePoints.length) return -HALF_W_STRAIGHT + LANE_W*0.60;
  // pick the nearest sampled pit-lane point by index
  let best = pitLanePoints[0], bestD = Infinity;
  for (const q of pitLanePoints){
    const d = Math.abs(q.i - i);
    if (d < bestD){ bestD = d; best = q; }
  }
  const p  = centerline[i];
  const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);
  // lateral = projection of (pitPoint - centerlinePoint) onto the normal
  return (best.x - p.x)*nx + (best.y - p.y)*ny;
}

/* ====== Render ====== */
function drawBackground(){
  if (grassPattern) {
    ctx.fillStyle = grassPattern;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  } else {
    ctx.fillStyle = '#4a6a3f';
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }
}
function drawAsphalt(path){
  // fill the ribbon
  ctx.save();
  ctx.fillStyle = '#393B3E';
  ctx.fill(path);

  // centerline shading (OPEN polyline; no closePath)
  ctx.save();
  ctx.clip(path);
  ctx.lineWidth = 40 * DPR;
  ctx.strokeStyle = 'rgba(20,20,22,0.20)';
  ctx.beginPath();
  ctx.moveTo(centerline[0].x, centerline[0].y);
  for (let i = 1; i < centerline.length; i++) ctx.lineTo(centerline[i].x, centerline[i].y);
  ctx.stroke();
  ctx.restore();

  // outline only along the two ribbon edges to avoid the seam
  ctx.lineWidth = 3 * DPR;
  ctx.strokeStyle = '#e9edf2';
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';

  // left edge
  ctx.beginPath();
  ctx.moveTo(leftPts[0].x, leftPts[0].y);
  for (let i = 1; i < leftPts.length; i++) ctx.lineTo(leftPts[i].x, leftPts[i].y);
  ctx.stroke();

  // right edge
  ctx.beginPath();
  ctx.moveTo(rightPts[0].x, rightPts[0].y);
  for (let i = 1; i < rightPts.length; i++) ctx.lineTo(rightPts[i].x, rightPts[i].y);
  ctx.stroke();

  ctx.restore();
}
function paintKerbs(){
  const KTH=0.0045, STRIDE=8, kerbW=12*DPR, kerbL=24*DPR;
  for(let i=0;i<centerline.length;i+=STRIDE){
    const p=centerline[i]; if(p.curv<KTH) continue;
    const edge=(p.ksign>0)?rightPts[i]:leftPts[i];
    ctx.save();
    ctx.translate(edge.x,edge.y);
    ctx.rotate(p.theta);
    ctx.fillStyle=((i/STRIDE)%2<1)?'#d33':'#fff';
    ctx.fillRect(-kerbL/2,-kerbW,kerbL,kerbW);
    ctx.restore();
  }
}
function drawTrack(){
  drawBackground();
  drawAsphalt(asphaltPath);

  if (pitSep){
    // dashed bright line so the pit lane reads clearly
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 4 * DPR;
    ctx.setLineDash([12 * DPR, 10 * DPR]);
    ctx.stroke(pitSep);
    ctx.restore();

    // entry/exit commit lines (solid)
    const entryCL = centerline[pitIds[pitEntryIdx]];
    const exitCL  = centerline[pitIds[pitExitIdx]];
    const markLen = HALF_W_STRAIGHT * 0.90;

    ctx.save();
    ctx.strokeStyle='#ffffff';
    ctx.lineWidth=3*DPR;

    let nx=-Math.sin(entryCL.theta), ny=Math.cos(entryCL.theta);
    ctx.beginPath();
    ctx.moveTo(entryCL.x - nx*markLen, entryCL.y - ny*markLen);
    ctx.lineTo(entryCL.x + nx*markLen, entryCL.y + ny*markLen);
    ctx.stroke();

    nx=-Math.sin(exitCL.theta); ny=Math.cos(exitCL.theta);
    ctx.beginPath();
    ctx.moveTo(exitCL.x - nx*markLen, exitCL.y - ny*markLen);
    ctx.lineTo(exitCL.x + nx*markLen, exitCL.y + ny*markLen);
    ctx.stroke();
    ctx.restore();
  }

  paintKerbs();
  drawStartFinish();
}

function drawStartFinish() {
  // draw a checkerboard strip centered at the S/F index, perpendicular to flow
  const cl = centerline[startLineIndex];
  if (!cl) return;

  const thickness = 18 * DPR;               // strip “length” along the tangent
  const halfAcross = HALF_W_STRAIGHT * 0.95; // span across most of the road
  const cell = 10 * DPR;                    // checker size

  ctx.save();
  ctx.translate(cl.x, cl.y);
  ctx.rotate(cl.theta);                     // x = along track, y = across track

  // dark base
  ctx.fillStyle = '#0e0f12';
  ctx.fillRect(-thickness/2, -halfAcross, thickness, 2*halfAcross);

  // white/black checkers
  for (let y = -halfAcross, i = 0; y < halfAcross; y += cell, i++) {
    // alternate columns left/right for a checker effect
    const leftW  = thickness/2, rightW = thickness/2;
    ctx.fillStyle = (i % 2 === 0) ? '#fff' : '#111';
    ctx.fillRect(-thickness/2, y, leftW, cell);
    ctx.fillStyle = (i % 2 === 0) ? '#111' : '#fff';
    ctx.fillRect(0,              y, rightW, cell);
  }
  ctx.restore();
}

/* distance → sample */
function sampleAtS(s){
  s=(s%totalLen + totalLen)%totalLen;
  let lo=0, hi=centerline.length-1;
  while(lo<hi){ const mid=(lo+hi)>>1; if(centerline[mid].s < s) lo=mid+1; else hi=mid; }
  const i1=lo, i0=(i1-1+centerline.length)%centerline.length;
  const a=centerline[i0], b=centerline[i1];
  const t=(s-a.s)/Math.max(b.s-a.s,1e-6);
  const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
  let th=a.theta+(b.theta-a.theta)*t; while(th-a.theta>Math.PI) th-=TAU; while(th-a.theta<-Math.PI) th+=TAU;
  const curv=a.curv+(b.curv-a.curv)*t, ksign=Math.sign((b.ksign+a.ksign)/2 || 1);
  return {x,y,theta:th,curv,ksign,i:i0};
}

/* ====== Stats config (cars.json) ====== */
let CAR_STATS = {}; // id -> {spd,acc,han,pit,end,rsk}
async function loadCarStats(){
  CAR_STATS = {};

  // Prefer inline config for file:// local dev
  let data = null;
  const inline = document.getElementById('cars-config');
  if (inline && inline.textContent.trim()) {
    try { data = JSON.parse(inline.textContent); } catch (e) {
      console.warn('[LCU GP] Inline cars-config JSON parse failed:', e);
    }
  }

  // Otherwise fetch external file
  if (!data) {
    try {
      const url = new URL(CARS_JSON, window.location.href);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      data = await res.json();
    } catch (err) {
      console.warn(`[LCU GP] Unable to load ${CARS_JSON}. Falling back to neutral stats.`, err);
      data = null;
    }
  }

  const add = (id, row={})=>{
    if(!id) return;
    const key=String(id).toLowerCase();
    const pick = (...ks)=>{ for(const k of ks) if(row[k]!=null) return +row[k]; };
    CAR_STATS[key] = {
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
    else for(const k of Object.keys(data)) if(TEAMS.some(t=>t.id===k)) add(k,data[k]);
  }
  if (Object.keys(CAR_STATS).length===0) TEAMS.forEach(t=>CAR_STATS[t.id]={spd:5,acc:5,han:5,pit:5,end:5,rsk:5});
}

/* convert 1..10 stats into driving coefficients */
function buildCoefficients(stats){
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

/* ====== Cars / AI ====== */
const CAR_ACROSS=56*1.3*DPR;
const cars=[];

async function setupCars(){
  for(const team of TEAMS){
    const img=await loadImage(OVERHEAD(team.id));
    const p0=sampleAtS(Math.random()*totalLen);
    const nx=-Math.sin(p0.theta), ny=Math.cos(p0.theta);
    const x=p0.x + nx*0, y=p0.y + ny*0, th=p0.theta + SPRITE_HEADING_OFFSET;

    const stats = CAR_STATS[team.id] || {spd:5,acc:5,han:5,pit:5,end:5,rsk:5};
    const cfg   = buildCoefficients(stats);

    cars.push({
      team, img, aspect: img.naturalWidth/img.naturalHeight,
      s: Math.random()*totalLen, v:0.18, boost:0, lap:0,
      lateral:0, targetLateral:0,
      energy: 1,
      planPitLap: null,         
      lapsSincePit: 0,
      wantPit: false, 
      inPit: false,
      pitState: 'none',           // 'none' | 'entering' | 'servicing' | 'exiting'
      pitStall: -1,
      pitStartMs: 0,
      pitElapsedMs: 0,
      pitTargetMs: 0,
      bestPitMs: Infinity,
      lapStartMs: performance.now(),
      bestLapMs: Infinity,
      prevS: 0,
      stats, cfg,
      px:x,py:y,pTheta:th,pY:y,
      rx:x,ry:y,rTheta:th,rY:y
    });
  }
  document.getElementById('kartSelect').innerHTML = cars.map((c,i)=>`<option value="${i}">${c.team.name}</option>`).join('');
}

/* speed target from curvature ahead */
function targetSpeedForS(s, coef){
  const look=160*DPR, N=7;
  let k=0; for(let i=1;i<=N;i++) k += sampleAtS(s + (i*look/N)).curv;
  k/=N;
  return clamp(coef.V_STRAIGHT_BASE/(1 + coef.CORNER_COEF*k), coef.V_MIN, coef.V_STRAIGHT_BASE*1.1);
}

/* ====== PIT helpers ====== */
function assignPitStall(){ const i = pitStalls.findIndex(s=>!s.occupied); if(i>=0) pitStalls[i].occupied=true; return i; }
function releasePitStall(i){ if (i>=0 && pitStalls[i]) pitStalls[i].occupied=false; }
function pitBaselineMs(pitStat){
  const base = 16000 * (5 / Math.max(1, pitStat));      // 5 => ~16s baseline
  const jitter = base * (Math.random()*0.12 - 0.06);    // ±6%
  return Math.max(5000, base + jitter);
}

/* lanes for 3-wide behaviour */
function laneTargetsAt(i){
  const W = halfWidthAt(i)*0.78;
  return [-W, 0, +W];
}
function laneOf(lateral, i){
  const lanes = laneTargetsAt(i);
  let best=0, bd=Infinity;
  for(let k=0;k<lanes.length;k++){
    const d=Math.abs(lateral - lanes[k]);
    if(d<bd){bd=d; best=k;}
  }
  return best;
}
function laneOccupancy(i, myS, windowPx=140){
  const occ=new Set();
  for(const c of cars){
    const ds = ((c.s - myS + totalLen) % totalLen);
    const wrapDs = Math.min(ds, totalLen - ds);
    if (wrapDs < windowPx){ occ.add(laneOf(c.lateral, i)); }
  }
  return occ;
}

function raceDistance(car){
  // distance since race start, normalized to the S/F index
  return car.lap * totalLen + ((car.s - startLineS + totalLen) % totalLen);
}
/* ====== Physics ====== */
function physicsStep(dt){
  const order = [...cars].sort((a,b)=> raceDistance(b) - raceDistance(a));

  for(let oi=0; oi<order.length; oi++){
    const me=order[oi], cfg=me.cfg;

    // previous render buffers
    me.px=me.rx; me.py=me.ry; me.pTheta=me.rTheta; me.pY=me.rY;

    // current sample and lap timing on the start/finish line only
    const pMe = sampleAtS(me.s);
    const sNow = centerline[pMe.i].s;
    const crossed = (me.prevS <= startLineS && sNow > startLineS) ||
                    (me.prevS >  sNow && (me.prevS <= startLineS || sNow > startLineS));
    if (crossed) {
      const now = performance.now();
      const lapMs = now - me.lapStartMs;
      if (lapMs > 1000) me.bestLapMs = Math.min(me.bestLapMs, lapMs);
      me.lapStartMs = now;
      me.lap++;
      me.lapsSincePit++;
    }
    me.prevS = sNow;

    // wear / fatigue
    const wear = cfg.WEAR_RATE * dt * (0.5 + 0.5*pMe.curv*500) * (0.6 + 2.4*me.v);
    me.energy = clamp(me.energy - wear, 0, 1);
    const fatigueFactor = 0.85 + 0.15*me.energy;

    // --- decide at S/F if we should plan to pit on the NEXT lap (baseline 4 laps) ---
    if (crossed) {
      if (me.planPitLap == null && me.lapsSincePit >= 4) {
        const lapsOver = me.lapsSincePit - 4;
        const end  = me.stats.end, risk = me.stats.rsk;
        const energyThresh = 0.30 + 0.03*lapsOver - 0.02*(end-5) - 0.02*(risk-5);
        const incidentProb = Math.min(0.50, Math.max(0, 0.03*lapsOver * (1 + 0.07*(10 - end)) * (1 - 0.05*(risk - 5))));
        if (me.energy < energyThresh || Math.random() < incidentProb) {
          me.wantPit   = true;
          me.planPitLap = me.lap + 1;   // earliest legal lap to enter is NEXT lap
        }
      }
    }

    // car ahead (for gaps/braking)
    const ahead=order[(oi-1+order.length)%order.length];
    let gap=ahead ? (ahead.s - me.s) : totalLen; if(gap<0) gap+=totalLen;

    // ----------------- PIT STATE MACHINE -----------------
    if (me.pitState==='none' && me.wantPit && me.lap >= (me.planPitLap ?? Infinity)) {
      const onStraight = pitIdSet.has(pMe.i);
      me.targetLateral = pitLaneTargetLateral(pMe.i);  // bias toward pit-lane center
      if (onStraight) {
        const j = pitIds.indexOf(pMe.i);
        if (j >= pitEntryIdx && j <= pitExitIdx) {
          const stall = assignPitStall();
          if (stall >= 0) { me.pitState='entering'; me.pitStall=stall; me.inPit=true; }
        }
      }
    }

    if (me.pitState==='entering') {
      // slow to pit speed, steer world-coordinates to the stall
      me.v = Math.min(me.v, cfg.PIT_SPEED);
      const stall = pitStalls[me.pitStall];
      const dx = stall.x - me.rx, dy = stall.y - me.ry;
      const dist = Math.hypot(dx,dy);
      const step = Math.max(0.5, me.v*dt*2.6);
      if (dist > 2.5) {
        const ux = dx/dist, uy = dy/dist;
        me.rx += ux*step; me.ry += uy*step;
        me.s  += me.v*dt*0.25;              // keep order roughly sensible
      } else {
        me.v = 0;
        me.pitState   = 'servicing';
        me.pitStartMs = performance.now();
        me.pitElapsedMs = 0;
        me.pitTargetMs  = pitBaselineMs(me.stats.pit);
        // pin pose to stall
        me.rx = stall.x; me.ry = stall.y; me.rTheta = stall.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;
      }
      continue; // IMPORTANT: do not run normal projection below
    }

    if (me.pitState==='servicing') {
      me.v = 0;
      me.pitElapsedMs += dt;
      me.energy = clamp(me.energy + cfg.REFILL_RATE*dt*4, 0, 1);
      // keep pose in the box
      const stall = pitStalls[me.pitStall];
      me.rx = stall.x; me.ry = stall.y; me.rTheta = stall.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;

      if (me.pitElapsedMs >= me.pitTargetMs) {
        me.bestPitMs   = Math.min(me.bestPitMs, me.pitElapsedMs);
        me.pitState    = 'exiting';
        me.energy      = 1;
        me.lapsSincePit = 0;
        me.planPitLap  = null;      // allow a fresh 4-lap window
        // restart from the stall index on the pit-lane center
        const stallIdx = pitStalls[me.pitStall].idx;
        me.s = centerline[stallIdx].s;
        me.targetLateral = pitLaneTargetLateral(stallIdx);
      }
      continue;
    }

    if (me.pitState==='exiting') {
      // accelerate gently and blend lateral back toward the racing line
      me.v = Math.min(cfg.PIT_SPEED*1.25, me.v + cfg.ACCEL*dt*1.6);
      const LAT_SPEED = 0.005 * dt * clamp(halfWidthAt(pMe.i), 40, 160);
      me.targetLateral += clamp(0 - me.targetLateral, -LAT_SPEED, LAT_SPEED);

      // project along the lane while we exit
      me.s += me.v * dt;
      const p = sampleAtS(me.s);
      const nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
      me.rx = p.x + nx*me.lateral;
      me.ry = p.y + ny*me.lateral;
      me.rTheta = p.theta + SPRITE_HEADING_OFFSET;
      me.rY = me.ry;

      // when past the window, release the stall and rejoin
      const j = pitIds.indexOf(p.i);
      if (j === -1 || j > pitExitIdx) {
        releasePitStall(me.pitStall);
        me.pitStall = -1;
        me.inPit    = false;
        me.wantPit  = false;
        me.pitState = 'none';
      }
      continue;
    }

    // ----------------- NORMAL DRIVING (not pitting) -----------------
    // target speed from curvature (with fatigue) and simple car-ahead logic
    const tv = targetSpeedForS(me.s, cfg)*fatigueFactor + me.boost;
    const sideBySideClear = ahead ? (Math.abs(me.lateral - ahead.lateral) > CAR_ACROSS*0.95) : false;
    if(gap < cfg.SAFE_GAP && !sideBySideClear) me.v = Math.max(cfg.V_MIN, me.v - cfg.BRAKE*dt*1.2);
    else if(me.v < tv)                          me.v = Math.min(tv, me.v + cfg.ACCEL*dt);
    else                                        me.v = Math.max(tv, me.v - cfg.BRAKE*dt);

    // (optional) simple 3-wide aiming – keep as you had it
    // me.targetLateral = ... // your overtake logic here if desired

    // update position and project to world
    me.s += me.v * dt;
    if (me.s >= totalLen) me.s -= totalLen; // lap counted already at the line
    const p2 = sampleAtS(me.s);
    const nx2=-Math.sin(p2.theta), ny2=Math.cos(p2.theta);
    me.rx = p2.x + nx2*me.lateral;
    me.ry = p2.y + ny2*me.lateral;
    me.rTheta = p2.theta + SPRITE_HEADING_OFFSET;
    me.rY = me.ry;

    // lateral blend
    const LAT = 0.005 * dt * clamp(halfWidthAt(p2.i), 40, 160);
    me.lateral += clamp(me.targetLateral - me.lateral, -LAT, LAT);
    me.lateral = clamp(me.lateral, -halfWidthAt(p2.i)+CAR_ACROSS*0.6, halfWidthAt(p2.i)-CAR_ACROSS*0.6);
  }
}

/* ====== Drawing cars ====== */
function drawCars(alpha){
  const ordered=[...cars].sort((a,b)=> (a.pY + (a.rY-a.pY)*alpha) - (b.pY + (b.rY-b.pY)*alpha));
  ctx.font = `${12*DPR}px Inter, system-ui, sans-serif`;

  for(const c of ordered){
    const x=c.px + (c.rx - c.px)*alpha;
    const y=c.py + (c.ry - c.py)*alpha;
    let thA=c.pTheta, thB=c.rTheta;
    let diff=(thB-thA)%TAU; if(diff<-Math.PI) diff+=TAU; if(diff>Math.PI) diff-=TAU;
    const theta=thA + diff*alpha;

    const sprite=getRotatedSprite(c.img, theta, CAR_ACROSS, c.aspect, 48);
    const w=Math.round(CAR_ACROSS*c.aspect), h=Math.round(CAR_ACROSS);
    ctx.drawImage(sprite, x - w/2, y - h/2, w, h);

    const ly=y - (w*0.55);
    let plateText = c.team.name;
    if (c.pitState==='servicing') plateText = fmtCs(c.pitElapsedMs);
    const tw=ctx.measureText(plateText).width + 8*DPR, th=16*DPR;
    ctx.fillStyle=c.team.label.bg; ctx.fillRect(x - tw/2, ly - th, tw, th);
    ctx.fillStyle=c.team.label.fg; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(plateText, x, ly - th/2 + 1*DPR);
  }
}

/* ====== Leaderboard + Modal ====== */
const lbList=document.getElementById('leaderboardList');
lbList.addEventListener('click', (e)=>{
  const li=e.target.closest('.lb-item'); if(!li) return;
  const id=li.dataset.team; const pos=+li.dataset.pos;
  const car=cars.find(c=>c.team.id===id); if(!car) return;

  currentModalCar = car;

  modalImgSide.src=SIDE(car.team.id);
  modalImgTop.src =OVERHEAD(car.team.id);
  modalTitle.textContent=car.team.name;

  if (!modalExtra) {
    const info = modal.querySelector('.modal-info');
    const makeLine = (label, id) => {
      const row = document.createElement('div');
      row.className = 'stat-line';
      row.innerHTML = `<span>${label}</span><strong id="${id}">—</strong>`;
      info.insertBefore(row, info.querySelector('.stat-title'));
      return row.querySelector('strong');
    };
    modalExtra = {
      fastLapEl: makeLine('Fastest Lap', 'modalFastLap'),
      fastPitEl: makeLine('Fastest PIT', 'modalFastPit')
    };
  }

  const s=car.stats;
  modalStatGrid.innerHTML = [
    ['SPD', s.spd], ['ACC', s.acc], ['HAN', s.han],
    ['PIT', s.pit], ['END', s.end], ['RSK', s.rsk],
  ].map(([k,v])=>`<div class="stat-chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  modalPos.textContent=`#${pos}`;
  modalLap.textContent=String(car.lap);
  modalSpd.textContent=`${(car.v*1000).toFixed(1)} px/s`;
  modalBoost.textContent=`${(car.boost>=0?'+':'')}${car.boost.toFixed(2)}`;
  modalExtra.fastLapEl.textContent = car.bestLapMs < Infinity ? fmtLap(car.bestLapMs) : '—';
  modalExtra.fastPitEl.textContent = car.bestPitMs < Infinity ? fmtCs(car.bestPitMs) : '—';

  showModal();
});

let lastLB=0, lbSig="";
const LB_EVERY=300;
function renderLeaderboard(now){
  if(now - lastLB < LB_EVERY) return;
  const order=[...cars].sort((a,b)=> raceDistance(b) - raceDistance(a));
  const sig=order.map(c=>`${c.team.id}:${c.lap}:${Math.floor(((c.s - startLineS + totalLen) % totalLen))}`).join('|');
  if(sig===lbSig) return; lbSig=sig; lastLB=now;
  lbList.innerHTML=order.map((c,idx)=>`
    <li class="lb-item" data-team="${c.team.id}" data-pos="${idx+1}">
      <span class="lb-pos">${idx+1}</span>
      <img class="lb-car" src="${SIDE(c.team.id)}" alt="${c.team.name}" />
      <span class="lb-show" style="color:${c.team.color}">${c.team.name}</span>
      <span class="lb-name">Lap ${c.lap}</span>
    </li>
  `).join('');
}

/* ====== HUD viewers (fake) ====== */
const viewerCountEl=document.getElementById('viewerCount');
let fakeViewers=500 + Math.floor(Math.random()*1500);
viewerCountEl.textContent=fakeViewers.toLocaleString();
setInterval(()=>{ fakeViewers=Math.max(0, fakeViewers + Math.floor((Math.random()-0.5)*30));
  viewerCountEl.textContent=fakeViewers.toLocaleString();
}, 4000);

/* ====== Controls ====== */
let paused=false;
const $=id=>document.getElementById(id);
$('pauseBtn').onclick=()=>paused=true;
$('resumeBtn').onclick=()=>paused=false;
$('resetBtn').onclick=()=>cars.forEach(c=>c.boost=0);
$('boostBtn').onclick=()=>modifySelected(+0.06);
$('slowBtn').onclick =()=>modifySelected(-0.06);
$('randomEventBtn').onclick=()=>{
  const i=Math.floor(Math.random()*cars.length), delta=(Math.random()<0.5?-1:1)*0.08;
  cars[i].boost += delta; setTimeout(()=> cars[i].boost -= delta, 2000);
};
document.addEventListener('keydown',e=>{
  if(e.key==='ArrowUp')   modifySelected(+0.06);
  if(e.key==='ArrowDown') modifySelected(-0.06);
});
function modifySelected(delta){
  const idx=Number($('kartSelect').value||0);
  cars[idx].boost += delta; setTimeout(()=> cars[idx].boost -= delta, 1500);
}

function runCountdown(){
  raceState = 'countdown';
  paused = true;
  const cues = ['●', '● ●', '● ● ●', 'GO!'];
  const colors = ['#d33','#d33','#ffb400','#19c523'];

  let i = 0;
  const tick = ()=>{
    startBtn.textContent = cues[i];
    startBtn.style.borderColor = colors[i];
    startBtn.style.color = colors[i];
    i++;
    if (i < cues.length) setTimeout(tick, 700);
    else {
      // GREEN!
      startBtn.textContent = 'FINISH';
      startBtn.style.borderColor = '';
      startBtn.style.color = '';
      tinyPause.style.display = '';
      paused = false;
      raceState = 'green';
    }
  };
  tick();
}

startBtn.addEventListener('click', ()=>{
  if (raceState === 'grid')        runCountdown();
  else if (raceState === 'green') { raceState = 'finished'; paused = true; startBtn.disabled = true; startBtn.textContent = 'FINISHED'; }
});

tinyPause.addEventListener('click', ()=>{
  if (raceState !== 'green') return;
  paused = !paused;
  tinyPause.textContent = paused ? 'Resume' : 'Pause';
});

/* ====== Main loop (fixed timestep) ====== */
const STEP=1000/120;
let accumulator=0, last=performance.now();
function frame(now){
  let dt=now - last; last=now; dt=Math.min(dt,100);
  accumulator += dt;
  let iters=0;
  while(accumulator>=STEP && iters<8){
    if(!paused) physicsStep(STEP);
    accumulator -= STEP; iters++;
  }
  const alpha=accumulator/STEP;
  drawTrack(); drawCars(alpha); renderLeaderboard(now);

  // live-update modal if open
  if (currentModalCar && modal.classList.contains('show')) {
    const order=[...cars].sort((a,b)=>(b.lap + b.s/totalLen) - (a.lap + a.s/totalLen));
    const pos = order.findIndex(c=>c===currentModalCar) + 1;
    modalPos.textContent = `#${pos || 1}`;
    modalLap.textContent = String(currentModalCar.lap);
    modalSpd.textContent = `${(currentModalCar.v*1000).toFixed(1)} px/s`;
    modalBoost.textContent = `${(currentModalCar.boost>=0?'+':'')}${currentModalCar.boost.toFixed(2)}`;
    if (modalExtra) {
      modalExtra.fastLapEl.textContent = currentModalCar.bestLapMs < Infinity ? fmtLap(currentModalCar.bestLapMs) : '—';
      modalExtra.fastPitEl.textContent = currentModalCar.bestPitMs < Infinity ? fmtCs(currentModalCar.bestPitMs) : '—';
    }
  }

  requestAnimationFrame(frame);
}

function lineupGrid(){
  // two-by-two rows behind the S/F line
  const rowGap = 2.4 * CAR_ACROSS;             // distance along track between rows
  const lanes  = [-LANE_W*0.85, +LANE_W*0.85]; // left/right stagger
  let sHead = startLineS - 3.0*CAR_ACROSS;     // first row just behind the line

  cars.forEach((c, i)=>{
    const row = Math.floor(i/2), col = i%2;
    const sPos = (sHead - row * rowGap + totalLen) % totalLen;
    const p    = sampleAtS(sPos);
    const nx   = -Math.sin(p.theta), ny = Math.cos(p.theta);

    c.s = sPos;
    c.v = 0;
    c.lateral = lanes[col];
    c.targetLateral = c.lateral;

    c.rx = p.x + nx*c.lateral;
    c.ry = p.y + ny*c.lateral;
    c.rTheta = p.theta + SPRITE_HEADING_OFFSET;
    c.px = c.rx; c.py = c.ry; c.pTheta = c.rTheta; c.pY = c.ry;
  });
}

/* ====== Boot ====== */
(async function boot(){
  sizeCanvas();

  // grass tile
  try {
    const grassImg = await loadImage(GRASS_TILE);
    grassPattern = ctx.createPattern(grassImg, 'repeat');
    if (grassPattern && grassPattern.setTransform && 'DOMMatrix' in window) {
      grassPattern.setTransform(new DOMMatrix());
    }
  } catch(e){ console.warn('Grass tile failed to load; using fallback.', e); }

  await loadCarStats();
  await setupCars();
  lineupGrid();
  paused = true;        
  startBtn.disabled = false;
  startBtn.textContent = 'START';
  raceState = 'grid';
  requestAnimationFrame(frame);
})();
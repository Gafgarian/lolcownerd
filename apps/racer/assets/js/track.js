// assets/js/track.js
import { clamp, TAU } from './lib/util.js';
import { STRAIGHT_THRESH } from './lib/config.js';
import { State } from './lib/state.js';
import { buildPitRoad } from './pit.js';

const CTRL_BASE = [
  /* Top */
  [0.1,0.18],[0.2,0.1],[0.3,0.1],
  [0.4,0.15],[0.45,0.2],[0.5,0.22],[0.55,0.2],[0.6,0.15],
  [0.7,0.1],[0.8,0.1],[0.9,0.15],

  /* Right */
  [0.92,0.2],[0.9,0.27],
  [0.86,0.29],[0.78,0.33],[0.35,0.5],
  [0.38,0.63],[0.76,0.52],[0.85,0.65],
  [0.9,0.76],

  /* Bottom */
  [0.85,0.85],[0.78,0.85],[0.75,0.85],[0.7,0.85],
  [0.65,0.85],[0.6,0.85],[0.55,0.85],[0.5,0.85],[0.45,0.85],
  [0.4,0.85],[0.35,0.85],[0.3,0.85],[0.25,0.85],[0.23,0.85],
  [0.17,0.85],

  /* Left */
  [0.11,0.8],[0.1,0.75],[0.1,0.7],
  [0.1,0.6],[0.1,0.5],[0.1,0.4],
  [0.1,0.3],[0.1,0.28],[0.1,0.28]
];

// Centripetal Catmull–Rom (alpha=0.5) for closed loops
function crPoint(p0,p1,p2,p3,t,alpha=0.5){
  const d01 = Math.hypot(p1[0]-p0[0], p1[1]-p0[1]) ** alpha;
  const d12 = Math.hypot(p2[0]-p1[0], p2[1]-p1[1]) ** alpha;
  const d23 = Math.hypot(p3[0]-p2[0], p3[1]-p2[1]) ** alpha;
  const t0=0, t1=t0+d01, t2=t1+d12, t3=t2+d23;
  const tt = t1 + (t2 - t1) * t;
  const A1=[ (t1-tt)/(t1-t0)*p0[0] + (tt-t0)/(t1-t0)*p1[0],
            (t1-tt)/(t1-t0)*p0[1] + (tt-t0)/(t1-t0)*p1[1] ];
  const A2=[ (t2-tt)/(t2-t1)*p1[0] + (tt-t1)/(t2-t1)*p2[0],
            (t2-tt)/(t2-t1)*p1[1] + (tt-t1)/(t2-t1)*p2[1] ];
  const A3=[ (t3-tt)/(t3-t2)*p2[0] + (tt-t2)/(t3-t2)*p3[0],
            (t3-tt)/(t3-t2)*p2[1] + (tt-t2)/(t3-t2)*p3[1] ];
  const B1=[ (t2-tt)/(t2-t0)*A1[0] + (tt-t0)/(t2-t0)*A2[0],
            (t2-tt)/(t2-t0)*A1[1] + (tt-t0)/(t2-t0)*A2[1] ];
  const B2=[ (t3-tt)/(t3-t1)*A2[0] + (tt-t1)/(t3-t1)*A3[0],
            (t3-tt)/(t3-t1)*A2[1] + (tt-t1)/(t3-t1)*A3[1] ];
  return [
    (t2-tt)/(t2-t1)*B1[0] + (tt-t1)/(t2-t1)*B2[0],
    (t2-tt)/(t2-t1)*B1[1] + (tt-t1)/(t2-t1)*B2[1]
  ];
}
function crTangent(p0,p1,p2,p3,t){
  const eps = 1e-3;
  const a = crPoint(p0,p1,p2,p3, Math.max(0, t-eps));
  const b = crPoint(p0,p1,p2,p3, Math.min(1, t+eps));
  return [b[0]-a[0], b[1]-a[1]];
}

function normToPx(pts,W,H){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [x,y] of pts){ if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; }
  const bw=maxX-minX, bh=maxY-minY, margin=0.11;
  const S=Math.min((1-2*margin)/bw,(1-2*margin)/bh);
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  return pts.map(([x,y])=>[(x-cx)*S*W + W/2, (y-cy)*S*H + H/2]);
}

export function sizeCanvas(){
  const hud=document.querySelector('.hud');
  const hudH=hud?hud.getBoundingClientRect().height:56;
  const w=Math.max(720, window.innerWidth-16);
  const h=Math.max(500, window.innerHeight-hudH-16);

  State.canvas.style.width=`${w}px`; State.canvas.style.height=`${h}px`;
  State.canvas.width=Math.round(w*State.DPR);
  State.canvas.height=Math.round(h*State.DPR);

  
  // Update to modify canvas size and track dimensions
  State.LANE_W = Math.max(28*State.DPR, State.canvas.width*0.024);

  const WIDEN = 1.60;
  State.HALF_W_NORMAL   = 1.35*State.LANE_W*WIDEN;
  State.HALF_W_STRAIGHT = 2.10*State.LANE_W*WIDEN;

  buildTrack();
  buildPitRoad();
}

function findMainStraight(){
  // ✅ ensure the object exists
  if (!State.straightRange) State.straightRange = { start: 0, end: 0 };

  let bestLen=0,bestStart=0,curLen=0,curStart=0;
  const c = State.centerline;
  for(let i=0;i<c.length*2;i++){
    const idx=i%c.length;
    const straight=c[idx].curv<STRAIGHT_THRESH;
    if(straight){
      if(curLen===0) curStart=idx;
      curLen++;
      if(curLen>bestLen){bestLen=curLen; bestStart=curStart;}
    } else curLen=0;
  }
  State.straightRange.start = bestStart;
  State.straightRange.end   = (bestStart + bestLen) % State.centerline.length;
}

export function straightBlend(i){
  const len=State.centerline.length, ramp=Math.floor(len*0.02);
  const s=State.straightRange.start,e=State.straightRange.end;
  const inRange=(a,b,k)=> a<=b ? (k>=a && k<=b) : (k>=a || k<=b);
  const sRamp=(s - ramp + len)%len, eRamp=(e + ramp)%len;
  if(inRange(s,e,i)) return 1;
  if(inRange(sRamp,s,i)){ const d=(i - sRamp + len)%len; return d/ramp; }
  if(inRange(e,eRamp,i)){ const d=(eRamp - i + len)%len; return d/ramp; }
  return 0;
}
export function halfWidthAt(i){
  const t=straightBlend(i);
  return State.HALF_W_NORMAL*(1-t) + State.HALF_W_STRAIGHT*t;
}

export function buildTrack(){
  const CTRL=normToPx(CTRL_BASE, State.canvas.width, State.canvas.height);

  const samples=[];
  const N = CTRL.length;
  const steps = 64;
  for (let i=0;i<N;i++){
    const p0=CTRL[(i-1+N)%N], p1=CTRL[i%N], p2=CTRL[(i+1)%N], p3=CTRL[(i+2)%N];
    for (let j=0;j<steps;j++){
      const t=j/steps;
      const [x,y]=crPoint(p0,p1,p2,p3,t,0.5);
      const [tx,ty]=crTangent(p0,p1,p2,p3,t);
      samples.push({x,y,theta:Math.atan2(ty,tx)});
    }
  }
  samples.push({...samples[0]});

  State.centerline.length = 0;
  let s=0;
  for(let i=0;i<samples.length;i++){
    const a=samples[i], b=samples[(i+1)%samples.length], m=samples[(i-1+samples.length)%samples.length];
    const ds=Math.hypot(b.x-a.x, b.y-a.y);
    let dth=b.theta - m.theta; while(dth> Math.PI)dth-=2*Math.PI; while(dth< -Math.PI)dth+=2*Math.PI;
    const v1x=a.x-m.x, v1y=a.y-m.y, v2x=b.x-a.x, v2y=b.y-a.y;
    const cross=v1x*v2y - v1y*v2x;
    const curvSigned=(Math.abs(ds)<1e-6)?0:(dth/Math.max(ds,1e-6))*Math.sign(cross||1);
    s+=ds;
    State.centerline.push({x:a.x,y:a.y,theta:a.theta,curv:Math.abs(dth)/Math.max(ds,1e-6),ksign:Math.sign(curvSigned),s});
  }
  State.totalLen=s;

  findMainStraight();

  State.leftPts.length=0; State.rightPts.length=0;
  const path=new Path2D();
  for(let i=0;i<State.centerline.length;i++){
    const p=State.centerline[i], w=halfWidthAt(i), nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
    State.leftPts.push({x:p.x+w*nx, y:p.y+w*ny, nx,ny});
    State.rightPts.push({x:p.x-w*nx, y:p.y-w*ny, nx,ny});
  }
  path.moveTo(State.leftPts[0].x,State.leftPts[0].y);
  for(let i=1;i<State.leftPts.length;i++) path.lineTo(State.leftPts[i].x,State.leftPts[i].y);
  for(let i=State.rightPts.length-1;i>=0;i--) path.lineTo(State.rightPts[i].x,State.rightPts[i].y);
  path.closePath();
  State.asphaltPath = path;
}

export function sampleAtS(s){
  const c = State.centerline, totalLen = State.totalLen;
  s=(s%totalLen + totalLen)%totalLen;
  let lo=0, hi=c.length-1;
  while(lo<hi){ const mid=(lo+hi)>>1; if(c[mid].s < s) lo=mid+1; else hi=mid; }
  const i1=lo, i0=(i1-1+c.length)%c.length;
  const a=c[i0], b=c[i1];
  const t=(s-a.s)/Math.max(b.s-a.s,1e-6);
  const x=a.x+(b.x-a.x)*t, y=a.y+(b.y-a.y)*t;
  let th=a.theta+(b.theta-a.theta)*t; while(th-a.theta>Math.PI) th-=TAU; while(th-a.theta<-Math.PI) th+=TAU;
  const curv=a.curv+(b.curv-a.curv)*t, ksign=Math.sign((b.ksign+a.ksign)/2 || 1);
  return {x,y,theta:th,curv,ksign,i:i0};
}

export function drawPitAndStart() {
  const { ctx, DPR, pitSep, startLineIndex, centerline, HALF_W_STRAIGHT } = State;
  if (!pitSep) return;

  // pit lane separator (dashed white)
  ctx.save();
  ctx.lineWidth = 2 * DPR;
  ctx.setLineDash([10 * DPR, 10 * DPR]);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.stroke(pitSep);
  ctx.restore();

  // start/finish chequered band at the mid-straight point we picked in buildPitRoad()
  const i = startLineIndex;
  const p = centerline[i];
  const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);

  const band = HALF_W_STRAIGHT * 0.9;     // length of the band across the road
  const tile = 8 * DPR;                   // size of each check
  const cols = Math.floor(band / tile);

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(ny, nx));         // line normal
  for (let c = -cols; c <= cols; c++) {
    const x = c * tile;
    ctx.fillStyle = (c & 1) ? '#111' : '#fff';
    ctx.fillRect(x - tile/2, -2*DPR, tile, 4*DPR);
  }
  ctx.restore();
}

export function drawBackground(){
  const {ctx, canvas, grassPattern} = State;
  if (grassPattern) {
    ctx.fillStyle = grassPattern;
    ctx.fillRect(0,0,canvas.width,canvas.height);
  } else {
    ctx.fillStyle = '#4a6a3f';
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }
}
export function drawAsphalt(){
  const {ctx, asphaltPath, centerline, DPR} = State;
  const path = asphaltPath;
  ctx.save();
  ctx.fillStyle = '#2b2d31';
  ctx.fill(path);

  ctx.clip(path);
  ctx.lineWidth   = 32*DPR;                      
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.miterLimit  = 2;
  ctx.strokeStyle = 'rgba(20,20,22,0.20)';
  ctx.beginPath();
  ctx.moveTo(centerline[0].x, centerline[0].y);
  for(let i=1;i<centerline.length;i++) ctx.lineTo(centerline[i].x, centerline[i].y);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle='#e9edf2';
  ctx.lineWidth=3*DPR;
  ctx.stroke(path);
  ctx.restore();
}
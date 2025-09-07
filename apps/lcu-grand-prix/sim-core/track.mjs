import { STRAIGHT_THRESH, WORLD } from './config.mjs';
import { catmullRom, catmullRomTangent, normToPx } from './util.mjs';

const CTRL_BASE = [
  /* Top */
  [0.1,0.18],[0.2,0.1],[0.3,0.1],
  [0.4,0.15],[0.45,0.2],[0.5,0.22],[0.55,0.2],[0.6,0.15],
  [0.7,0.1],[0.8,0.1],[0.85,0.12],

  /* Right */
  [0.87,0.18],[0.86,0.26],[0.78,0.33],[0.40,0.43],
  [0.41,0.64],[0.76,0.52],[0.85,0.61],
  [0.86,0.7],

  /* Bottom */
  [0.84,0.78],[0.78,0.8],[0.75,0.8],[0.7,0.8],
  [0.65,0.8],[0.6,0.8],[0.55,0.8],[0.5,0.8],[0.45,0.8],
  [0.4,0.8],[0.35,0.8],[0.3,0.8],[0.25,0.8],[0.23,0.8],
  [0.17,0.8],

  /* Left */
  [0.13,0.8],[0.1,0.76],[0.09,0.7],
  [0.1,0.6],[0.1,0.5],[0.1,0.4],
  [0.1,0.3],
  [0.1,0.18],[0.2,0.1],[0.3,0.1],
];

export function buildTrackGeometry({ width = WORLD.width, height = WORLD.height } = {}){
  const CTRL = normToPx(CTRL_BASE, width, height);

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

  let centerline=[]; let s=0;
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
  const totalLen=s;

  // find longest straight
  let bestLen=0,bestStart=0,curLen=0,curStart=0;
  for(let i=0;i<centerline.length*2;i++){
    const idx=i%centerline.length;
    const straight=centerline[idx].curv<STRAIGHT_THRESH;
    if(straight){ if(curLen===0) curStart=idx; curLen++; if(curLen>bestLen){bestLen=curLen; bestStart=curStart;} }
    else curLen=0;
  }
  const straightRange={start:bestStart, end:(bestStart+bestLen)%centerline.length};

  const ramp=Math.floor(centerline.length*0.02);
  const inRange=(a,b,k)=> a<=b ? (k>=a && k<=b) : (k>=a || k<=b);
  function straightBlend(i){
    const len=centerline.length;
    const s=straightRange.start,e=straightRange.end;
    const sRamp=(s - ramp + len)%len, eRamp=(e + ramp)%len;
    if(inRange(s,e,i)) return 1;
    if(inRange(sRamp,s,i)){ const d=(i - sRamp + len)%len; return d/ramp; }
    if(inRange(e,eRamp,i)){ const d=(eRamp - i + len)%len; return d/ramp; }
    return 0;
  }

  const LANE_W = 30;
  const WIDEN = 1.60;
  const HALF_W_NORMAL   = 1.5 * LANE_W * WIDEN;
  const HALF_W_STRAIGHT = 2.10 * LANE_W * WIDEN;
  function halfWidthAt(i){
    const t=straightBlend(i);
    return HALF_W_NORMAL*(1-t) + HALF_W_STRAIGHT*t;
  }

  let leftPts=[], rightPts=[];
  for(let i=0;i<centerline.length;i++){
    const p=centerline[i], w=halfWidthAt(i), nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
    leftPts.push({x:p.x+w*nx, y:p.y+w*ny});
    rightPts.push({x:p.x-w*nx, y:p.y-w*ny});
  }

  return {
    width, height, centerline, totalLen, leftPts, rightPts,
    straightRange, straightBlend, halfWidthAt,
    LANE_W, HALF_W_NORMAL, HALF_W_STRAIGHT
  };
}
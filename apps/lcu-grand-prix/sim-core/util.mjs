export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp  = (a, b, t) => a + (b - a) * t;

export function catmullRom(p0,p1,p2,p3,t){
  const t2=t*t,t3=t2*t;
  return [
    0.5*((2*p1[0])+(-p0[0]+p2[0])*t+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
    0.5*((2*p1[1])+(-p0[1]+p2[1])*t+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3),
  ];
}
export function catmullRomTangent(p0,p1,p2,p3,t){
  const t2=t*t;
  return [
    0.5*((-p0[0]+p2[0])+2*(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t+3*(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t2),
    0.5*((-p0[1]+p2[1])+2*(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t+3*(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t2),
  ];
}

export function normToPx(pts,W,H){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const [x,y] of pts){ if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y; }
  const bw=maxX-minX, bh=maxY-minY, margin=0.07;
  const S=Math.min((1-2*margin)/bw,(1-2*margin)/bh);
  const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
  return pts.map(([x,y])=>[(x-cx)*S*W + W/2, (y-cy)*S*H + H/2]);
}

export function sampleAtS(centerline, totalLen, s){
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

export const distAhead = (sA, sB, totalLen) => (sB - sA + totalLen) % totalLen;
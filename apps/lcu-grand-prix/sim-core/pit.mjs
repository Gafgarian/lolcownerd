import { STRAIGHT_THRESH } from './config.mjs';

export function buildPit(geom){
  const { centerline, straightRange, LANE_W, HALF_W_STRAIGHT } = geom;

  const pitIds = [];
  let i = straightRange.start;
  while(true){
    pitIds.push(i);
    if (i === straightRange.end) break;
    i = (i+1) % centerline.length;
  }
  const n = pitIds.length;

  const pitEntryIdx = Math.floor(n*0.18);
  const pitExitIdx  = Math.floor(n*0.86);

  // dashed separator points for viewer (not Path2D)
  const sepPoints = [];
  const laneW      = LANE_W;
  const insideEdge = HALF_W_STRAIGHT;
  const smooth = t => t*t*(3-2*t);

  const laneCenterPoints = []; // for pitLaneTargetLateral

  for(let j=pitEntryIdx; j<=pitExitIdx; j++){
    const idx = pitIds[j];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const t   = (j - pitEntryIdx) / Math.max(1, pitExitIdx - pitEntryIdx);
    const wF  = Math.min(smooth(Math.min(1, t/0.12)), smooth(Math.min(1, (1-t)/0.12)));
    const sepOff = insideEdge - wF * laneW;
    const x = p.x + nx*sepOff, y = p.y + ny*sepOff;
    sepPoints.push({x,y});

    const laneCenter = HALF_W_STRAIGHT - LANE_W*0.60;
    laneCenterPoints.push({ i: idx, x: p.x + nx*laneCenter, y: p.y + ny*laneCenter });
  }

  // choose S/F roughly mid-pit straight, prefer lower y
  const midJ = Math.floor((pitEntryIdx + pitExitIdx)/2);
  let best = { j: midJ, score: -Infinity };
  for (let j = pitEntryIdx; j <= pitExitIdx; j++) {
    const idx = pitIds[j], p = centerline[idx];
    const score = p.y - Math.abs(j - midJ)*4;
    if (score > best.score) best = { j, score };
  }
  const startLineIndex = pitIds[Math.floor((pitEntryIdx + pitExitIdx)/2)];
  const startLineS     = centerline[startLineIndex].s;

  // stalls
  const stalls = [];
  const usable = pitExitIdx - pitEntryIdx + 1;
  const count  = 12;
  const step   = Math.max(1, Math.floor(usable/(count+1)));
  for(let k=1;k<=count;k++){
    const j = pitEntryIdx + k*step;
    const idx = pitIds[Math.min(j, pitIds[pitExitIdx])];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const sep = HALF_W_STRAIGHT - LANE_W*0.75;
    stalls.push({ idx, x: p.x + nx*sep, y: p.y + ny*sep, theta: p.theta, occupied:false });
  }

  function pitLaneTargetLateral(i){
    if (!laneCenterPoints.length) return -HALF_W_STRAIGHT + LANE_W*0.60;
    let best = laneCenterPoints[0], bestD = Infinity;
    for (const q of laneCenterPoints){
      const d = Math.abs(q.i - i);
      if (d < bestD){ bestD = d; best = q; }
    }
    const p  = centerline[i];
    const nx = -Math.sin(p.theta), ny = Math.cos(p.theta);
    return (best.x - p.x)*nx + (best.y - p.y)*ny;
  }

  const pitIdSet = new Set(pitIds);

  return {
    pitIds, pitIdSet, pitEntryIdx, pitExitIdx,
    sepPoints, stalls,
    startLineIndex, startLineS,
    pitLaneTargetLateral
  };
}
// assets/js/pit.js
import { State } from './lib/state.js';
import { halfWidthAt, straightBlend } from './track.js';

export function buildPitRoad(){
  const { centerline, straightRange } = State;
  State.pitSep = new Path2D();
  State.pitIds = [];
  let i=straightRange.start; while(true){ State.pitIds.push(i); if(i===straightRange.end) break; i=(i+1)%centerline.length; }
  const n = State.pitIds.length;

  State.pitEntryIdx = Math.floor(n*0.18);
  State.pitExitIdx  = Math.floor(n*0.86);
  State.pitIdSet = new Set(State.pitIds);

  // choose S/F mid-straight
  const midIdx = State.pitIds[Math.floor(n*0.52)];
  State.startLineIndex = midIdx;
  State.startLineS     = centerline[midIdx].s;

  const laneW      = State.LANE_W;
  const insideEdge = State.HALF_W_STRAIGHT;
  const smooth = t => t*t*(3-2*t);

  let started = false;
  for(let j=State.pitEntryIdx; j<=State.pitExitIdx; j++){
    const t = (j - State.pitEntryIdx) / Math.max(1, (State.pitExitIdx - State.pitEntryIdx));
    const wFactor = Math.min(smooth(Math.min(1, t/0.12)), smooth(Math.min(1, (1-t)/0.12)));
    const sepOff = insideEdge - wFactor * laneW;

    const idx = State.pitIds[j];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const x = p.x + nx * sepOff;
    const y = p.y + ny * sepOff;

    if(!started){ State.pitSep.moveTo(x,y); started = true; } else State.pitSep.lineTo(x,y);
  }

  buildPitStalls();

  // keep flat fields for older code, but also publish the structured view physics.js expects
  State.pit = {
    ids: State.pitIds,
    idSet: State.pitIdSet,
    entryIdx: State.pitEntryIdx,
    exitIdx: State.pitExitIdx,
    stalls: State.pitStalls,
  };
}

export function buildPitStalls(){
  const { pitEntryIdx, pitExitIdx, pitIds, centerline, LANE_W, HALF_W_STRAIGHT, pitStalls } = State;
  pitStalls.length = 0;
  const usable = pitExitIdx - pitEntryIdx + 1;
  const count  = 12; // enough stalls; or use teams length if you import it here
  const step   = Math.max(1, Math.floor(usable/(count+1)));
  for(let k=1;k<=count;k++){
    const j   = pitEntryIdx + k*step;
    const idx = pitIds[Math.min(j, pitExitIdx)];
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const sep = HALF_W_STRAIGHT - LANE_W*0.75;
    pitStalls.push({ idx, x: p.x + nx*sep, y: p.y + ny*sep, theta: p.theta, occupied:false });
  }
}

export function assignPitStall(){
  const i = State.pitStalls.findIndex(s=>!s.occupied);
  if (i === -1) return -1;
  State.pitStalls[i].occupied = true;
  return i;
}
export function releasePitStall(i){
  if (i>=0 && State.pitStalls[i]) State.pitStalls[i].occupied=false;
}

export function pitLaneTargetLateral(i){
  // center of lane: negative is toward infield on the main straight
  const w  = halfWidthAt(i);
  return -w + State.LANE_W*0.40;
}

export const isIdxInPitWindow = (i) => {
  const { pitIds, pitEntryIdx, pitExitIdx } = State;
  const j = pitIds.indexOf(i);
  return j >= pitEntryIdx && j <= pitExitIdx;
};

// Baseline pit-stop time helper
// PIT=5 → ~16.00s. Higher PIT ⇒ proportionally faster, with ±6% jitter.
// Never shorter than 5s.
// Baseline pit-stop duration (stat-aware) with small jitter
export function pitBaselineMs(pitStat){
  const base   = 16000 * (5 / Math.max(1, pitStat));
  const jitter = base * (Math.random()*0.12 - 0.06);
  return Math.max(5000, base + jitter);
}
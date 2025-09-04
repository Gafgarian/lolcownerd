import { sampleAtS } from './util.mjs';

export function initSplits(geom){
  const { totalLen, centerline, startLineIndex } = geom;
  const startS = centerline[startLineIndex]?.s ?? 0;
  const halfS = (startS + totalLen/2) % totalLen;
  const halfIndex = nearestIndexForS(centerline, halfS);
  return {
    halfIndex,
    halfS,
    halfLapNumber: 0,
    lastHalfCross: new Map(),   // teamId -> ms
    currentHalfLeader: null,
    halfGaps: new Map()
  };
}

function nearestIndexForS(centerline, s){
  let bestI=0, bestD=Infinity;
  for (let i=0;i<centerline.length;i++){
    const d = Math.abs(centerline[i].s - s);
    if (d < bestD){ bestD=d; bestI=i; }
  }
  return bestI;
}

export function updateHalfSplit(sim, car, sNow, nowMs){
  const { centerline, totalLen } = sim;
  const lineS = centerline[sim.splits.halfIndex].s;
  const prevS = car.prevHalfS ?? sNow.s ?? lineS;
  const nowS  = centerline[sNow.i].s;
  car.prevHalfS = nowS;

  const crossed = (prevS <= lineS && nowS > lineS) ||
                  (prevS >  nowS && (prevS <= lineS || nowS > lineS));
  if (!crossed) return;

  const teamId = car.team.id;
  sim.splits.lastHalfCross.set(teamId, nowMs);

  if (!sim.splits.currentHalfLeader || sim.splits.currentHalfLeader === teamId) {
    sim.splits.currentHalfLeader = teamId;
    sim.splits.halfLapNumber += 1;
    sim.splits.halfGaps.clear();
    sim.splits.halfGaps.set(teamId, 0);
    return;
  }

  const leaderT = sim.splits.lastHalfCross.get(sim.splits.currentHalfLeader);
  if (leaderT != null) {
    sim.splits.halfGaps.set(teamId, Math.max(0, Math.round(nowMs - leaderT)));
  }
}
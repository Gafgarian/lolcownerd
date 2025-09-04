import { State } from './lib/state.js';
import { STRAIGHT_THRESH } from './lib/config.js';
import { clamp } from './lib/util.js';
import { sampleAtS, halfWidthAt, straightBlend } from './track.js';
import {
  assignPitStall,
  releasePitStall,
  pitLaneTargetLateral,
  pitBaselineMs,        // ← must be here
} from './pit.js';

// --- tiny helpers that used to be implicit ---
const raceDistance = (c, totalLen) => c.lap + (c.s / totalLen);

const distAhead = (fromS, toS, totalLen) => {
  let d = toS - fromS;
  if (d < 0) d += totalLen;
  return d;
};

function laneAheadGap(me, order, targetLat, look=240, CAR_ACROSS, totalLen){
  let best = look;
  for (const other of order){
    if (other === me) continue;
    const d = distAhead(me.s, other.s, totalLen);
    if (d <= 0 || d > look) continue;
    const sep = Math.abs(targetLat - other.lateral);
    if (sep < CAR_ACROSS*0.7) best = Math.min(best, d);
  }
  return best;
}

function targetSpeedForS(s, cfg){
  const look=160, N=7;
  let k=0; for(let i=1;i<=N;i++) k += sampleAtS(s + (i*look/N)).curv;
  k/=N;
  return clamp(cfg.V_STRAIGHT_BASE/(1 + cfg.CORNER_COEF*k), cfg.V_MIN, cfg.V_STRAIGHT_BASE*1.1);
}

/**
 * Drive one fixed-timestep tick.
 * NOTE: all world/shared values come in via S to avoid globals.
 */
export function physicsStep(dt, S = State){
  // core
  const { cars, centerline, totalLen, startLineS } = S;
  // support both State.pit (bundled) and flat fields
  const pit = S.pit ?? {
    ids: S.pitIds, idSet: S.pitIdSet,
    entryIdx: S.pitEntryIdx, exitIdx: S.pitExitIdx,
    stalls: S.pitStalls
  };
  // pit (flat in your current State)
  const pitIds      = pit.ids;
  const pitIdSet    = pit.idSet;
  const pitEntryIdx = pit.entryIdx;
  const pitExitIdx  = pit.exitIdx;
  const pitStalls   = pit.stalls;
  // dimensions / constants with fallbacks
  const CAR_ACROSS = S.dims?.CAR_ACROSS ?? S.CAR_ACROSS ?? (56*1.3*(S.DPR||1));
  const LANE_W     = S.LANE_W;
  const SPRITE_HEADING_OFFSET = S.SPRITE_HEADING_OFFSET ?? (Math.PI/2);
  const DUEL_ARC_PX  = S.consts?.DUEL_ARC_PX  ?? 420;
  const DUEL_CLEAR_GAP_PX = S.consts?.DUEL_CLEAR_GAP_PX ?? 60;
  const EDGE_MARGIN   = S.consts?.EDGE_MARGIN   ?? { normal:0.60, duel:0.50 };
  const CORNER_PASS_K = S.consts?.CORNER_PASS_K ?? (STRAIGHT_THRESH*0.75);

  const order = [...cars].sort((a,b)=> raceDistance(b, totalLen) - raceDistance(a, totalLen));

  for(let oi=0; oi<order.length; oi++){
    const me=order[oi], cfg=me.cfg;

    // previous render buffers
    me.px=me.rx; me.py=me.ry; me.pTheta=me.rTheta; me.pY=me.rY;

    // current sample and lap timing on the start/finish line only
    const pMe = sampleAtS(me.s);
    const sNow = centerline[pMe.i].s;

    const width       = halfWidthAt(pMe.i);
    const straightish = (straightBlend(pMe.i) > 0.5) || (pMe.curv < STRAIGHT_THRESH*0.55);
    const inCorner    = pMe.curv > CORNER_PASS_K;

    const crossed = (me.prevS <= startLineS && sNow > startLineS) ||
                    (me.prevS >  sNow && (me.prevS <= startLineS || sNow > startLineS));
    if (crossed) {
      const now = performance.now();
      const lapMs = now - me.lapStartMs;
      if (lapMs > 1000) {
        me.lastLapMs = lapMs;
        S.lapSamples = S.lapSamples || [];
        S.lapSamples.push(lapMs);
        if (S.lapSamples.length > 40) S.lapSamples.shift();
        me.bestLapMs = Math.min(me.bestLapMs, lapMs);
      }
      me.lapStartMs = now;
      me.lap++;
      me.lapsSincePit += 1;
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

    // ----- PIT INTENT (armed after S/F, baseline >=4 laps) -----
    if (me.pitState==='none' && !me.wantPit) {
      const baseReady = me.lapsSincePit >= 4;
      const lowEnergy = me.energy < (0.34 - 0.02*me.stats.end + 0.02*(10 - me.stats.rsk));
      if (baseReady && lowEnergy && me.pitArmedLap == null) {
        me.pitArmedLap = me.lap + 1;        // may pit after NEXT time over S/F
      }
      if (me.pitArmedLap != null && me.lap >= me.pitArmedLap) {
        me.wantPit = true;
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
        me.lapsSincePit = 0;         
        me.pitArmedLap = null;  
      }
      continue;
    }

    // ----------------- NORMAL DRIVING (not pitting) -----------------
    // target speed from curvature (with fatigue) and simple car-ahead logic
    const tv = targetSpeedForS(me.s, cfg)*fatigueFactor + me.boost;
    const sideBySideClear = ahead ? (Math.abs(me.lateral - ahead.lateral) > CAR_ACROSS*0.95) : false;
    const duelActive = (me.duelWith != null && Number.isFinite(me.duelToS)) &&
      distAhead(me.s, me.duelToS, totalLen) > 0 &&
      distAhead(me.s, me.duelToS, totalLen) < DUEL_ARC_PX;

    // more tolerant braking if we're in a duel (so we don't glue up)
    const effectiveSafeGap = duelActive ? cfg.SAFE_GAP * 0.55 : cfg.SAFE_GAP;

    if (gap < effectiveSafeGap && !sideBySideClear && !duelActive) {
      me.v = Math.max(cfg.V_MIN, me.v - cfg.BRAKE*dt*1.2);
    } else if (me.v < tv) {
      me.v = Math.min(tv, me.v + cfg.ACCEL*dt);
    } else {
      me.v = Math.max(tv, me.v - cfg.BRAKE*dt);
    }

    if (duelActive) {
      // stay committed near the inside edge (or outside if we chose that)
      const sign = me.duelSide || (pMe.ksign > 0 ? -1 : 1);
      const target = sign * width * 0.85; // close to the apex/edge
      me.targetLateral = target;
    }

    // ----- OVERTAKE / dynamic lane choice (three-wide) -----
    if ((straightish || width > CAR_ACROSS*1.30) && me.pitState==='none') {
     const usable = Math.max(0, width - CAR_ACROSS*0.55);      // smaller center margin
     const laneOffset = Math.min(usable, LANE_W*1.30);
     const lanes = (width > CAR_ACROSS*1.80)
       ? [-laneOffset, 0, laneOffset]                           // 3-wide when truly wide
       : [-laneOffset*0.9, laneOffset*0.9];                     // 2-wide on narrower

      // look ahead clearance per lane
      const laneGaps = lanes.map(L => laneAheadGap(me, order, L, 240, CAR_ACROSS, totalLen));

      // score: prefer clear air but keep lateral stability
      let bestIdx = 0, bestScore = -1e9;
      for (let i=0;i<lanes.length;i++){
        const dist = Math.abs(me.lateral - lanes[i]);
        const score = laneGaps[i] - dist*0.5;
        if (score > bestScore){ bestScore = score; bestIdx = i; }
      }

      // move only if it helps
      if (laneGaps[bestIdx] > 70) {
        me.targetLateral = lanes[bestIdx];
      } else if (ahead) {
        // try side opposite of the car ahead to peek out
        me.targetLateral = (ahead.lateral >= 0 ? -1 : 1) * laneOffset*0.85;
      }

      if (ahead && lanes.length >= 2) {
        const chosen = lanes[bestIdx];
        const sep   = Math.abs(chosen - ahead.lateral);
        if (sep > CAR_ACROSS*0.45 && gap < cfg.SAFE_GAP) {
          me.v = Math.min(tv, me.v + cfg.ACCEL*dt*0.5);
        }
      }      
    } else if (me.pitState==='none') {
      // tighter corners: blend toward center to set the car for the exit
      me.targetLateral *= 0.90;
    }

    // --- Corner pass intent: start a side-by-side duel ---
    if (!straightish && ahead) {
      const aheadTv = targetSpeedForS(ahead.s, ahead.cfg) + ahead.boost;
      const clearlyQuicker = (tv - aheadTv) > (cfg.OVERTAKE_DELTA * 0.50); // easier in corners
      const closeEnough    = gap < 140;

      if (inCorner && clearlyQuicker && closeEnough && me.duelWith == null) {
        // inside = toward apex; ksign>0 means apex is to the left of local normal (so lateral negative)
        me.duelSide = (pMe.ksign > 0 ? -1 : 1);  // choose inside by default
        me.duelToS  = (me.s + DUEL_ARC_PX) % totalLen;
        me.duelWith = ahead; // remember who we're next to
        // bias immediately to our side to get overlap
        me.targetLateral = me.duelSide * width * 0.85;
      }
    }

    // --- Duel termination conditions ---
    if (me.duelWith) {
      const stillAhead = me.duelWith && distAhead(me.s, me.duelWith.s) < DUEL_CLEAR_GAP_PX;
      const duelTimeLeft = distAhead(me.s, me.duelToS) > 0 && distAhead(me.s, me.duelToS) < DUEL_ARC_PX;

      // release if we've cleared them, fell back, or the arc is over
      if (!duelTimeLeft || !stillAhead || straightish) {
        me.duelWith = null;
        me.duelSide = 0;
        me.duelToS  = -1;
      }
    }

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
    const edgeMargin = (duelActive ? EDGE_MARGIN.duel : EDGE_MARGIN.normal);
    me.lateral = clamp(me.lateral,
      -halfWidthAt(p2.i) + CAR_ACROSS*edgeMargin,
       halfWidthAt(p2.i) - CAR_ACROSS*edgeMargin
    );
  }
}
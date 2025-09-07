// physics.mjs
import {
  SPRITE_HEADING_OFFSET, DUEL_ARC_PX, DUEL_CLEAR_GAP_PX, EDGE_MARGIN
} from './config.mjs';
import { clamp, sampleAtS, distAhead } from './util.mjs';

/**
 * One fixed-timestep physics advance for all cars.
 * S is the server-side "world" object.
 */
export function step(dt, S){
  const {
    cars, centerline, totalLen, startLineS,
    pit: { pitIds, pitIdSet, pitEntryIdx, pitExitIdx, stalls, pitLaneTargetLateral },
    halfWidthAt, straightBlend
  } = S;

  const order = [...cars].sort((a,b)=> raceDistance(b, S) - raceDistance(a, S));

  for (let oi = 0; oi < order.length; oi++){
    const me  = order[oi];
    const cfg = me.cfg;

    if (me.bestPitMs == null) me.bestPitMs = Infinity;
    if (me.topSpeed  == null) me.topSpeed  = 0;

    // previous render buffers (used by viewers for interpolation)
    me.px = me.rx; me.py = me.ry; me.pTheta = me.rTheta; me.pY = me.rY;

    // current sample on centerline from along-track coordinate
    const pMe  = sampleAtS(centerline, totalLen, me.s);
    const sNow = centerline[pMe.i].s;

    const width       = halfWidthAt(pMe.i);
    const straightish = (straightBlend(pMe.i) > 0.5) || (pMe.curv < S.STRAIGHT_THRESH*0.55);
    const inCorner    = pMe.curv > S.CORNER_PASS_K;

    // crossed start/finish?
    const crossed = crossedLine(me.prevS ?? sNow, startLineS, sNow, totalLen);
    // Do NOT count a lap while in/around the pit lane
    const allowLapCount = (me.pitState === 'none') && !me.ignoreLapAtSF;
    if (crossed && allowLapCount){
      const now   = S.clockMs;
      const lapMs = now - (me.lapStartMs || now);
      if (lapMs > 1000){
        me.lastLapMs = lapMs;
        S.lapSamples.push(lapMs);
        if (S.lapSamples.length > 40) S.lapSamples.shift();
        me.bestLapMs = Math.min(me.bestLapMs, lapMs);
      }
      me.lapStartMs   = now;
      me.lap          = (me.lap || 0) + 1;
      me.lapsSincePit = (me.lapsSincePit || 0) + 1;
    }
    me.prevS = sNow;

    // optional half-split tracking
    S.updateHalfSplit?.(S, me, pMe, S.clockMs);

    // wear / fatigue
    const wear = cfg.WEAR_RATE * dt * (0.5 + 0.5*pMe.curv*500) * (0.6 + 2.4*me.v);
    me.energy = clamp(me.energy - wear, 0, 1);
    const fatigueFactor = 0.85 + 0.15*me.energy;

    // plan to pit (decide only at S/F)
    if (crossed){
      if (me.planPitLap == null && me.lapsSincePit >= 4){
        const lapsOver     = me.lapsSincePit - 4;
        const end          = me.stats.end, risk = me.stats.rsk;
        const energyThresh = 0.30 + 0.03*lapsOver - 0.02*(end-5) - 0.02*(risk-5);
        const incidentProb = Math.min(0.50, Math.max(0, 0.03*lapsOver * (1 + 0.07*(10 - end)) * (1 - 0.05*(risk - 5))));
        if (me.energy < energyThresh || Math.random() < incidentProb){
          me.wantPit    = true;
          me.planPitLap = (me.lap || 0) + 1; // earliest legal lap is the next one
        }
      }
    }

    // car ahead & gap
    const ahead = order[(oi-1+order.length)%order.length];
    let gap     = ahead ? (ahead.s - me.s) : totalLen; if (gap < 0) gap += totalLen;

    /* ===================== PIT STATE MACHINE ===================== */

    // arm entry when on the long straight, inside the pit window
    if (me.pitState==='none' && me.wantPit && (me.lap || 0) >= (me.planPitLap ?? Infinity)){
      const onStraight = pitIdSet.has(pMe.i);
      me.targetLateral = pitLaneTargetLateral(pMe.i); // bias toward lane center immediately
      if (onStraight){
        const j = pitIds.indexOf(pMe.i);
        if (j >= pitEntryIdx && j <= pitExitIdx){
          const stall = assignPitStall(stalls);
          if (stall >= 0){
            me.pitState = 'entering';
            me.pitStall = stall;
            me.inPit    = true;
            me.ignoreLapAtSF = true; // guard laps until fully rejoined
          }
        }
      }
    }

    // passive arming based on energy if we didn't explicitly decide
    if (me.pitState==='none' && !me.wantPit){
      const baseReady = (me.lapsSincePit || 0) >= 4;
      const lowEnergy = me.energy < (0.34 - 0.02*me.stats.end + 0.02*(10 - me.stats.rsk));
      if (baseReady && lowEnergy && me.pitArmedLap == null) me.pitArmedLap = (me.lap || 0) + 1;
      if (me.pitArmedLap != null && (me.lap || 0) >= me.pitArmedLap) me.wantPit = true;
    }

    // ---- ENTERING: move in world-space toward the assigned stall, while
    // also blending (s,lateral) toward the pit-lane center so viewers that
    // still project from path won’t show cars on the racing line.
    if (me.pitState==='entering'){
      me.v = Math.min(me.v, cfg.PIT_SPEED);

      // keep path state drifting to the pit lane center
      const targetLat = pitLaneTargetLateral(pMe.i);
      const LAT_SPEED = 0.005 * dt * clamp(halfWidthAt(pMe.i), 40, 160);
      me.lateral += clamp(targetLat - me.lateral, -LAT_SPEED, LAT_SPEED);
      me.s      += me.v * dt * 0.25; // small advancement to keep ordering reasonable

      // world-space steer to the box
      const stall = stalls[me.pitStall];
      const dx = stall.x - me.rx, dy = stall.y - me.ry;
      const dist = Math.hypot(dx, dy);
      const stepLen = Math.max(0.5, me.v * dt * 2.6);
      if (dist > 2.5){
        const ux = dx / dist, uy = dy / dist;
        me.rx += ux * stepLen; me.ry += uy * stepLen;
        // heading follows lane direction
        const p = sampleAtS(centerline, totalLen, me.s);
        me.rTheta = p.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;
      } else {
        // reached stall
        me.v = 0;
        me.pitState     = 'servicing';
        me.pitStartMs   = S.clockMs;
        me.pitElapsedMs = 0;
        me.pitTargetMs  = pitBaselineMs(me.stats.pit);
        me.rx = stall.x; me.ry = stall.y; me.rTheta = stall.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;
      }
      continue;
    }

    // ---- BOX: refill, keep both world pose and path pose pinned to stall
    if (me.pitState==='servicing'){
      me.v = 0;
      me.pitElapsedMs += dt;
      me.energy = clamp(me.energy + cfg.REFILL_RATE*dt*4, 0, 1);

      const stall = stalls[me.pitStall];
      // World pose pinned:
      me.rx = stall.x; me.ry = stall.y; me.rTheta = stall.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;
      // Path pose also pinned near stall index (keeps any path-based viewers honest):
      me.s       = centerline[stall.idx].s;
      me.lateral = pitLaneTargetLateral(stall.idx);

      if (me.pitElapsedMs >= me.pitTargetMs){
        me.bestPitMs     = Math.min(me.bestPitMs, me.pitElapsedMs);
        me.pitState      = 'exiting';
        me.energy        = 1;
        me.lapsSincePit  = 0;
        me.planPitLap    = null;
        const stallIdx   = stalls[me.pitStall].idx;
        me.s             = centerline[stallIdx].s;
        me.targetLateral = pitLaneTargetLateral(stallIdx);
      }
      continue;
    }

    // ---- EXIT: project along pit lane; blend lateral back toward race line
    if (me.pitState==='exiting'){
      me.v = Math.min(cfg.PIT_SPEED*1.25, me.v + cfg.ACCEL*dt*1.6);
      const LAT_SPEED = 0.005 * dt * clamp(halfWidthAt(pMe.i), 40, 160);
      me.targetLateral += clamp(0 - me.targetLateral, -LAT_SPEED, LAT_SPEED);

      me.s += me.v * dt;
      const p = sampleAtS(centerline, totalLen, me.s);
      const nx=-Math.sin(p.theta), ny=Math.cos(p.theta);
      me.rx = p.x + nx*me.lateral;
      me.ry = p.y + ny*me.lateral;
      me.rTheta = p.theta + SPRITE_HEADING_OFFSET; me.rY = me.ry;

      const j = pitIds.indexOf(p.i);
      if (j === -1 || j > pitExitIdx){
        releasePitStall(stalls, me.pitStall);
        me.pitStall = -1;
        me.inPit    = false;
        me.wantPit  = false;
        me.pitState = 'none';
        me.lapsSincePit = 0;
        me.pitArmedLap  = null;
        me.ignoreLapAtSF = false; // safe to count laps again
      }
      continue;
    }

    /* ===================== NORMAL DRIVING ===================== */

    // target speed from curvature + fatigue + simple car-ahead logic
    const tv = targetSpeedForS(me.s, cfg, S)*fatigueFactor + (me.boost || 0);
    const sideBySideClear = ahead ? (Math.abs(me.lateral - ahead.lateral) > S.CAR_ACROSS*0.95) : false;
    const duelActive = me.duelWith != null &&
                       distAhead(me.s, me.duelToS, totalLen) > 0 &&
                       distAhead(me.s, me.duelToS, totalLen) < DUEL_ARC_PX;

    const effectiveSafeGap = duelActive ? cfg.SAFE_GAP * 0.55 : cfg.SAFE_GAP;

    if (gap < effectiveSafeGap && !sideBySideClear && !duelActive){
      me.v = Math.max(cfg.V_MIN, me.v - cfg.BRAKE*dt*1.2);
    } else if (me.v < tv){
      me.v = Math.min(tv, me.v + cfg.ACCEL*dt);
    } else {
      me.v = Math.max(tv, me.v - cfg.BRAKE*dt);
    }
    // Track top speed every tick (px/s)
    me.topSpeed = Math.max(me.topSpeed || 0, (me.v || 0) * 1000);

    if (duelActive){
      const sign = me.duelSide || (pMe.ksign > 0 ? -1 : 1);
      me.targetLateral = sign * width * 0.85;
    }

    // dynamic lanes (2- or 3-wide)
    if ((straightish || width > S.CAR_ACROSS*1.30) && me.pitState==='none'){
      const usable = Math.max(0, width - S.CAR_ACROSS*0.55);
      const laneOffset = Math.min(usable, S.LANE_W*1.30);
      const lanes = (width > S.CAR_ACROSS*1.80)
        ? [-laneOffset, 0, laneOffset]
        : [-laneOffset*0.9, laneOffset*0.9];

      const laneGaps = lanes.map(L => laneAheadGap(me, order, L, 240, S.CAR_ACROSS, totalLen));
      let bestIdx = 0, bestScore = -1e9;
      for (let i=0;i<lanes.length;i++){
        const dist = Math.abs(me.lateral - lanes[i]);
        const score = laneGaps[i] - dist*0.5;
        if (score > bestScore){ bestScore = score; bestIdx = i; }
      }
      if (laneGaps[bestIdx] > 70) me.targetLateral = lanes[bestIdx];
      else if (ahead)             me.targetLateral = (ahead.lateral >= 0 ? -1 : 1) * laneOffset*0.85;

      if (ahead && lanes.length >= 2){
        const chosen = lanes[bestIdx];
        const sep    = Math.abs(chosen - ahead.lateral);
        if (sep > S.CAR_ACROSS*0.45 && gap < cfg.SAFE_GAP){
          me.v = Math.min(tv, me.v + cfg.ACCEL*dt*0.5);
        }
      }
    } else if (me.pitState==='none'){
      me.targetLateral *= 0.90;
    }

    // corner pass intent (start a duel)
    if (!straightish && ahead){
      const aheadTv = targetSpeedForS(ahead.s, ahead.cfg, S) + (ahead.boost || 0);
      const clearlyQuicker = (tv - aheadTv) > (cfg.OVERTAKE_DELTA * 0.50);
      const closeEnough    = gap < 140;

      if (inCorner && clearlyQuicker && closeEnough && me.duelWith == null){
        me.duelSide = (pMe.ksign > 0 ? -1 : 1);
        me.duelToS  = (me.s + DUEL_ARC_PX) % totalLen;
        me.duelWith = ahead;
        me.targetLateral = me.duelSide * width * 0.85;
      }
    }

    // duel termination
    if (me.duelWith){
      const stillAhead   = me.duelWith && distAhead(me.s, me.duelWith.s, totalLen) < DUEL_CLEAR_GAP_PX;
      const duelTimeLeft = distAhead(me.s, me.duelToS, totalLen) > 0 && distAhead(me.s, me.duelToS, totalLen) < DUEL_ARC_PX;
      if (!duelTimeLeft || !stillAhead || straightish){
        me.duelWith = null; me.duelSide = 0; me.duelToS = -1;
      }
    }

    // advance along track and project world pose from (s,lateral)
    me.s += me.v * dt;
    if (me.s >= totalLen) me.s -= totalLen; // lap is counted at the line above

    const p2 = sampleAtS(centerline, totalLen, me.s);
    const nx2=-Math.sin(p2.theta), ny2=Math.cos(p2.theta);
    me.rx = p2.x + nx2*me.lateral;
    me.ry = p2.y + ny2*me.lateral;
    me.rTheta = p2.theta + SPRITE_HEADING_OFFSET;
    me.rY = me.ry;

    // lateral blend toward target with edge clamp
    const LAT = 0.005 * dt * clamp(halfWidthAt(p2.i), 40, 160);
    me.lateral += clamp(me.targetLateral - me.lateral, -LAT, LAT);
    const edgeMargin = (me.duelWith ? EDGE_MARGIN.duel : EDGE_MARGIN.normal);
    me.lateral = clamp(
      me.lateral,
      -halfWidthAt(p2.i) + S.CAR_ACROSS*edgeMargin,
       halfWidthAt(p2.i) - S.CAR_ACROSS*edgeMargin
    );
  }
}

/* ===================== helpers ===================== */

function crossedLine(prevS, lineS, nowS, totalLen){
  return (prevS <= lineS && nowS > lineS) ||
         (prevS > nowS && (prevS <= lineS || nowS > lineS));
}

function targetSpeedForS(s, cfg, S){
  const look=160, N=7;
  let k=0; for (let i=1;i<=N;i++) k += sampleAtS(S.centerline, S.totalLen, s + (i*look/N)).curv;
  k/=N;
  return clamp(cfg.V_STRAIGHT_BASE/(1 + cfg.CORNER_COEF*k), cfg.V_MIN, cfg.V_STRAIGHT_BASE*1.1);
}

function laneAheadGap(me, order, laneLat, look, CAR_ACROSS, totalLen){
  let best = look;
  for (const other of order){
    if (other === me) continue;
    const d = (other.s - me.s + totalLen) % totalLen;
    if (d <= 0 || d > look) continue;
    const sep = Math.abs(laneLat - other.lateral);
    if (sep < CAR_ACROSS*0.7) best = Math.min(best, d);
  }
  return best;
}

function assignPitStall(stalls){
  const i = stalls.findIndex(s=>!s.occupied);
  if (i >= 0) stalls[i].occupied = true;
  return i;
}
function releasePitStall(stalls, i){
  if (i>=0 && stalls[i]) stalls[i].occupied=false;
}
function pitBaselineMs(pitStat){
  const base   = 16000 * (5 / Math.max(1, pitStat));
  const jitter = base * (Math.random()*0.12 - 0.06);
  return Math.max(5000, base + jitter);
}
function raceDistance(c, S){
  return (c.lap||0) * S.totalLen + ((c.s - S.startLineS + S.totalLen) % S.totalLen);
}
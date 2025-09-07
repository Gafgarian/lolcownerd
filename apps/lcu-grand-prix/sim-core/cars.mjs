import { SPRITE_HEADING_OFFSET } from './config.mjs';

export function buildCoefficients(stats){
  const f = (x, lo=0.70, step=0.06)=> lo + step*x;
  const clip = (v,a,b)=>Math.max(a,Math.min(b,v));
  const speedF = 1.2 + 0.03*stats.spd;
  const accelF = f(stats.acc, 0.65, 0.055);
  const brakeF = 1.0;
  const cornerK= 80 / f(stats.han, 0.70, 0.06);
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

export function createCars(teams, totalLen){
  const cars = [];
  const now = Date.now();
  for(const team of teams){
    cars.push({
      team,
      s: Math.random()*totalLen, v:0.18, boost:0, lap:0,
      lateral:0, targetLateral:0,
      energy: 1,
      planPitLap: null,
      duelToS: -1,
      duelSide: 0,
      duelWith: null,
      lapsSincePit: 0,
      pitArmedLap: null,
      wantPit: false,
      inPit: false,
      pitState: 'none',
      pitStall: -1,
      pitStartMs: now,
      pitElapsedMs: 0,
      pitTargetMs: 0,
      bestPitMs: Infinity,
      lapStartMs: now,
      lastLapMs: Infinity,
      bestLapMs: Infinity,
      prevS: 0,
      px:0,py:0,pTheta:0,pY:0, rx:0,ry:0,rTheta:0,rY:0,
      stats: { spd:5, acc:5, han:5, pit:5, end:5, rsk:5 },
      cfg: {}
    });
  }
  return cars;
}

export function applyCoeffs(cars, statsById){
  const norm = (row = {}) => ({
    spd: num(row.spd, row.SPD, 5),
    acc: num(row.acc, row.ACC, 5),
    han: num(row.han, row.HAN, 5),
    pit: num(row.pit, row.PIT, 5),
    end: num(row.end, row.END, 5),
    rsk: num(row.rsk, row.RSK, 5),
  });
  function num(lo, hi, def){
    const v = lo ?? hi;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  for (const c of cars){
    const raw = statsById?.[c.team.id] || {};
    const st  = norm(raw);
    c.stats = st;
    c.cfg   = buildCoefficients(st);
  }
}
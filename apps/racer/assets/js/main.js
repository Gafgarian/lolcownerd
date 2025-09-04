import { State } from './lib/state.js';
import { GRASS_TILE } from './lib/config.js';
import { loadImage } from './lib/util.js';
import { wireControls, renderLeaderboard, drawCountdown, drawBroadcastOverlay } from './ui.js';
import { sizeCanvas, buildTrack, drawBackground, drawAsphalt, drawPitAndStart } from './track.js';
import { buildPitRoad } from './pit.js';
import { loadCarStats, setupCars, drawCars, gridCars, populateKartSelect } from './cars.js';
import { physicsStep } from './physics.js';

State.canvas = document.getElementById('racerCanvas');
State.ctx    = State.canvas.getContext('2d', { alpha:false });
State.ctx.imageSmoothingEnabled = true;
State.DPR    = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

window.addEventListener('resize', sizeCanvas, {passive:true});

const STEP=1000/120;
let accumulator=0, last=performance.now();

function frame(now){
  let dt=now - last; last=now; dt=Math.min(dt,100);
  accumulator += dt;
  let iters=0;
  while (accumulator>=STEP && iters<8){
    if (!State.paused) physicsStep(STEP, State);
    accumulator -= STEP; iters++;
  }
  const alpha = Math.min(1, accumulator / STEP);

  drawBackground();
  drawAsphalt();
  drawBroadcastOverlay(now);
  
  drawPitAndStart();
  drawCountdown(now);
  drawCars(alpha);

  renderLeaderboard(now);
  requestAnimationFrame(frame);
}

// Arrange cars in a two-row grid just behind the S/F line
function gridStart() {
  const { cars, startLineIndex, centerline, totalLen, LANE_W } = State;
  if (!cars?.length || startLineIndex == null) return;
  const baseIdx = (startLineIndex - 6 + centerline.length) % centerline.length; // a few samples behind S/F
  const rowGapS = 28 * State.DPR;     // spacing along the track
  const colOff  = LANE_W * 0.65;      // left/right offset from center
  for (let i = 0; i < cars.length; i++) {
    const row = Math.floor(i / 2);
    const col = (i % 2) ? +1 : -1;
    const idx = (baseIdx - row + centerline.length) % centerline.length;
    const p   = centerline[idx];
    const nx  = -Math.sin(p.theta), ny = Math.cos(p.theta);
    const s   = (p.s - row*rowGapS + totalLen) % totalLen;
    const lat = col * colOff;
    const x   = p.x + nx * lat;
    const y   = p.y + ny * lat;
    const c   = cars[i];
    c.s = s; c.lateral = lat; c.targetLateral = lat;
    c.rx = c.px = x; c.ry = c.py = y;
    c.rTheta = c.pTheta = p.theta + (Math.PI/2);
    c.rY = c.pY = y;
  }
}


(async function boot(){
  sizeCanvas();
  
  try {
    const grassImg = await loadImage(GRASS_TILE);
    State.grassPattern = State.ctx.createPattern(grassImg, 'repeat');
    if (State.grassPattern && State.grassPattern.setTransform && 'DOMMatrix' in window) {
      State.grassPattern.setTransform(new DOMMatrix());
    }
  } catch(e){ console.warn('Grass tile failed; fallback.', e); }

  buildTrack();
  buildPitRoad();

  await loadCarStats();
  await setupCars();

  gridCars();
  populateKartSelect();
  
  console.info('cars ready:', State.cars.length);
  
  State.paused = true;
  State.raceStarted = false;
  State.raceState = 'grid';
  wireControls();
  requestAnimationFrame(frame);
})();
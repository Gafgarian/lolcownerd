// assets/js/ui.js
import { State } from './lib/state.js';
import { SIDE } from './lib/config.js';

// --- small helpers local to this module ---
const raceDistance = (c) => (c.lap || 0) + ((c.s || 0) / Math.max(1, State.totalLen));

// leaderboard timer + cache
const LB_EVERY = 300;
let lastLB = 0;
let lbSig   = "";

// cache DOM we use here (leaderboard can stay global; HUD is safer inside wireControls)
const lbList = document.getElementById('leaderboardList');

/* ---------- COUNTDOWN ---------- */
export function runCountdown() {
  if (State.raceState !== 'grid') return;
  State.raceState = 'countdown';
  State.countdownStart = performance.now();
}

// draw the traffic lights overlay each frame (main.js will call this)
export function drawCountdown(now) {
  if (State.raceState !== 'countdown') return;
  const t = now - State.countdownStart;
  const step = Math.floor(t / 800);        // 0..3 (red, red, yellow, green)

  const ctx = State.ctx, DPR = State.DPR || 1;
  const r = 18*DPR, gap = 10*DPR;
  const cx = State.canvas.width*0.5;
  const cy = State.canvas.height*0.12;

  ctx.save();
  for (let i=0;i<4;i++){
    ctx.beginPath();
    ctx.fillStyle = (i<2 ? '#c62828' : i===2 ? '#f9a825' : '#2e7d32');
    ctx.globalAlpha = i<=step ? 0.95 : 0.25;
    ctx.arc(cx + (i-1.5)*(2*r+gap), cy, r, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.restore();

  if (t >= (State.countdownDurMs || 3200)) {
    State.raceState = 'green';
    State.paused = false;
  }
}

export function drawBroadcastOverlay(now){
  const ctx = State.ctx;
  ctx.save();
  ctx.globalAlpha = 0.85;
  const w = 280*(State.DPR||1), h = 14* (State.DPR||1) * (1 + Math.min(State.cars.length, 12));
  const x = State.canvas.width*0.06, y = State.canvas.height*0.30;
  ctx.fillStyle = '#0f1116';
  ctx.fillRect(x,y,w,h);
  ctx.fillStyle = '#d4af37';
  ctx.font = `${12*(State.DPR||1)}px system-ui, sans-serif`;
  ctx.fillText('LCU Grand Prix', x+10*(State.DPR||1), y+16*(State.DPR||1));
  ctx.restore();
}

export function wireControls(){
  const toggleBtn = document.getElementById('togglePanel');
  const sidePanel = document.getElementById('sidePanel');
  toggleBtn?.addEventListener('click', () => {
    const open = document.body.classList.toggle('panel-open');
    sidePanel?.setAttribute('aria-hidden', String(!open));
    toggleBtn.setAttribute('aria-expanded', String(open));
  });

  // START/FINISH button in the middle
  const startBtn = document.createElement('button');
  startBtn.className = 'icon-btn';
  startBtn.id = 'startBtn';
  startBtn.textContent = 'START';

  // tiny Pause button (appears after green)
  const tinyPause = document.createElement('button');
  tinyPause.className = 'icon-btn';
  tinyPause.id = 'tinyPauseBtn';
  tinyPause.style.marginLeft = '8px';
  tinyPause.style.display = 'none';
  tinyPause.textContent = 'Pause';

  // insert into HUD
  const hud = document.querySelector('.hud');
  const spacer = document.querySelector('.hud-spacer');
  const right  = document.querySelector('.hud-right');
  hud?.insertBefore(startBtn, spacer || null);
  hud?.insertBefore(tinyPause, right || null);

  // wiring (keep logic minimal; physics loop reads State.paused)
  startBtn.addEventListener('click', () => {
    if (State.raceState === 'grid') {
      runCountdown();                         // <-- THIS starts the race
      tinyPause.style.display = 'inline-block';
      startBtn.textContent = 'FINISH';
      return;
    }
    if (State.raceState === 'green' || State.raceState === 'countdown') {
      State.raceState = 'finished';
      State.paused = true;
    }
  });

  tinyPause.addEventListener('click', () => {
    State.paused = !State.paused;
    tinyPause.textContent = State.paused ? 'Resume' : 'Pause';
  });

  wirePanelControls();    
  wireKeyboardShortcuts();
  startViewerTicker();    
  wireModal();            
}

/* ---------- Panel controls ---------- */
function wirePanelControls(){
  const sel   = document.getElementById('kartSelect');
  const boost = document.getElementById('boostBtn');
  const slow  = document.getElementById('slowBtn');
  const reset = document.getElementById('resetBtn');
  const pause = document.getElementById('pauseBtn');
  const resume= document.getElementById('resumeBtn');
  const randE = document.getElementById('randomEventBtn');

  sel?.addEventListener('change', e=>{
    State.selectedCarIdx = +e.target.value||0;
  });

  const pick = ()=> State.cars[State.selectedCarIdx|0];

  boost?.addEventListener('click', ()=>{ const c=pick(); if(c) c.boost = Math.min((c.boost||0)+0.02, 0.15); });
  slow?.addEventListener('click',  ()=>{ const c=pick(); if(c) c.boost = Math.max((c.boost||0)-0.02, -0.06); });
  reset?.addEventListener('click', ()=>{ const c=pick(); if(c) c.boost = 0; });

  pause?.addEventListener('click', ()=>{ State.paused = true; });
  resume?.addEventListener('click',()=>{ State.paused = false; });

  randE?.addEventListener('click', ()=>{
    const c=pick(); if(!c) return;
    // tiny “incident”: brief speed cut
    c.boost = (Math.random() < 0.5 ? -0.05 : 0.08);
    setTimeout(()=>{ if (c) c.boost = 0; }, 2000);
  });
}

/* ---------- Keyboard shortcuts ---------- */
function wireKeyboardShortcuts(){
  window.addEventListener('keydown', (e)=>{
    const c = State.cars[State.selectedCarIdx|0];
    if(!c) return;
    if (e.key === 'ArrowUp')    { c.boost = Math.min((c.boost||0)+0.02, 0.15); }
    if (e.key === 'ArrowDown')  { c.boost = Math.max((c.boost||0)-0.02, -0.06); }
  });
}

/* ---------- Viewer ticker ---------- */
function startViewerTicker(){
  const el = document.getElementById('viewerCount');
  if (!el) return;
  const jiggle = ()=> {
    const base = 4200; // 🤘
    State.viewerCount = Math.max(0, base + Math.floor((Math.random()-0.5)*200));
    el.textContent = State.viewerCount.toLocaleString();
  };
  jiggle();
  setInterval(jiggle, 3000);
}

/* ---------- Modal (click on canvas to open) ---------- */
function wireModal(){
  const modal = document.getElementById('carModal');
  if(!modal) return;
  const open  = ()=> modal.setAttribute('aria-hidden','false');
  const close = ()=> modal.setAttribute('aria-hidden','true');
  modal.querySelectorAll('[data-close]').forEach(x=>x.addEventListener('click', close));
  modal.querySelector('.modal-backdrop')?.addEventListener('click', close);

  State.canvas.addEventListener('click', (e)=>{
    const rect = State.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (State.DPR||1);
    const y = (e.clientY - rect.top)  * (State.DPR||1);

    // pick nearest car within radius
    let best=null, bestD=1e9;
    for (const c of State.cars){
      const d = Math.hypot(x - c.rx, y - c.ry);
      if (d < bestD){ best = c; bestD = d; }
    }
    if (!best || bestD > 80*(State.DPR||1)) return;

    // populate
    document.getElementById('carModalTitle').textContent = best.team.name;
    document.getElementById('modalSideImg').src = SIDE(best.team.id);
    document.getElementById('modalTopImg').src  = best.img?.src || '';
    document.getElementById('modalLap').textContent = String(best.lap|0);
    document.getElementById('modalPos').textContent = String(
      1 + [...State.cars].sort((a,b)=> (b.lap + b.s/State.totalLen) - (a.lap + a.s/State.totalLen)).indexOf(best)
    );
    document.getElementById('modalSpd').textContent = `${(best.v*100).toFixed(1)} u/s`;
    document.getElementById('modalBoost').textContent = `${((best.boost||0)*100).toFixed(0)}%`;

    // car stats grid
    const g = document.getElementById('modalStatGrid');
    const st = best.stats || {};
    g.innerHTML = `
      <div>SPD</div><div>${st.spd??5}</div>
      <div>ACC</div><div>${st.acc??5}</div>
      <div>HAN</div><div>${st.han??5}</div>
      <div>PIT</div><div>${st.pit??5}</div>
      <div>END</div><div>${st.end??5}</div>
      <div>RSK</div><div>${st.rsk??5}</div>
    `;
    open();
  });
}

export function renderLeaderboard(now){
  if (!lbList) return;
  if (now - lastLB < LB_EVERY) return;

  const order = [...(State.cars || [])].sort((a,b)=> raceDistance(b) - raceDistance(a));
  const { totalLen, startLineS } = State;
  const wrap = (s)=> ( (s - startLineS + totalLen) % totalLen );
  const sig = order.map(c => `${c.team?.id}:${c.lap}:${Math.floor(wrap(c.s))}`).join('|');
  if (sig === lbSig) return;

  lbSig = sig; lastLB = now;

  lbList.innerHTML = order.map((c, idx) => `
    <li class="lb-item" data-team="${c.team.id}" data-pos="${idx+1}">
      <span class="lb-pos">${idx+1}</span>
      <img class="lb-car" src="${SIDE(c.team.id)}" alt="${c.team.name}" />
      <span class="lb-show" style="color:${c.team.color}">${c.team.name}</span>
      <span class="lb-name">Lap ${c.lap ?? 0}</span>
    </li>
  `).join('');
}
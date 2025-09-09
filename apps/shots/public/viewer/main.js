// --- DOM refs
const totalEl   = document.getElementById('total');
const fillEl    = document.getElementById('meterFill');
const pctEl     = document.getElementById('meterPct');     // percent label INSIDE the bar
const etaEl     = document.getElementById('eta');

const drunkTopEl = document.getElementById('drunkTop');
const shotRecEl  = document.getElementById('shotRecord');

const barScene  = document.getElementById('barScene');     // container around the bar image(s)
const hostImg   = document.getElementById('hostImg');
const lane      = document.getElementById('shotsLane');
const toastEl   = document.getElementById('toast');

// Achievements UI
const achvBtn     = document.getElementById('achvBtn');    // trophy button (positioned on bar)
const achvOverlay = document.getElementById('achvOverlay');// <div class="modal-overlay" hidden>
const achvModal   = document.getElementById('achvModal');  // the dialog card
const achvClose   = document.getElementById('achvClose');  // close (✕) button
const achvList    = document.getElementById('achvList');   // grid list inside modal

// --- Preload assets (host frames + glass) and keep a small pool for glasses
const HOST_FRAMES = Array.from({ length: 8 }, (_, i) => `/assets/hosts/buff/avatar-${i+1}.png`);
const GLASS_SRC   = '/assets/glass.png';

// image cache
HOST_FRAMES.forEach(src => { const im = new Image(); im.src = src; });
(new Image()).src = GLASS_SRC;

// pool for reusing <img class="shot">
const POOL_SIZE = 24;
const shotPool = [];
for (let i = 0; i < POOL_SIZE; i++) {
  const im = new Image();
  im.src = GLASS_SRC;
  im.className = 'shot';
  shotPool.push(im);
}
function getShot() { return shotPool.pop() || (()=>{ const im=new Image(); im.src=GLASS_SRC; im.className='shot'; return im; })(); }
function putShot(im){ if (shotPool.length < POOL_SIZE) shotPool.push(im); }

// --- Local records hydrate (best-of stats)
(function hydrateRecords(){
  const rec = localStorage.getItem('pd.shotRecord');
  const max = localStorage.getItem('pd.maxDrunkPct');
  if (rec) shotRecEl.textContent = String(Number(rec));
  if (max) drunkTopEl.textContent = `${Math.max(0, Math.min(100, Number(max))).toFixed(0)}%`;
})();

// --- State
let shownTotal = 0;          // UI-counted shots
let shownPct   = 0;          // UI drunk pct (eases toward server)
let lastHostLevel = -1;
let lastServerTotal = 0;     // authoritative server counter the UI tracks
let booted = false;

const queue = [];            // visual shot queue

// --- Meter rendering (percent text lives inside fill and rides the right edge)
function applyMeter(pct){
  pct = Math.max(0, Math.min(100, pct));
  fillEl.style.width = pct + '%';
  pctEl.textContent = `${pct.toFixed(0)}%`;

  const railW = fillEl.parentElement.getBoundingClientRect().width;
  const fillW = (pct/100) * railW;
  fillEl.parentElement.classList.toggle('meter--low', fillW < 36); // ~label width
}

// --- Host avatar by drunk level (0..7 → avatar-1..8)
function updateHostByPct(pct){
  const level = Math.min(7, Math.floor((pct / 100) * 8));
  if (level !== lastHostLevel) {
    lastHostLevel = level;
    hostImg.src = HOST_FRAMES[level];
  }
}

// --- One glass animation (comes from left/right, fades near host)
function spawnShot(){
  const laneRect  = lane.getBoundingClientRect();
  const hostRect  = hostImg.getBoundingClientRect();
  const hostCenterX = hostRect.left + hostRect.width/2 - laneRect.left;

  const fromLeft = Math.random() < 0.5;
  const startX   = fromLeft ? -40 : (laneRect.width + 40);
  const deltaX   = hostCenterX - startX;

  const y = 42 + Math.random()*20;  // sit on bar with tiny variance
  const img = getShot();
  img.style.left   = `${startX}px`;
  img.style.bottom = `${y}px`;
  lane.appendChild(img);

  // fade slightly before “impact” (offset 0.55)
  const anim = img.animate([
    { transform: 'translateX(0px)',                opacity: 0.95, offset: 0 },
    { transform: `translateX(${deltaX}px)`,        opacity: 0.95, offset: 0.55 },
    { transform: `translateX(${deltaX}px)`,        opacity: 0.00, offset: 1 }
  ], { duration: 1200, easing: 'linear', fill: 'forwards' });

  anim.onfinish = () => { img.remove(); putShot(img); };

  // tiny “sip” nudge on host
  hostImg.style.transform = 'translateY(-3px) scale(1.01)';
  setTimeout(()=> hostImg.style.transform = '', 90);
}

// --- Drain queue strictly one-at-a-time (so counts always match)
function pumpQueue(){
  if (queue.length > 0) {
    queue.shift();
    spawnShot();

    shownTotal += 1;
    totalEl.textContent = String(shownTotal);

    shownPct = Math.min(100, shownPct + (100/500));  // map 1 shot → 0.2% toward 100 (500 shots == 100%)
    applyMeter(shownPct);
    updateHostByPct(shownPct);
  }
  setTimeout(pumpQueue, 110); // ~9 shots/sec max
}
pumpQueue();

// --- Toast helper
function toast(msg){
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=> toastEl.style.display='none', 2500);
}

// --- Achievements modal (button anchored to the bar scene)
(function wireAchievements(){
  // make sure the trophy button sits over the bar scene (not the whole page)
  if (barScene && achvBtn && achvBtn.parentElement !== barScene) {
    barScene.appendChild(achvBtn);
  }

  function openAchv(){
    achvOverlay.hidden = false;
    document.body.classList.add('modal-open');
    achvClose?.focus();
  }
  function closeAchv(){
    achvOverlay.hidden = true;
    document.body.classList.remove('modal-open');
    achvBtn?.focus();
  }

  achvBtn?.addEventListener('click', openAchv);
  achvClose?.addEventListener('click', closeAchv);
  achvOverlay?.addEventListener('click', (e)=>{ if (e.target === achvOverlay) closeAchv(); });
  achvModal?.addEventListener('click', (e)=> e.stopPropagation()); // don’t bubble to overlay
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && !achvOverlay.hidden) closeAchv(); });

  // render helper
  function addAchievementTile(a, index){
    const el = document.createElement('div');
    el.className = 'ach-row';
    el.innerHTML = `
      <div class="ach-row__icon">${a.emoji || '🏆'}</div>
      <div>
        <div class="ach-row__name">${a.name}</div>
        <div class="ach-row__meta">${(a.threshold ?? 0).toLocaleString()} shots • ${new Date().toLocaleTimeString()}</div>
      </div>
      <div class="ach-row__meta">#${(index ?? 0) + 1}</div>
    `;
    achvList?.prepend(el);
  }

  // expose to onmessage scope
  window.__addAchievementTile = addAchievementTile;
})();

// --- SSE hookup (server drives truth; we only animate the DELTA)
(function connect(){
  const ev = new EventSource(`${location.origin}/api/sse/viewer`);

  ev.onmessage = (m) => {
    const s = JSON.parse(m.data);

    // first packet: hydrate from server
    if (!booted) {
      shownTotal      = Number(s.totalShots || 0);
      lastServerTotal = shownTotal;       // <- anchor server total so deltas start from now
      shownPct        = Number(s.drunkPct || 0);

      totalEl.textContent = String(shownTotal);
      applyMeter(shownPct);
      updateHostByPct(shownPct);

      // ETA chalkboard
      etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';

      booted = true;
      return;
    }

    // exact server delta only (no randomness, no double-counting)
    const serverNow   = Number(s.totalShots || 0);
    const serverDelta = Math.max(0, serverNow - lastServerTotal);
    if (serverDelta) {
      for (let i = 0; i < serverDelta; i++) queue.push(1);
      lastServerTotal = serverNow;
    }

    // update ETA chalkboard
    etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';

    // records
    if (typeof s.maxDrunkPct === 'number') drunkTopEl.textContent = `${s.maxDrunkPct.toFixed(0)}%`;
    if (typeof s.shotRecord  === 'number')  shotRecEl.textContent  = String(s.shotRecord);

    // achievement ping (one-shot payload from server)
    if (s.unlocked) {
      toast(`${s.unlocked.emoji || '🏆'} ${s.unlocked.name} — ${s.unlocked.threshold} shots`);
      window.__addAchievementTile?.(s.unlocked, s.unlocked.index);
    }

    // ease local meter toward server truth so it never drifts far
    if (typeof s.drunkPct === 'number') {
      const target = s.drunkPct;
      const diff   = target - shownPct;
      if (Math.abs(diff) > 0.2) {
        shownPct += diff * 0.15;                 // gentle ease
        shownPct = Math.max(0, Math.min(100, shownPct));
        applyMeter(shownPct);
        updateHostByPct(shownPct);
      }
    }
  };

  // auto-retry if SSE drops
  ev.onerror = () => setTimeout(connect, 1500);
})();
// --- DOM refs
const totalEl   = document.getElementById('total');
const fillEl    = document.getElementById('meterFill');
const pctEl     = document.getElementById('meterPct');     // percent label INSIDE the bar
const etaEl     = document.getElementById('eta');

const drunkTopEl = document.getElementById('drunkTop');
const shotRecEl  = document.getElementById('shotRecord');

const barScene  = document.querySelector('.left-stage');   // <- was #barScene
const hostsRow  = document.getElementById('hostsRow'); 
const lane      = document.getElementById('shotsLane');
const toastEl   = document.getElementById('toast');

// Achievements UI
const achvBtn     = document.getElementById('achvBtn');    // trophy button (positioned on bar)
const achvOverlay = document.getElementById('achvOverlay');// <div class="modal-overlay" hidden>
const achvModal   = document.getElementById('achvModal');  // the dialog card
const achvClose   = document.getElementById('achvClose');  // close (✕) button
const achvList    = document.getElementById('achvList');   // grid list inside modal

// --- Host sprite sets
// First host is Buff; second host folder is whatever you created (edit the path):
const HOSTS_META = [
  { name: 'buff',    dir: '/assets/hosts/buff'    },
  { name: 'batgirl', dir: '/assets/hosts/batgirl' } // <— rename if your folder differs
];
const HOST_FRAMES = (dir) => Array.from({ length: 8 }, (_, i) => `${dir}/avatar-${i+1}.png`);
const GLASS_SRC   = '/assets/glass.png';

// image cache
[...HOST_FRAMES(HOSTS_META[0].dir), ...HOST_FRAMES(HOSTS_META[1].dir)]
  .forEach(src => { const im = new Image(); im.src = src; });
(new Image()).src = GLASS_SRC;

// pool for reusing <img class="shot">
const POOL_SIZE = 24;
const shotPool = [];
for (let i = 0; i < POOL_SIZE; i++) {
  const im = new Image(); im.src = GLASS_SRC; im.className = 'shot'; shotPool.push(im);
}
function getShot(){ return shotPool.pop() || (()=>{ const im=new Image(); im.src=GLASS_SRC; im.className='shot'; return im; })(); }
function putShot(im){ if (shotPool.length < POOL_SIZE) shotPool.push(im); }

// --- Local records hydrate (best-of stats)
(function hydrateRecords(){
  const rec = localStorage.getItem('pd.shotRecord');
  const max = localStorage.getItem('pd.maxDrunkPct');
  if (rec) shotRecEl.textContent = String(Number(rec));
  if (max) drunkTopEl.textContent = `${Math.max(0, Math.min(100, Number(max))).toFixed(0)}%`;
})();

// Host factory
function makeHost(meta, initiallyHidden=false){
  const el = document.createElement('img');
  el.className = `host host--${meta.name}` + (initiallyHidden ? ' enter' : '');
  el.dataset.host = meta.name;                 // hook for per-host tweaks
  el.alt = meta.name;
  el.src = HOST_FRAMES(meta.dir)[0];
  hostsRow.appendChild(el);
  return { el, frames: HOST_FRAMES(meta.dir), pct: 0, level: 0, _fading:false };
}

// State
let shownTotal = 0;
let shownPct   = 0;         // combined (average) drunk percent shown in meter
let lastServerTotal = 0;
let booted = false;

// active hosts (start with the first)
const hosts = [ makeHost(HOSTS_META[0]) ];
let rr = 0;                 // round-robin cursor for shot distribution

// Ensure the guest is present (joins at 50% or when server says hostsCount=2)
function ensureGuestHost(){
  if (hosts.length >= 2) return hosts[1];

  // Nudge existing host briefly so the layout “feels” smooth
  hosts.forEach(h => {
    h.el.classList.add('make-space');
    setTimeout(() => h.el.classList.remove('make-space'), 520);
  });

  const h = makeHost(HOSTS_META[1], true);
  hosts.push(h);

  // split current combined pct across both
  hosts[0].pct = shownPct / 2;
  hosts[1].pct = shownPct / 2;

  // slower slide-in + dissolve handled by CSS classes
  requestAnimationFrame(() => {
    h.el.classList.add('active');
    setTimeout(() => h.el.classList.remove('enter','active'), 520);
  });
  return h;
}

const queue = [];            // visual shot queue

// --- Meter rendering (percent text lives inside fill and rides the right edge)
function applyMeter(pct){
  pct = Math.max(0, Math.min(100, pct));
  fillEl.style.width = pct + '%';
  pctEl.textContent = `${pct.toFixed(0)}%`;
  const railW = fillEl.parentElement.getBoundingClientRect().width;
  const fillW = (pct/100) * railW;
  fillEl.parentElement.classList.toggle('meter--low', fillW < 36);
}

// --- One glass animation (comes from left/right, fades near host)
function spawnShot(targetIdx = 0){
  const h = hosts[targetIdx] || hosts[0];
  const laneRect  = lane.getBoundingClientRect();
  const hostRect  = h.el.getBoundingClientRect();
  const hostCenterX = hostRect.left + hostRect.width/2 - laneRect.left;

  const fromLeft = Math.random() < 0.5;
  const startX   = fromLeft ? -40 : (laneRect.width + 40);
  const deltaX   = hostCenterX - startX;

  const y = 42 + Math.random()*20;
  const img = getShot();
  img.style.left = `${startX}px`;
  img.style.bottom = `${y}px`;
  lane.appendChild(img);

  const anim = img.animate([
    { transform:'translateX(0px)',         opacity:.95, offset:0    },
    { transform:`translateX(${deltaX}px)`, opacity:.95, offset:.55  },
    { transform:`translateX(${deltaX}px)`, opacity:0.00, offset:1   }
  ], { duration:1200, easing:'linear', fill:'forwards' });

  anim.onfinish = () => { img.remove(); putShot(img); };

  // tiny “sip” nudge on the drinker
  h.el.style.transform = 'translateY(-3px) scale(1.01)';
  setTimeout(()=> h.el.style.transform = '', 90);
}

function updateHostsView(){
  for (const h of hosts){
    const nextLevel = Math.min(7, Math.floor((h.pct / 100) * 8));
    if (nextLevel !== h.level){
      h.level = nextLevel;
      h.el.src = h.frames[nextLevel];   // instant swap
    }
  }
}

// --- Drain queue strictly one-at-a-time (so counts always match)

function pumpQueue(){
  if (queue.length > 0) {
    const target = queue.shift();
    spawnShot(target);

    shownTotal += 1;
    totalEl.textContent = String(shownTotal);

    // One “shot” moves *drinker* by 0.2%, and combined meter by that / hosts.length
    const perHostStep   = 100 / 500;                 // 0.2% per shot toward 100%
    const combinedStep  = perHostStep / hosts.length;

    hosts[target].pct = Math.min(100, hosts[target].pct + perHostStep);
    shownPct          = Math.min(100, shownPct + combinedStep);

    applyMeter(shownPct);
    updateHostsView();
  }
  setTimeout(pumpQueue, 110);
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
  achvModal?.addEventListener('click', (e)=> e.stopPropagation());
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && !achvOverlay.hidden) closeAchv(); });

  // helper used by SSE toast
  window.__addAchievementTile = function(a, index){
    const el = document.createElement('div');
    el.className = 'ach-row achv-card';
    el.innerHTML = `
      <div class="emoji">${a.emoji || '🏆'}</div>
      <div>
        <div class="name">${a.name}</div>
        <div class="meta">${(a.threshold ?? 0).toLocaleString()} shots • ${new Date().toLocaleTimeString()}</div>
      </div>
      <div class="badge">#${(index ?? 0) + 1}</div>
    `;
    document.getElementById('achvList')?.prepend(el);
  };
})();

// --- SSE hookup (server drives truth; we only animate the DELTA)
(function connect(){
  const ev = new EventSource(`${location.origin}/api/sse/viewer`);

  ev.onmessage = (m) => {
    const s = JSON.parse(m.data);

    // first packet: hydrate
    if (!booted) {
      shownTotal      = Number(s.totalShots || 0);
      lastServerTotal = shownTotal;
      shownPct        = Number(s.drunkPct || 0);

      // If server already says we have 2 hosts, add guest now.
      if (Number(s.hostsCount) === 2 && hosts.length < 2) ensureGuestHost();

      // split host pct(s) to match the combined bar
      if (hosts.length === 2) { hosts[0].pct = shownPct/2; hosts[1].pct = shownPct/2; }
      else { hosts[0].pct = shownPct; }

      totalEl.textContent = String(shownTotal);
      applyMeter(shownPct);
      updateHostsView();

      etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';
      booted = true;
      return;
    }

    // server delta -> schedule glasses, distribute round-robin over active hosts
    const serverNow   = Number(s.totalShots || 0);
    const serverDelta = Math.max(0, serverNow - lastServerTotal);
    if (serverDelta) {
      if (Number(s.hostsCount) === 2 && hosts.length < 2) ensureGuestHost();
      if (!('hostsCount' in s) && shownPct >= 50 && hosts.length < 2) ensureGuestHost();

      for (let i = 0; i < serverDelta; i++) {
        const target = hosts.length === 2 ? (rr++ & 1) : 0;  // 0,1,0,1,...
        queue.push(target);
      }
      lastServerTotal = serverNow;
    }

    // ETA + records
    etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';
    if (typeof s.maxDrunkPct === 'number') drunkTopEl.textContent = `${s.maxDrunkPct.toFixed(0)}%`;
    if (typeof s.shotRecord  === 'number')  shotRecEl.textContent  = String(s.shotRecord);

    // achievement toast
    if (s.unlocked) {
      toast(`${s.unlocked.emoji || '🏆'} ${s.unlocked.name} — ${s.unlocked.threshold} shots`);
      window.__addAchievementTile?.(s.unlocked, s.unlocked.index);
    }

    if (typeof s.drunkPct === 'number') {
      const target = s.drunkPct;
      const diff   = target - shownPct;
      if (Math.abs(diff) > 0.2) {
        shownPct += diff * 0.15;
        shownPct = Math.max(0, Math.min(100, shownPct));
        applyMeter(shownPct);
        updateHostsView();
      }
    }

    if (typeof s.drunkPct === 'number' && queue.length === 0 && shownPct > s.drunkPct + 1) {
      shownPct = Math.max(s.drunkPct, shownPct - 0.5);
      applyMeter(shownPct);
      updateHostsView();
    }
      // keep host pcts roughly in sync with the combined bar
    if (hosts.length === 2) {
      const split = shownPct / 2;
      hosts[0].pct += (split - hosts[0].pct) * 0.12;
      hosts[1].pct += (split - hosts[1].pct) * 0.12;
    } else {
      hosts[0].pct = shownPct;
    }
    updateHostsView();
  };

  ev.onerror = () => setTimeout(connect, 1500);
})();
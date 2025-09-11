// --- DOM refs
const totalEl   = document.getElementById('total');
const fillEl    = document.getElementById('meterFill');
const pctEl     = document.getElementById('meterPct');     // percent label INSIDE the bar
const etaEl     = document.getElementById('eta');

const drunkTopEl = document.getElementById('drunkTop');
const shotRecEl  = document.getElementById('shotRecord');

const barScene  = document.querySelector('.left-stage');
const hostsRow  = document.getElementById('hostsRow');
const lane      = document.getElementById('shotsLane');
const toastEl   = document.getElementById('toast');

// Achievements UI
const achvBtn     = document.getElementById('achvBtn');
const achvOverlay = document.getElementById('achvOverlay');
const achvModal   = document.getElementById('achvModal');
const achvClose   = document.getElementById('achvClose');
const achvList    = document.getElementById('achvList');

let lastShoutSeq = 0;

// --- Host sprite sets (order matters)
const HOSTS_META = [
  { name: 'buff',    dir: '/assets/hosts/buff'    },
  { name: 'batgirl', dir: '/assets/hosts/batgirl' },
  { name: 'stake',   dir: '/assets/hosts/stake'   },
];

const JOIN_AT = 30; // average drunk% threshold to add the next host

const HOST_FRAMES = (dir) => Array.from({ length: 8 }, (_, i) => `${dir}/avatar-${i+1}.png`);
const GLASS_SRC   = '/assets/glass.png';

// Preload all avatars + glass once
HOSTS_META.flatMap(h => HOST_FRAMES(h.dir)).forEach(src => { const im = new Image(); im.src = src; });
(new Image()).src = GLASS_SRC;

// --- helpers / math
const clamp100 = x => Math.max(0, Math.min(100, x));

// pool for reusing <img class="shot">
const POOL_SIZE = 24;
const shotPool = [];
for (let i = 0; i < POOL_SIZE; i++) {
  const im = new Image(); im.src = GLASS_SRC; im.className = 'shot'; shotPool.push(im);
}
function getShot(){ return shotPool.pop() || (()=>{ const im=new Image(); im.src=GLASS_SRC; im.className='shot'; return im; })(); }
function putShot(im){ if (shotPool.length < POOL_SIZE) shotPool.push(im); }

// Local best-of stats hydrate
(function hydrateRecords(){
  const rec = localStorage.getItem('pd.shotRecord');
  const max = localStorage.getItem('pd.maxDrunkPct');
  if (rec) shotRecEl.textContent = String(Number(rec));
  if (max) drunkTopEl.textContent = `${clamp100(Number(max)).toFixed(0)}%`;
})();

// Host factory
function makeHost(meta, initiallyHidden = false, side = '') {
  const el = document.createElement('img');
  el.className = `host host--${meta.name}${initiallyHidden ? ' enter' : ''}${side ? ' ' + side : ''}`;
  el.dataset.host = meta.name;
  el.alt = meta.name;
  el.src = HOST_FRAMES(meta.dir)[0];
  hostsRow.appendChild(el);
  return { el, frames: HOST_FRAMES(meta.dir), pct: 0, level: 0 };
}

// Ensure we have N hosts; new arrivals slide in and share current avg
function ensureHostsUpTo(n){
  n = Math.max(1, Math.min(n, HOSTS_META.length));
  while (hosts.length < n) {
    // 1) Nudge current hosts & widen the lane a touch
    hostsRow.classList.add('joining');
    hosts.forEach(h => h.el.classList.add('make-space'));
    
    const meta = HOSTS_META[hosts.length];
    const sideClass = (hosts.length % 2 === 1) ? 'from-right' : 'from-left';
    
    const h = makeHost(meta, true, sideClass);
    hosts.push(h);
    
    // split the visible % across all current hosts (start them at the average)
    const avg = shownPct / hosts.length;
    hosts.forEach(x => x.pct = avg);
    
    requestAnimationFrame(() => {
      h.el.classList.add('active');
      setTimeout(() => {
        h.el.classList.remove('enter','active','from-left','from-right');
        hosts.forEach(x => x.el.classList.remove('make-space'));
        hostsRow.classList.remove('joining');
      }, 750);
    });
  }
}

// fun shout bubble (optional)
function showShout(name){
  if (!name) return;
  const el = document.createElement('div');
  el.className = 'shout';
  if (Math.random() < 0.5) el.classList.add('right');
  el.style.top = `${8 + Math.random() * 18}%`; // 8–26% height band
  el.textContent = `“${name}!”`;
  barScene.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
  setTimeout(() => el.remove(), 3600);
}

// --- State
let shownTotal = 0;          // UI total
let shownPct   = 0;          // combined (average) drunk % in the meter
let lastServerTotal = 0;
let lastAvgEdge = 0;         // last value used for JOIN_AT rising-edge
let booted = false;

const hosts = [ makeHost(HOSTS_META[0]) ]; // start with first host
let rr = 0;                 // round-robin cursor for target selection
const queue = [];           // glasses to animate

// meter render
function applyMeter(pct){
  pct = clamp100(pct);
  fillEl.style.width = pct + '%';
  pctEl.textContent = `${pct.toFixed(0)}%`;
  const railW = fillEl.parentElement.getBoundingClientRect().width;
  const fillW = (pct/100) * railW;
  fillEl.parentElement.classList.toggle('meter--low', fillW < 36);
}

// one glass animation aimed at a host
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
    { transform:'translateX(0px)',         opacity:.95, offset:0   },
    { transform:`translateX(${deltaX}px)`, opacity:.95, offset:.70 },
    { transform:`translateX(${deltaX}px)`, opacity:0.00, offset:1  }
  ], { duration: 2000, easing: 'linear', fill: 'forwards' });

  anim.onfinish = () => { img.remove(); putShot(img); };

  // tiny “sip” nudge
  h.el.style.transform = 'translateY(-3px) scale(1.01)';
  setTimeout(()=> h.el.style.transform = '', 90);
}

// swap avatar frames immediately (no dissolve)
function updateHostsView(){
  for (const h of hosts){
    const nextLevel = Math.min(7, Math.floor((h.pct / 100) * 8));
    if (nextLevel !== h.level){
      h.level = nextLevel;
      h.el.src = h.frames[nextLevel];
    }
  }
}

// rising-edge join: when avg crosses JOIN_AT, add exactly one host
function maybeJoinByAverage() {
  if (lastAvgEdge < JOIN_AT && shownPct >= JOIN_AT && hosts.length < HOSTS_META.length) {
    ensureHostsUpTo(hosts.length + 1);
  }
  lastAvgEdge = shownPct;
}

// drain queue one-at-a-time (so counts match visuals)
function pumpQueue(){
  if (queue.length > 0) {
    const target = queue.shift();
    spawnShot(target);

    shownTotal += 1;
    totalEl.textContent = String(shownTotal);

    // 1 shot → 0.2% to the drinker; bar shows the average
    const perHostStep  = 100 / 500;                // 0.2% per shot toward 100
    const combinedStep = perHostStep / hosts.length;

    hosts[target].pct = clamp100(hosts[target].pct + perHostStep);
    shownPct          = clamp100(shownPct + combinedStep);

    applyMeter(shownPct);
    updateHostsView();
    maybeJoinByAverage();
  }
  setTimeout(pumpQueue, 110);
}
pumpQueue();

// toast
function toast(msg){
  toastEl.textContent = msg;
  toastEl.style.display = 'block';
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=> toastEl.style.display='none', 2500);
}

// achievements modal wiring
(function wireAchievements(){
  if (barScene && achvBtn && achvBtn.parentElement !== barScene) {
    barScene.appendChild(achvBtn);
  }
  function openAchv(){ achvOverlay.hidden = false; document.body.classList.add('modal-open'); achvClose?.focus(); }
  function closeAchv(){ achvOverlay.hidden = true; document.body.classList.remove('modal-open'); achvBtn?.focus(); }

  achvBtn?.addEventListener('click', openAchv);
  achvClose?.addEventListener('click', closeAchv);
  achvOverlay?.addEventListener('click', (e)=>{ if (e.target === achvOverlay) closeAchv(); });
  achvModal?.addEventListener('click', (e)=> e.stopPropagation());
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && !achvOverlay.hidden) closeAchv(); });

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
    achvList?.prepend(el);
  };
})();

// local viewer wipe when engine is unbound
function resetViewerLocal() {
  queue.length = 0;
  shownTotal   = 0;
  shownPct     = 0;
  lastAvgEdge  = 0;
  rr           = 0;

  totalEl.textContent = '0';
  applyMeter(0);

  hostsRow.innerHTML = '';
  hosts.length = 0;
  hosts.push(makeHost(HOSTS_META[0]));
  hosts[0].pct = 0;
  updateHostsView();
}

// --- SSE hookup (server drives truth; we only animate the DELTA)
(function connect(){
  const ev = new EventSource(`${location.origin}/api/sse/viewer`);

  ev.onmessage = (m) => {
    const s = JSON.parse(m.data);

    // If server says we’re unbound, wipe viewer immediately and wait for next bind
    if (!s.bound && !s.sandbox) {
      resetViewerLocal();
      etaEl.textContent = '—';
      drunkTopEl.textContent = '0%';
      shotRecEl.textContent  = '0';
      booted = false;
      return;
    }

    if (s.shout && typeof s.shout.seq === 'number' && s.shout.seq > lastShoutSeq) {
      lastShoutSeq = s.shout.seq;
      showShout(s.shout.name);
    }

    // first packet: hydrate
    if (!booted) {
      shownTotal      = Number(s.totalShots || 0);
      lastServerTotal = shownTotal;
      shownPct        = Number(s.drunkPct || 0);

      // reflect server's host count if provided
      const wantHosts = Math.max(1, Number(s.hostsCount || 1));
      ensureHostsUpTo(Math.min(wantHosts, HOSTS_META.length));

      // initialize per-host pcts to the current average
      const init = hosts.length ? (shownPct / hosts.length) : 0;
      hosts.forEach(h => h.pct = init);
      updateHostsView();

      totalEl.textContent = String(shownTotal);
      applyMeter(shownPct);
      etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';

      lastAvgEdge = shownPct;
      booted = true;
      return;
    }

    // reflect server host count growth (never shrink visually mid-stream)
    if ('hostsCount' in s) {
      const want = Math.max(1, Math.min(HOSTS_META.length, Number(s.hostsCount) || 1));
      if (want > hosts.length) ensureHostsUpTo(want);
    }

    // exact delta scheduling; distribute round-robin over active hosts
    const serverNow   = Number(s.totalShots || 0);
    const serverDelta = Math.max(0, serverNow - lastServerTotal);
    if (serverDelta) {
      for (let i = 0; i < serverDelta; i++) {
        const target = hosts.length ? (rr++ % hosts.length) : 0;
        queue.push(target);
      }
      lastServerTotal = serverNow;
    }

    // ETA + records
    etaEl.textContent = s.nextGiftEtaSec != null ? `${s.nextGiftEtaSec}s` : '—';
    if (typeof s.maxDrunkPct === 'number') drunkTopEl.textContent = `${s.maxDrunkPct.toFixed(0)}%`;
    if (typeof s.shotRecord  === 'number')  shotRecEl.textContent  = String(s.shotRecord);

    // achievements ping
    if (s.unlocked) {
      toast(`${s.unlocked.emoji || '🏆'} ${s.unlocked.name} — ${s.unlocked.threshold} shots`);
      window.__addAchievementTile?.(s.unlocked, s.unlocked.index);
    }

    // ease the meter toward server average
    if (typeof s.drunkPct === 'number') {
      const target = s.drunkPct;
      const diff   = target - shownPct;
      if (Math.abs(diff) > 0.2) {
        shownPct += diff * 0.15;
        shownPct = clamp100(shownPct);
        applyMeter(shownPct);
        updateHostsView();
      }
    }

    // gently reconcile hosts so their average matches the bar without flattening them
    if (hosts.length) {
      const curAvg = hosts.reduce((a,h)=>a + (h.pct||0), 0) / hosts.length;
      const need   = shownPct - curAvg;
      if (Math.abs(need) > 0.05) {
        const per = need / hosts.length;
        for (const h of hosts) h.pct = clamp100(h.pct + per);
        updateHostsView();
      }
    }

    // if meter is ahead and no glasses pending, drift back a touch
    if (typeof s.drunkPct === 'number' && queue.length === 0 && shownPct > s.drunkPct + 1) {
      shownPct = Math.max(s.drunkPct, shownPct - 0.5);
      applyMeter(shownPct);
      updateHostsView();
    }

    // check JOIN_AT rising edge no matter how we moved
    maybeJoinByAverage();
  };

  ev.onerror = () => setTimeout(connect, 1500);
})();
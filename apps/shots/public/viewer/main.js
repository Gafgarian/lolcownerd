// --- DOM refs
const totalEl   = document.getElementById('total');
const fillEl    = document.getElementById('meterFill');
const pctEl     = document.getElementById('meterPct');
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
  { name: 'stake',   dir: '/assets/hosts/stake'   },
  { name: 'boogie',   dir: '/assets/hosts/boogie'   },
  { name: 'batgirl', dir: '/assets/hosts/batgirl' }
];

const JOIN_AT = 30; // average drunk% threshold to add the next host

const HOST_FRAMES = (dir) => Array.from({ length: 8 }, (_, i) => `${dir}/avatar-${i+1}.png`);
const GLASS_SRC   = '/assets/glass.png';

// Preload all avatars + glass once
HOSTS_META.flatMap(h => HOST_FRAMES(h.dir)).forEach(src => { const im = new Image(); im.src = src; });
(new Image()).src = GLASS_SRC;

// --- helpers / math
const clamp100 = x => Math.max(0, Math.min(100, x));
const rand   = (min, max) => Math.random() * (max - min) + min;
const choice = (arr) => arr[(Math.random() * arr.length) | 0];

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


// === Graffiti Wall START (Viewer) =========================
const GRAFFITI_FONTS = [
  'Bitreco','Digitag','FragileBombersA','FragileBombersD','Grafipaint',
  'HoaxVandal','MarkerQueen','StreetToxicDemo','UrbanSlash','VTKSSMASH',
  '08Underground','Captions','PaintCans','Scrawler_3rd','Sprayerz','StencilDamage'
];

// Where the admin writes; accept legacy keys too (fallback only)
const GW_KEY  = 'pd.graffiti';
const GW_KEYS = [GW_KEY, 'pd.members', 'pd.gw'];

function normalizeGW(raw){
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.list)
          ? parsed.list
          : null;
    if (!arr) return [];
    return arr.map(x => ({
      name: String(x?.name ?? x?.n ?? '').trim(),
      crown: !!(x?.crown ?? x?.isCrown ?? x?.king),
    })).filter(x => x.name);
  } catch { return []; }
}
function readGWLocal(){
  for (const k of GW_KEYS) {
    const raw = localStorage.getItem(k);
    if (!raw) continue;
    const items = normalizeGW(raw);
    if (items.length) return items;
  }
  return [];
}

const graffitiLayer = document.createElement('div');
graffitiLayer.className = 'graffiti-layer';
const barFg = document.querySelector('.bar-fg');
if (barFg?.parentElement) {
  barFg.parentElement.insertBefore(graffitiLayer, barFg); // on wall (below foreground)
} else {
  document.querySelector('.left-stage')?.appendChild(graffitiLayer);
}
// === Graffiti Wall END (Viewer) ===========================


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
    hostsRow.classList.add('joining');
    hosts.forEach(h => h.el.classList.add('make-space'));
    
    const meta = HOSTS_META[hosts.length];
    const sideClass = (hosts.length % 2 === 1) ? 'from-right' : 'from-left';
    
    const h = makeHost(meta, true, sideClass);
    hosts.push(h);
    
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

// fun shout bubble
function showShout(name){
  if (!name) return;
  const el = document.createElement('div');
  el.className = 'shout';
  if (Math.random() < 0.5) el.classList.add('right');
  el.style.top = `${8 + Math.random() * 18}%`;
  el.textContent = `“${name}!”`;
  barScene.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.style.opacity = '0'; }, 2000);
  setTimeout(() => el.remove(), 3600);
}

// --- State
let shownTotal = 0;
let shownPct   = 0;
let lastServerTotal = 0;
let lastAvgEdge = 0;
let booted = false;

const hosts = [ makeHost(HOSTS_META[0]) ];
let rr = 0;
const queue = [];

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

// swap avatar frames immediately
function updateHostsView(){
  for (const h of hosts){
    const nextLevel = Math.min(7, Math.floor((h.pct / 100) * 8));
    if (nextLevel !== h.level){
      h.level = nextLevel;
      h.el.src = h.frames[nextLevel];
    }
  }
}

// rising-edge join
function maybeJoinByAverage() {
  if (lastAvgEdge < JOIN_AT && shownPct >= JOIN_AT && hosts.length < HOSTS_META.length) {
    ensureHostsUpTo(hosts.length + 1);
  }
  lastAvgEdge = shownPct;
}

// drain queue
function pumpQueue(){
  if (queue.length > 0) {
    const target = queue.shift();
    spawnShot(target);

    shownTotal += 1;
    totalEl.textContent = String(shownTotal);

    const perHostStep  = 100 / 500;
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

/* -------- Graffiti layout (safe zones + notch) -------- */
function layoutGraffiti(items){
  graffitiLayer.innerHTML = '';
  if (!items || !items.length) return;

  // crowns first, then long names
  const sorted = [...items].sort((a,b)=> (a.crown!==b.crown) ? (a.crown?-1:1) : (b.name.length - a.name.length));

  const stageRect = barScene.getBoundingClientRect();

  // Bands to avoid lights/sign (top) and counter (bottom)
  const PAD_L = 40, PAD_R = 40;
  const TOP_BAND = 0.18;
  const BOT_BAND = 0.20;
  const padTop = Math.round(stageRect.height * TOP_BAND);
  const padBot = Math.round(stageRect.height * BOT_BAND);

  // Notch where the sign is
  const notch = {
    x: Math.round(stageRect.width  * 0.06),
    y: Math.round(stageRect.height * 0.08),
    w: Math.round(stageRect.width  * 0.28),
    h: Math.round(stageRect.height * 0.22)
  };
  const NOTCH_PAD_X = 40;
  const NOTCH_PAD_Y = 56;

  // Two safe zones: right of the sign, and below the sign (left block)
  const safeZones = [];
  const rightX = Math.max(PAD_L, notch.x + notch.w + NOTCH_PAD_X);
  const safeRight = {
    x: rightX,
    y: padTop,
    w: Math.max(0, stageRect.width - PAD_R - rightX),
    h: Math.max(0, stageRect.height - padTop - padBot)
  };
  if (safeRight.w > 40 && safeRight.h > 24) safeZones.push(safeRight);

  const belowY = notch.y + notch.h + NOTCH_PAD_Y;
  const safeBelow = {
    x: PAD_L,
    y: belowY,
    w: Math.max(0, notch.x + notch.w - PAD_L),
    h: Math.max(0, stageRect.height - padBot - belowY)
  };
  if (safeBelow.w > 40 && safeBelow.h > 24) safeZones.push(safeBelow);

  // Collision helpers
  const intersects = (a, b) =>
    !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  const inflate = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2*p, h: r.h + 2*p });

  const taken = [];
  const MAX_TRIES = 120;
  const GRID = 8;
  const ROT_TWEAK = 8;
  const MIN_SHRINK = 0.85;

  for (const it of sorted){
    const tag = document.createElement('span');
    tag.className = `g-tag ${it.crown ? 'g-crown' : 'g-pig'}`;
    tag.style.fontFamily = `'${choice(GRAFFITI_FONTS)}', sans-serif`;
    tag.textContent = it.name;

    let baseSize = it.crown ? 6 : rand(2.5, 3.5);
    let unit = it.crown ? 'em' : 'rem';
    let rot = rand(-18, 18);

    let placed = false;

    for (let attempt = 0; attempt < 3 && !placed; attempt++){
      const shrink = it.crown ? 1 : Math.max(MIN_SHRINK, 1 - attempt * 0.07);
      tag.style.fontSize = `${(baseSize * shrink).toFixed(2)}${unit}`;
      tag.style.transform = `rotate(${rot.toFixed(1)}deg)`;
      graffitiLayer.appendChild(tag);

      const box = tag.getBoundingClientRect();
      const w = box.width, h = box.height;
      const PAD = Math.max(10, Math.round(h * (it.crown ? 0.24 : 0.18)));

      for (let t = 0; t < MAX_TRIES && !placed; t++){
        const zone = choice(safeZones);
        if (!zone) break;

        const x = Math.round(rand(zone.x, Math.max(zone.x, zone.x + zone.w - w)) / GRID) * GRID;
        const y = Math.round(rand(zone.y, Math.max(zone.y, zone.y + zone.h - h)) / GRID) * GRID;

        const rect = { x, y, w, h };
        const grown = inflate(rect, PAD);

        if (!taken.some(r => intersects(grown, r))){
          tag.style.left = `${x}px`;
          tag.style.top  = `${y}px`;
          taken.push(grown);
          placed = true;
          break;
        }

        if (t === (MAX_TRIES >> 1) || t === (MAX_TRIES - 1)){
          rot = Math.max(-24, Math.min(24, rot + (Math.random()<0.5?-ROT_TWEAK:ROT_TWEAK)));
          tag.style.transform = `rotate(${rot.toFixed(1)}deg)`;
          const b2 = tag.getBoundingClientRect();
          rect.w = b2.width; rect.h = b2.height;
        }
      }

      if (!placed) graffitiLayer.removeChild(tag);
    }

    if (!placed){
      const z = safeZones[0] || { x: PAD_L, y: padTop, w: stageRect.width - PAD_L - PAD_R, h: stageRect.height - padTop - padBot };
      tag.style.left = `${z.x + (taken.length * 14) % Math.max(80, z.w - 160)}px`;
      tag.style.top  = `${z.y + Math.max(0, z.h - (tag.getBoundingClientRect().height || 0) - 12)}px`;
      const bb = tag.getBoundingClientRect();
      taken.push(inflate({ x: parseFloat(tag.style.left), y: parseFloat(tag.style.top), w: bb.width, h: bb.height }, 12));
      graffitiLayer.appendChild(tag);
    }
  }
}

// hydrate on first load
layoutGraffiti(readGWLocal());
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => layoutGraffiti(readGWLocal()));
}

// live updates (fallback only)
window.addEventListener('storage', (e) => {
  if (GW_KEYS.includes(e.key)) layoutGraffiti(readGWLocal());
});
window.addEventListener('resize', () => layoutGraffiti(readGWLocal()));
// === Graffiti Wall END ================================

// ---------- Goal: UI + render ----------
const goalEl = document.getElementById('goalBar') || (() => {
  const d = document.createElement('div'); d.id = 'goalBar'; barScene.appendChild(d); return d;
})();
goalEl.innerHTML = `
  <div class="goal-title"></div>
  <div class="goal-fraction"></div>
  <div class="goal-track"><div class="goal-fill"></div></div>
`;
const goalTitleEl = goalEl.querySelector('.goal-title');
const goalFracEl  = goalEl.querySelector('.goal-fraction');
const goalFillEl  = goalEl.querySelector('.goal-fill');

function colorForTier(tier, mode){
  if (mode === 'gifting') return getComputedStyle(document.documentElement).getPropertyValue('--goal-gift') || '#8bc34a';
  const map = { blue:'--goal-blue', lblue:'--goal-lblue', green:'--goal-green', yellow:'--goal-yellow', orange:'--goal-orange', pink:'--goal-pink', red:'--goal-red' };
  const varName = map[tier] || '--goal-blue';
  return getComputedStyle(document.documentElement).getPropertyValue(varName) || '#1e88e5';
}

function readGoalLocal(){
  try { return JSON.parse(localStorage.getItem('pd.goal')||'null'); } catch { return null; }
}

function renderGoalFrom(g){
  if (!g || g.enabled === false || !Number(g.target || 0)) {
    goalEl.style.display = 'none';
    return;
  }
  const mode = g.mode || (g.kind === 'gift' ? 'gifting' : 'superchat');
  const target  = Math.max(0, Number(g.target || 0));

  const segs = Math.max(1, Math.min(50, target|0));
  goalEl.style.setProperty('--goalSegments', segs);

  const done = Math.max(0, Math.min(target, (g.progress|0)));
  const pct  = Math.max(0, Math.min(100, (done / target) * 100));

  goalTitleEl.textContent = g.title || (mode==='gifting' ? 'Gifted memberships' : 'Superchat goal');
  goalFracEl.textContent  = `${done}/${target}`;
  goalFillEl.style.width  = pct.toFixed(2) + '%';

  const col = colorForTier(g.tier || 'blue', mode);
  goalEl.style.setProperty('--goalColor', (g.color || col).trim());
  goalEl.style.display = 'block';

  maybeCelebrate(g, done, target);
}

// first render (fallback)
renderGoalFrom(readGoalLocal());
window.addEventListener('storage', (e)=>{ if (e.key === 'pd.goal') renderGoalFrom(readGoalLocal()); });

// --- “Goal reached” celebration modal ---
const CELEB_KEY = 'pd.goal.lastCelebrated';
function sigForGoal(g){
  return `${g.mode||'sc'}|${g.title||''}|${g.tier||'blue'}|${g.target||0}`;
}
function maybeCelebrate(g, done, target){
  if (done < target) return;
  const sig = sigForGoal(g);
  if (localStorage.getItem(CELEB_KEY) === sig) return;

  let overlay = document.getElementById('goalOverlay');
  if (!overlay){
    overlay = document.createElement('div');
    overlay.id = 'goalOverlay';
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,.55);
      display:grid; place-items:center; z-index:9999;
    `;
    const card = document.createElement('div');
    card.style.cssText = `
      background:#0f1422; color:#e8ecf4; border:1px solid #3a4667;
      padding:18px 22px; border-radius:14px; box-shadow:0 8px 30px rgba(0,0,0,.5);
      text-align:center; max-width:520px;
    `;
    card.innerHTML = `
      <div style="font-size:42px; line-height:1; margin-bottom:8px">🎉</div>
      <div style="font-size:20px; font-weight:700; margin-bottom:4px">Goal reached!</div>
      <div style="opacity:.85; margin-bottom:14px">${(g.title||'Stream goal')} completed — ${g.mode==='gifting'?'gifts':'superchats'} ${g.target}/${g.target}</div>
      <button id="goalOk" style="padding:10px 14px; border-radius:10px; border:1px solid #2e3a5a; background:#1b2541; color:#e8ecf4; cursor:pointer">Nice!</button>
    `;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e)=>{ if (e.target.id==='goalOk' || e.target===overlay) overlay.remove(); });
  }
  localStorage.setItem(CELEB_KEY, sig);
}

// --- SSE hookup (server drives truth; mirror GW/Goal if provided) ---
let lastGraffitiRev = null; // to avoid re-layout thrash
(function connect(){
  const ev = new EventSource(`${location.origin}/api/sse/viewer`);

  ev.onmessage = (m) => {
    const s = JSON.parse(m.data || '{}');

    if (!('totalShots' in s || 'bound' in s || 'goal' in s || 'graffiti' in s)) return;

    // ----- Graffiti: only re-render when rev/data actually changes
    if ('graffiti' in s) {
      const payload = s.graffiti;
      const items = Array.isArray(payload) ? payload : normalizeGW(payload);
      const rev = (payload && payload.rev) || JSON.stringify(items);
      if (rev !== lastGraffitiRev) {
        layoutGraffiti(items);
        lastGraffitiRev = rev;
        // persist as {items,rev} so Admin <-> Viewer storage stays in sync
        localStorage.setItem('pd.graffiti', JSON.stringify({ items, rev }));
      }
    }

    // ----- Goal: also react when it’s deleted/cleared (null)
    if ('goal' in s) {
      if (s.goal) {
        renderGoalFrom(s.goal);
        localStorage.setItem('pd.goal', JSON.stringify(s.goal));
      } else {
        localStorage.removeItem('pd.goal');
        renderGoalFrom(null); // hide
      }
    }

    // unbound → wipe viewer
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

      const wantHosts = Math.max(1, Number(s.hostsCount || 1));
      ensureHostsUpTo(Math.min(wantHosts, HOSTS_META.length));

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

    // reflect server host count growth
    if ('hostsCount' in s) {
      const want = Math.max(1, Math.min(HOSTS_META.length, Number(s.hostsCount) || 1));
      if (want > hosts.length) ensureHostsUpTo(want);
    }

    // exact delta scheduling; distribute round-robin
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

    // reconcile hosts
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

    maybeJoinByAverage();
  };

  ev.onerror = () => setTimeout(connect, 1500);
})();
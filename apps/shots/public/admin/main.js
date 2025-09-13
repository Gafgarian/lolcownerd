const API = location.origin;

/* ---------------- DOM ---------------- */
const yt       = document.getElementById('yt');
const bindBtn  = document.getElementById('bind');
const discBtn  = document.getElementById('disconnect');
const nInput   = document.getElementById('n');
const shotBtn  = document.getElementById('shot');
const giftBtn  = document.getElementById('gift');
const resetBtn = document.getElementById('resetAll');
const authorEl = document.getElementById('author');
const authorVal = () => (authorEl?.value?.trim() || 'Admin');

const statusEl = document.getElementById('status');
const engineEl = document.getElementById('engine');
const logsEl   = document.getElementById('logs');

/* header stats */
const hTotal  = document.getElementById('hTotal');
const hPct    = document.getElementById('hPct');
const hRecord = document.getElementById('hRecord');
const hMax    = document.getElementById('hMax');

/* ---- Members (Graffiti Wall) DOM ---- */
const gwName  = document.getElementById('gwName');
const gwAdd   = document.getElementById('gwAdd');
const gwList  = document.getElementById('gwList');
const gwClear = document.getElementById('gwClear');

/* ---- Goal DOM ---- */
const gTitle   = document.getElementById('gTitle');
const gMode    = document.getElementById('gMode');
const gModeLab = document.getElementById('gModeLabel');
const gTier    = document.getElementById('gTier');
const gTierWrap= document.getElementById('gTierWrap');
const gGiftsLab= document.getElementById('gGiftsLabel');
const gCount   = document.getElementById('gCount');
const gSave    = document.getElementById('gSave');
const gManual  = document.getElementById('gManual');
const gDelete  = document.getElementById('gDelete');
const prevWrap = document.getElementById('prevWrap');
const prevTitle= document.getElementById('prevTitle');
const prevFrac = document.getElementById('prevFrac');
const prevFill = document.getElementById('prevFill');

/* ---------------- cookies / keys ---------------- */
const CK_ID  = 'pd.videoId';
const CK_MAX = 'pd.maxDrunkPct';
const CK_REC = 'pd.shotRecord';
const GW_KEY = 'pd.graffiti';   // { items:[{name,crown}], rev }
const GOAL_KEY = 'pd.goal';     // { enabled, mode, title, tier, target, progress }

/* ---------------- helpers ---------------- */
const setCookie = (k, v, days = 180) =>
  (document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days*86400}; Path=/; SameSite=Lax`);
const getCookie = (k) =>
  (document.cookie.split('; ').find(s => s.startsWith(k + '='))?.split('=')[1] || '');
const delCookie = (k) =>
  (document.cookie = `${k}=; Max-Age=0; Path=/; SameSite=Lax`);

const isObj = (v) => v && typeof v === 'object';

function vidFrom(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop() || '';
  } catch { return ''; }
}
function isValidYouTube(val) {
  if (!val) return false;
  const s = String(val).trim();
  return (
    /^[A-Za-z0-9_-]{11}$/.test(s) ||
    /youtu\.be\/[A-Za-z0-9_-]{11}/.test(s) ||
    /[?&]v=[A-Za-z0-9_-]{11}/.test(s)
  );
}
function setBindDisabledByField(){ if (bindBtn && yt) bindBtn.disabled = !isValidYouTube(yt.value); }
function setBoundUI(bound) {
  const on = !!(bound && bound.video_id);
  if (discBtn)  discBtn.disabled = !on;
  if (bindBtn)  bindBtn.textContent = on ? 'Re-Bind & Start' : 'Bind & Start';
}

/* ---------------- Logs stickiness ---------------- */
let logsStick = true;
logsEl?.addEventListener('scroll', () => {
  logsStick = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 6);
}, { passive:true });

/* ---------------- Parser API (proxied) ---------------- */
async function parserActive() {
  const r = await fetch(`${API}/api/parser/active`).catch(()=>null);
  return r?.ok ? r.json() : null;
}
async function parserEnsure(youtubeUrl, opts = {}) {
  const r = await fetch(`${API}/api/parser/ensure`, {
    method: 'POST', headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ youtube: youtubeUrl, ...opts })
  });
  return r.json().catch(()=>({ ok:false, error:'bad_json' }));
}
async function waitForParser(desiredId, tries = 15, delayMs = 1500) {
  for (let i=0;i<tries;i++){
    const a = await parserActive().catch(()=>null);
    if (a?.ok && a.status === 'running' && a.videoId === desiredId) return a;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Parser didn’t come up on the requested video yet.');
}

/* ---------------- Members (Graffiti) ---------------- */
function normalizeGW(data){
  if (!data) return [];
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data.items) ? data.items
    : Array.isArray(data.list)  ? data.list : [];
  return arr
    .map(x => ({ name: String(x?.name ?? x?.n ?? '').trim(), crown: !!(x?.crown ?? x?.isCrown ?? x?.king) }))
    .filter(x => x.name.length);
}
function readGW(){
  try { return normalizeGW(JSON.parse(localStorage.getItem(GW_KEY)||'null')); }
  catch { return []; }
}
function persistGW(list){
  const payload = { items: list, rev: Date.now() };
  localStorage.setItem(GW_KEY, JSON.stringify(payload));
  // best-effort server sync
  fetch(`${API}/api/admin/graffiti/set`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ items: payload.items })
  }).catch(()=>{});
}
function sortByName(a,b){
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase(), undefined, { sensitivity:'base' });
}
function uniqueMerge(base, names){
  const have = new Set(base.map(x => x.name.toLowerCase()));
  const out = base.slice();
  for (const raw of names){
    const n = String(raw || '').trim();
    if (!n) continue;
    if (!have.has(n.toLowerCase())) { out.push({ name:n, crown:false }); have.add(n.toLowerCase()); }
  }
  return out.sort(sortByName);
}
function parseNamesInput(s){ return String(s||'').split(/[,;\n]/g).map(x => x.trim()).filter(Boolean); }
function renderGW(list = readGW()){
  const frag = document.createDocumentFragment();
  const col = document.createElement('div'); col.className = 'gw-list-inner';
  list.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'gw-item';
    row.innerHTML = `
      <span class="gw-name">${item.name}</span>
      <button class="gw-toggle" title="Toggle pig/crown" aria-label="toggle">${item.crown ? '👑' : '🐷'}</button>
      <button class="gw-del" title="Remove" aria-label="remove">✖</button>
    `;
    row.querySelector('.gw-toggle').addEventListener('click', () => {
      const cur = readGW(); cur[idx].crown = !cur[idx].crown; persistGW(cur); renderGW(cur);
    });
    row.querySelector('.gw-del').addEventListener('click', () => {
      const cur = readGW(); cur.splice(idx, 1); persistGW(cur); renderGW(cur);
    });
    frag.appendChild(row);
  });
  col.appendChild(frag);
  if (gwList) { gwList.innerHTML = ''; gwList.appendChild(col); }
}
function addNamesFromInput(){
  if (!gwName) return;
  const names = parseNamesInput(gwName.value);
  if (!names.length) return;
  const merged = uniqueMerge(readGW(), names);
  persistGW(merged); renderGW(merged);
  gwName.value = ''; gwName.focus();
}
gwAdd?.addEventListener('click', addNamesFromInput);
gwName?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNamesFromInput(); } });
gwClear?.addEventListener('click', () => {
  persistGW([]); renderGW([]);
  fetch(`${API}/api/admin/graffiti/clear`, { method:'POST' }).catch(()=>{});
});

/* ---------------- Goal storage + UI ---------------- */
function readGoal(){ try{ return JSON.parse(localStorage.getItem(GOAL_KEY)||'null'); }catch{return null;} }
function writeGoal(g, {syncInputs=true} = {}){
  localStorage.setItem(GOAL_KEY, JSON.stringify(g));
  fetch(`${API}/api/admin/goal/save`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(g)
  }).catch(()=>{});
  renderGoalPreview({syncInputs});
}
function tierColor(tier,mode){
  const s=getComputedStyle(document.documentElement);
  if(mode==='gifting') return (s.getPropertyValue('--goal-gift')||'#8bc34a').trim();
  const map={blue:'--goal-blue',lblue:'--goal-lblue',green:'--goal-green',yellow:'--goal-yellow',orange:'--goal-orange',pink:'--goal-pink',red:'--goal-red',any:'--goal-blue'};
  return (s.getPropertyValue(map[tier]||'--goal-blue')||'#1e88e5').trim();
}

/* prevent “revert while typing” */
let goalEditing = false;
let editIdleTimer = null;
function markEditing(){ goalEditing = true; clearTimeout(editIdleTimer); editIdleTimer = setTimeout(()=>goalEditing=false, 1500); }
[gTitle,gMode,gTier,gCount].forEach(el => el && el.addEventListener('input', markEditing));
[gTitle,gMode,gTier,gCount].forEach(el => el && el.addEventListener('focus', markEditing));
[gTitle,gMode,gTier,gCount].forEach(el => el && el.addEventListener('blur', ()=>{ goalEditing=false; }));

function syncModeUI(){
  const gifting = !!gMode?.checked;
  if (gModeLab) gModeLab.textContent = gifting ? 'Member gifting' : 'Superchat';
  if (gTierWrap) gTierWrap.classList.toggle('hidden', gifting);
  if (gGiftsLab) gGiftsLab.classList.toggle('hidden', !gifting);
}
gMode?.addEventListener('change', syncModeUI);

gSave?.addEventListener('click', ()=>{
  const gifting = !!gMode?.checked;
  const g = readGoal() || { enabled:true, progress:0 };
  g.enabled = true;
  g.mode = gifting ? 'gifting' : 'superchat';
  g.title = (gTitle?.value.trim()) || (g.mode==='gifting' ? 'Gifted memberships' : 'Superchat goal');
  g.tier  = gifting ? 'any' : (gTier?.value || 'blue');
  g.target= Math.max(1, Number(gCount?.value || 0) | 0);
  writeGoal(g, {syncInputs:false});
});
gManual?.addEventListener('click', ()=>{
  const g = readGoal(); if (!g?.enabled) return;
  g.progress = Math.min(g.target, (g.progress|0)+1);
  writeGoal(g, {syncInputs:false});
  fetch(`${API}/api/admin/goal/add`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ delta:1 })
  }).catch(()=>{});
});
gDelete?.addEventListener('click', ()=>{
  if(!confirm('Delete this goal?')) return;
  localStorage.removeItem(GOAL_KEY);
  fetch(`${API}/api/admin/goal/delete`, {method:'POST'}).catch(()=>{});
  renderGoalPreview({syncInputs:true});
});
function renderGoalPreview({syncInputs=true} = {}){
  const g = readGoal();
  if (!g?.enabled) {
    if (prevWrap) prevWrap.hidden = true;
    if (syncInputs || !goalEditing){
      if (gTitle) gTitle.value = '';
      if (gMode)  gMode.checked = false;
      if (gTier)  gTier.value = 'blue';
      if (gCount) gCount.value = 10;
      syncModeUI();
    }
    return;
  }
  if (prevWrap) prevWrap.hidden = false;

  const done = Math.max(0, Math.min(g.target|0, g.progress|0));
  const pct  = g.target ? (done / g.target) * 100 : 0;

  if (prevTitle) prevTitle.textContent = g.title || '';
  if (prevFrac)  prevFrac.textContent  = `${done}/${g.target}`;
  if (prevFill) {
    prevFill.style.width = pct.toFixed(2) + '%';
    prevFill.style.setProperty('--goalColor', tierColor(g.tier, g.mode));
  }

  if ((syncInputs && !goalEditing) || !document.activeElement || document.activeElement.tagName === 'BODY') {
    if (gTitle) gTitle.value = g.title || '';
    if (gMode)  gMode.checked = g.mode === 'gifting';
    if (gTier)  gTier.value = g.tier || 'blue';
    if (gCount) gCount.value = String(g.target || 10);
    syncModeUI();
  }
}

/* Increment goal meter from newly arrived log lines */
let lastLogLen = 0;
function bumpFromLogs(lines){
  const g = readGoal(); if (!g?.enabled) return;
  if (!Array.isArray(lines)) return;

  const newLines = lines.slice(lastLogLen);
  lastLogLen = lines.length;

  let bumped = 0;
  for (const line of newLines){
    const s = String(line || '');
    if (g.mode === 'superchat') {
      const isSC = /super\s*chat|paid\s*sticker|sticker/i.test(s);
      if (!isSC) continue;
      if (g.tier === 'any') bumped += 1;
      else {
        const tier = (s.match(/blue|light\s*blue|lblue|green|yellow|orange|pink|red/i)?.[0]||'').toLowerCase();
        const norm = tier === 'light blue' ? 'lblue' : tier;
        if (norm && (norm === g.tier)) bumped += 1;
      }
    } else {
      const m = s.replace(/,/g,'').match(/(?:gift(?:ed)?\s*)?(\d+)\s*memberships?/i);
      if (m) bumped += Math.max(1, parseInt(m[1], 10) || 1);
      else if (/gift(?:ed)?\s+membership/i.test(s)) bumped += 1;
    }
  }
  if (bumped) {
    const g2 = readGoal(); if (!g2) return;
    g2.progress = Math.min(g2.target, (g2.progress|0) + bumped);
    writeGoal(g2, {syncInputs:false});
    fetch(`${API}/api/admin/goal/add`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({delta:bumped})
    }).catch(()=>{});
  }
}

/* ---------------- hydrate cookies (viewer stats) ---------------- */
(function showPersistedCookies(){
  const rec = getCookie(CK_REC);
  const max = getCookie(CK_MAX);
  if (rec) localStorage.setItem('pd.shotRecord', rec);
  if (max) localStorage.setItem('pd.maxDrunkPct', max);
})();

/* ---------------- field gating ---------------- */
yt?.addEventListener('input', setBindDisabledByField);
setBindDisabledByField();
if (discBtn) discBtn.disabled = true;

/* ---------------- actions ---------------- */
resetBtn?.addEventListener('click', async () => {
  if (!confirm('Reset everything? This stops the parser, disconnects the game, and clears cookies + graffiti list + goals.')) return;
  try { await fetch(`${API}/api/admin/reset`,       { method: 'POST' }); } catch {}
  try { await fetch(`${API}/api/admin/reset-store`, { method: 'POST' }); } catch {}
  // local wipe
  delCookie(CK_ID); delCookie(CK_MAX); delCookie(CK_REC);
  localStorage.removeItem('pd.totalShots.last');
  localStorage.removeItem('pd.drunkPct.last');
  localStorage.removeItem('pd.sessionSnapshot');
  localStorage.removeItem('pd.sessionEnded');
  localStorage.removeItem('pd.shotRecord');
  localStorage.removeItem('pd.maxDrunkPct');
  localStorage.removeItem(GW_KEY);
  localStorage.removeItem(GOAL_KEY);

  if (statusEl) statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
  if (engineEl) engineEl.textContent = JSON.stringify({
    totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
  }, null, 2);
  if (logsEl) logsEl.textContent = '';
  lastLogLen = 0;
  renderGW([]);
  renderGoalPreview();
});

bindBtn?.addEventListener('click', async () => {
  const youtube = yt.value.trim();
  if (!isValidYouTube(youtube)) return alert('Enter a valid YouTube URL or 11-char video id');

  const desired = vidFrom(youtube);
  bindBtn.disabled = true;
  try {
    const active = await parserActive().catch(()=>null);
    if (active?.ok && active.status === 'running' && active.videoId && active.videoId !== desired) {
      const force = confirm(`Parser is running on ${active.videoId}.\n\nSwitch it to ${desired}?`);
      if (!force) return;
      const en = await parserEnsure(youtube, { force:true });
      if (!en?.ok) throw new Error(en?.error || 'Parser restart failed');
      await waitForParser(desired);
    } else if (!active?.ok || active.status !== 'running') {
      const en = await parserEnsure(youtube);
      if (!en?.ok) throw new Error(en?.error || 'Parser start failed');
      await waitForParser(desired);
    }

    const r = await fetch(`${API}/api/admin/bind`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ youtube })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Bind failed');

    setBoundUI({ video_id: j.bound?.video_id || desired });
    alert(`Bound to video_id: ${j.bound?.video_id || desired}`);
  } catch (e) {
    alert(e.message);
  } finally {
    setBindDisabledByField();
  }
});

discBtn?.addEventListener('click', async () => {
  if (discBtn.disabled) return;
  try {
    const r = await fetch(`${API}/api/admin/disconnect`, { method:'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Disconnect failed');

    const s   = j.snapshot || {};
    const vid = j.bound?.video_id || vidFrom(yt.value) || '';
    if (vid) {
      setCookie(CK_ID, vid);
      setCookie(CK_REC, String(s.shotRecord ?? 0));
      setCookie(CK_MAX, String(Math.round(s.maxDrunkPct ?? 0)));
    }

    if (statusEl) statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
    if (engineEl) engineEl.textContent = JSON.stringify({
      totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
    }, null, 2);
    setBoundUI(null);
    alert('Disconnected.');
  } catch (e) {
    alert(e.message);
  }
});

/* ---- test helpers (include author for shouts) ---- */
shotBtn?.addEventListener('click', async () => {
  const n = Math.max(1, Number(nInput?.value || 1) || 1);
  try {
    await fetch(`${API}/api/admin/test/shot`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ n, author: authorVal() })
    });
  } catch {}
});
giftBtn?.addEventListener('click', async () => {
  const n = Math.max(1, Number(nInput?.value || 5) || 5);
  try {
    await fetch(`${API}/api/admin/test/gift`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ n, author: authorVal() })
    });
  } catch {}
});
nInput?.addEventListener('keydown', (e)=>{ if (e.key==='Enter') shotBtn?.click(); });

/* ---------------- SSE (live admin state) ---------------- */
(function connect(){
  const ev = new EventSource(`${API}/api/sse/admin`);
  ev.onmessage = (m) => {
    try {
      const s = JSON.parse(m.data || '{}');

      if (!('totalShots' in s || 'bound' in s || 'goal' in s || 'graffiti' in s)) return;

      // header counters
      if (hTotal)  hTotal.textContent   = String(s.totalShots ?? 0);
      if (hPct)    hPct.textContent     = `${Number(s.drunkPct||0).toFixed(0)}%`;
      if (hRecord) hRecord.textContent  = String(s.shotRecord ?? 0);
      if (hMax)    hMax.textContent     = `${Number(s.maxDrunkPct||0).toFixed(0)}%`;

      // status + engine snapshot
      if (statusEl) statusEl.textContent = JSON.stringify({ bound: s.bound }, null, 2);
      if (engineEl) engineEl.textContent = JSON.stringify({
        totalShots: s.totalShots,
        drunkPct: s.drunkPct,
        activeGifts: s.activeGifts,
        nextGiftEtaSec: s.nextGiftEtaSec,
        queueDepth: s.queueDepth
      }, null, 2);

      // logs
      if (Array.isArray(s.logs)) {
        const newText = s.logs.join('\n');
        const wasStick = logsStick;
        if (logsEl && logsEl.textContent !== newText) {
          logsEl.textContent = newText;
          if (wasStick) logsEl.scrollTop = logsEl.scrollHeight;
        }
        bumpFromLogs(s.logs);
      }

      // store mirrors (don’t stomp active edits)
      if (isObj(s.goal) && !goalEditing) {
        localStorage.setItem(GOAL_KEY, JSON.stringify(s.goal));
        renderGoalPreview({syncInputs:false});
      }
      if (isObj(s.graffiti)) {
        localStorage.setItem(GW_KEY, JSON.stringify(s.graffiti));
        renderGW();
      }

      setBoundUI(s.bound);
    } catch {}
  };
  ev.onerror = () => setTimeout(connect, 1200);
})();

/* ---------------- initial render ---------------- */
renderGW();
renderGoalPreview({syncInputs:true});

// prime admin page with persisted store (helps before SSE connects)
(async function hydrateStoreOnce(){
  try {
    const [g1, g2] = await Promise.allSettled([
      fetch(`${API}/api/admin/graffiti`).then(r=>r.json()),
      fetch(`${API}/api/admin/goal`).then(r=>r.json())
    ]);
    if (g1.value?.graffiti) {
      localStorage.setItem(GW_KEY, JSON.stringify(g1.value.graffiti));
      renderGW();
    }
    if (g2.value?.goal) {
      localStorage.setItem(GOAL_KEY, JSON.stringify(g2.value.goal));
      renderGoalPreview({syncInputs:false});
    }
  } catch {}
})();
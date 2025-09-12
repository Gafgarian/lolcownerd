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

/* ---- Goal DOM (compact toggle layout) ---- */
const gTitle   = document.getElementById('gTitle');
const gMode    = document.getElementById('gMode');        // false = superchat, true = gifting
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
const GW_KEY = 'pd.graffiti';           // { items:[{name,crown}], rev }
const GOAL_KEY = 'pd.goal';             // { enabled, mode:'superchat'|'gifting', title, tier, target, progress }

/* ---------------- helpers ---------------- */
const setCookie = (k, v, days = 180) =>
  (document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days*86400}; Path=/; SameSite=Lax`);
const getCookie = (k) =>
  (document.cookie.split('; ').find(s => s.startsWith(k + '='))?.split('=')[1] || '');
const delCookie = (k) =>
  (document.cookie = `${k}=; Max-Age=0; Path=/; SameSite=Lax`);

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
function setBindDisabledByField(){ bindBtn.disabled = !isValidYouTube(yt.value); }
function setBoundUI(bound) {
  const on = !!(bound && bound.video_id);
  discBtn.disabled = !on;
  bindBtn.textContent = on ? 'Re-Bind & Start' : 'Bind & Start';
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

/* ---------------- Full reset ---------------- */
async function fullReset() {
  try { await fetch(`${API}/api/admin/reset`, { method:'POST' }); } catch {}
  // cookies
  delCookie(CK_ID); delCookie(CK_MAX); delCookie(CK_REC);
  // viewer/admin local state
  localStorage.removeItem('pd.totalShots.last');
  localStorage.removeItem('pd.drunkPct.last');
  localStorage.removeItem('pd.sessionSnapshot');
  localStorage.removeItem('pd.sessionEnded');
  localStorage.removeItem('pd.shotRecord');
  localStorage.removeItem('pd.maxDrunkPct');
  // graffiti & goal
  localStorage.removeItem(GW_KEY);
  localStorage.removeItem(GOAL_KEY);

  // UI
  statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
  engineEl.textContent = JSON.stringify({
    totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
  }, null, 2);
  logsEl.textContent = '';
  renderGW([]);
  renderGoalPreview();
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
  const payload = { items: list, rev: Date.now() }; // rev triggers viewer storage listeners
  localStorage.setItem(GW_KEY, JSON.stringify(payload));
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
function parseNamesInput(s){
  // accept comma, semicolon, newline
  return String(s||'').split(/[,;\n]/g).map(x => x.trim()).filter(Boolean);
}
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
  const names = parseNamesInput(gwName.value);
  if (!names.length) return;
  const merged = uniqueMerge(readGW(), names);
  persistGW(merged); renderGW(merged);
  gwName.value = ''; gwName.focus();
}
gwAdd?.addEventListener('click', addNamesFromInput);
gwName?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNamesFromInput(); } });
gwClear?.addEventListener('click', () => { persistGW([]); renderGW([]); });

/* ---------------- Goal storage + UI ---------------- */
function readGoal(){ try{ return JSON.parse(localStorage.getItem(GOAL_KEY)||'null'); }catch{return null;} }
function writeGoal(g){ localStorage.setItem(GOAL_KEY, JSON.stringify(g)); renderGoalPreview(); }

function tierColor(tier,mode){
  const s=getComputedStyle(document.documentElement);
  if(mode==='gifting') return s.getPropertyValue('--goal-gift')||'#8bc34a';
  const map={blue:'--goal-blue',lblue:'--goal-lblue',green:'--goal-green',yellow:'--goal-yellow',orange:'--goal-orange',pink:'--goal-pink',red:'--goal-red',any:'--goal-blue'};
  return s.getPropertyValue(map[tier]||'--goal-blue')||'#1e88e5';
}

function syncModeUI(){
  const gifting = !!gMode?.checked;
  if (gModeLab) gModeLab.textContent = gifting ? 'Member gifting' : 'Superchat';
  // Tier dropdown only for Superchat
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
  // progress is intentionally preserved on Save/Update
  writeGoal(g);
});

gManual?.addEventListener('click', ()=>{
  const g = readGoal(); if (!g?.enabled) return;
  g.progress = Math.min(g.target, (g.progress|0)+1);
  writeGoal(g);
});

gDelete?.addEventListener('click', ()=>{
  if(!confirm('Delete this goal?')) return;
  localStorage.removeItem(GOAL_KEY);
  renderGoalPreview();
});

function renderGoalPreview(){
  const g = readGoal();
  if (!g?.enabled) {
    if (prevWrap) prevWrap.hidden = true;
    // also restore UI defaults
    if (gTitle) gTitle.value = '';
    if (gMode) gMode.checked = false;
    if (gTier) gTier.value = 'blue';
    if (gCount) gCount.value = 10;
    syncModeUI();
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

  // populate current config back into form
  if (gTitle) gTitle.value = g.title || '';
  if (gMode)  gMode.checked = g.mode === 'gifting';
  if (gTier)  gTier.value = g.tier || 'blue';
  if (gCount) gCount.value = String(g.target || 10);
  syncModeUI();
}

/* Increment goal meter from new log lines only */
let lastLogLen = 0;
function bumpFromLogs(lines){
  const g = readGoal(); if (!g?.enabled) return;
  if (!Array.isArray(lines)) return;
  const newLines = lines.slice(lastLogLen);
  lastLogLen = lines.length;

  for (const line of newLines){
    const s = String(line || '');
    if (g.mode === 'superchat') {
      // treat both Super Chats and Stickers as SC
      const isSC = /super\s*chat|paid\s*sticker|sticker/i.test(s);
      if (!isSC) continue;

      if (g.tier === 'any') {
        g.progress = Math.min(g.target, (g.progress|0) + 1);
      } else {
        // look for a tier mention in the text
        const tier = (s.match(/blue|light\s*blue|lblue|green|yellow|orange|pink|red/i)?.[0]||'').toLowerCase();
        const norm = tier === 'light blue' ? 'lblue' : tier;
        if (norm && (norm === g.tier)) {
          g.progress = Math.min(g.target, (g.progress|0) + 1);
        }
      }
    } else {
      // gifting mode
      const m = s.replace(/,/g,'').match(/(?:gift(?:ed)?\s*)?(\d+)\s*memberships?/i);
      if (m) {
        const c = Math.max(1, parseInt(m[1], 10) || 1);
        g.progress = Math.min(g.target, (g.progress|0) + c);
      } else if (/gift(?:ed)?\s+membership/i.test(s)) {
        // fallback 1
        g.progress = Math.min(g.target, (g.progress|0) + 1);
      }
    }
  }
  writeGoal(g);
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
discBtn.disabled = true;

/* ---------------- actions ---------------- */
resetBtn?.addEventListener('click', async () => {
  if (!confirm('Reset everything? This stops the parser, disconnects the game, and clears cookies + graffiti list + goals.')) return;
  await fullReset();
});

bindBtn?.addEventListener('click', async () => {
  const youtube = yt.value.trim();
  if (!isValidYouTube(youtube)) return alert('Enter a valid YouTube URL or 11-char video id');

  const desired = vidFrom(youtube);
  bindBtn.disabled = true;
  try {
    const active = await parserActive().catch(()=>null);
    if (active?.ok && active.status === 'running') {
      if (active.videoId && active.videoId !== desired) {
        const force = confirm(`Parser is running on ${active.videoId}.\n\nSwitch it to ${desired}?`);
        if (!force) return;
        const en = await parserEnsure(youtube, { force:true });
        if (!en?.ok) throw new Error(en?.error || 'Parser restart failed');
        await waitForParser(desired);
      }
    } else {
      const en = await parserEnsure(youtube);
      if (!en?.ok) throw new Error(en?.error || 'Parser start failed');
      await waitForParser(desired);
    }

    // bind engine
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

    statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
    engineEl.textContent = JSON.stringify({
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
  const r = await fetch(`${API}/api/admin/test/shot`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ n, author: authorVal() })
  });
  try { await r.json(); } catch {}
});
giftBtn?.addEventListener('click', async () => {
  const n = Math.max(1, Number(nInput?.value || 5) || 5);
  const r = await fetch(`${API}/api/admin/test/gift`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ n, author: authorVal() })
  });
  try { await r.json(); } catch {}
});
nInput?.addEventListener('keydown', (e)=>{ if (e.key==='Enter') shotBtn?.click(); });

/* ---------------- SSE (live admin state) ---------------- */
(function connect(){
  const ev = new EventSource(`${API}/api/sse/admin`);
  ev.onmessage = (m) => {
    try {
      const s = JSON.parse(m.data);

      // Header mini-summary
      if (hTotal)  hTotal.textContent   = String(s.totalShots ?? 0);
      if (hPct)    hPct.textContent     = `${Number(s.drunkPct||0).toFixed(0)}%`;
      if (hRecord) hRecord.textContent  = String(s.shotRecord ?? 0);
      if (hMax)    hMax.textContent     = `${Number(s.maxDrunkPct||0).toFixed(0)}%`;

      statusEl.textContent = JSON.stringify({ bound: s.bound }, null, 2);
      engineEl.textContent = JSON.stringify({
        totalShots: s.totalShots,
        drunkPct: s.drunkPct,
        activeGifts: s.activeGifts,
        nextGiftEtaSec: s.nextGiftEtaSec,
        queueDepth: s.queueDepth
      }, null, 2);

      if (Array.isArray(s.logs)) {
        const newText = s.logs.join('\n');
        const wasStick = logsStick;
        if (logsEl.textContent !== newText) {
          logsEl.textContent = newText;
          if (wasStick) logsEl.scrollTop = logsEl.scrollHeight;
        }
        // update goal progress from only the newly arrived log lines
        bumpFromLogs(s.logs);
      }
      setBoundUI(s.bound);
    } catch {}
  };
  ev.onerror = () => setTimeout(connect, 1500);
})();

/* ---------------- initial render ---------------- */
renderGW();
renderGoalPreview();
const API = location.origin;

/* ---------------- DOM ---------------- */
const yt      = document.getElementById('yt');
const bindBtn = document.getElementById('bind');
const discBtn = document.getElementById('disconnect');
const nInput  = document.getElementById('n');
const shotBtn = document.getElementById('shot');
const giftBtn = document.getElementById('gift');
const resetBtn= document.getElementById('resetAll');
const authorEl= document.getElementById('author');
const authorVal = () => (authorEl?.value?.trim() || 'Admin');

const statusEl = document.getElementById('status');
const engineEl = document.getElementById('engine');
const logsEl   = document.getElementById('logs');

/* ---- Graffiti Wall DOM ---- */
const gwName  = document.getElementById('gwName');
const gwAdd   = document.getElementById('gwAdd');
const gwList  = document.getElementById('gwList');
const gwClear = document.getElementById('gwClear');

/* ---------------- cookies ---------------- */
const CK_ID  = 'pd.videoId';
const CK_MAX = 'pd.maxDrunkPct';
const CK_REC = 'pd.shotRecord';

const setCookie = (k, v, days = 180) =>
  document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days*86400}; Path=/; SameSite=Lax`;
const getCookie = (k) =>
  document.cookie.split('; ').find(s => s.startsWith(k + '='))?.split('=')[1] || '';
const delCookie = (k) =>
  document.cookie = `${k}=; Max-Age=0; Path=/; SameSite=Lax`;

/* ---------------- utils ---------------- */
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

/* ---------------- admin logs stickiness ---------------- */
let logsStick = true;
if (logsEl) {
  logsEl.addEventListener('scroll', () => {
    logsStick = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 6);
  }, { passive:true });
}

/* ---------------- parser helpers (proxied) ---------------- */
async function parserActive() {
  const r = await fetch(`${API}/api/parser/active`).catch(()=>null);
  return r?.ok ? r.json() : null;
}
async function parserEnsure(youtubeUrl, opts = {}) {
  const r = await fetch(`${API}/api/parser/ensure`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
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

/* ---------------- full reset (server + client + graffiti) ---------------- */
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
  // graffiti wall
  localStorage.removeItem(GW_KEY);

  // UI
  statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
  engineEl.textContent = JSON.stringify({
    totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
  }, null, 2);
  logsEl.textContent = '';
  renderGW([]);
}

/* ---------------- members (graffiti wall) ---------------- */
const GW_KEY = 'pd.graffiti';
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
  // list item template
  const frag = document.createDocumentFragment();
  const ul = document.createElement('div');
  ul.className = 'gw-list-inner';
  list.forEach((item, idx) => {
    const row = document.createElement('div');
    row.className = 'gw-item';
    row.innerHTML = `
      <span class="gw-name">${item.name}</span>
      <button class="gw-toggle" title="Toggle pig/crown" aria-label="toggle">
        ${item.crown ? '👑' : '🐷'}
      </button>
      <button class="gw-del" title="Remove" aria-label="remove">✖</button>
    `;
    // toggle
    row.querySelector('.gw-toggle').addEventListener('click', () => {
      const cur = readGW();
      cur[idx].crown = !cur[idx].crown;
      persistGW(cur);
      renderGW(cur);
    });
    // remove
    row.querySelector('.gw-del').addEventListener('click', () => {
      const cur = readGW();
      cur.splice(idx, 1);
      persistGW(cur);
      renderGW(cur);
    });
    frag.appendChild(row);
  });
  ul.appendChild(frag);
  if (gwList) {
    gwList.innerHTML = '';
    gwList.appendChild(ul);
  }
}

/* wire input */
function addNamesFromInput(){
  if (!gwName) return;
  const names = parseNamesInput(gwName.value);
  if (!names.length) return;
  const merged = uniqueMerge(readGW(), names);
  persistGW(merged);
  renderGW(merged);
  gwName.value = '';
  gwName.focus();
}
gwAdd?.addEventListener('click', addNamesFromInput);
gwName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addNamesFromInput(); }
});
gwClear?.addEventListener('click', () => {
  persistGW([]);
  renderGW([]);
});

/* ---------------- hydrate cookies (viewer stats) ---------------- */
(function showPersistedCookies(){
  const vid = decodeURIComponent(getCookie(CK_ID) || '');
  const rec = getCookie(CK_REC);
  const max = getCookie(CK_MAX);
  if (rec) localStorage.setItem('pd.shotRecord', rec);
  if (max) localStorage.setItem('pd.maxDrunkPct', max);
  // No logLine spam here; admin logs are for engine/runtime.
})();

/* ---------------- field gating ---------------- */
yt.addEventListener('input', setBindDisabledByField);
setBindDisabledByField();
discBtn.disabled = true;

/* ---------------- actions ---------------- */
resetBtn?.addEventListener('click', async () => {
  if (!confirm('Reset everything? This stops the parser, disconnects the game, and clears cookies + graffiti list.')) return;
  await fullReset();
});

bindBtn.onclick = async () => {
  const youtube = yt.value.trim();
  if (!isValidYouTube(youtube)) return alert('Enter a valid YouTube URL or 11-char video id');

  const desired = vidFrom(youtube);
  bindBtn.disabled = true;
  try {
    // if different video id persisted, clear out
    const cookieVid = decodeURIComponent(getCookie(CK_ID) || '');
    if (cookieVid && cookieVid !== desired) await fullReset();

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
};

discBtn.onclick = async () => {
  if (discBtn.disabled) return;
  try {
    const r = await fetch(`${API}/api/admin/disconnect`, { method:'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Disconnect failed');

    // Save snapshot into cookies for Viewer post-session display
    const s   = j.snapshot || {};
    const vid = j.bound?.video_id || vidFrom(yt.value) || '';
    if (vid) {
      setCookie(CK_ID, vid);
      setCookie(CK_REC, String(s.shotRecord ?? 0));
      setCookie(CK_MAX, String(Math.round(s.maxDrunkPct ?? 0)));
    }

    // Soft UI reset (don’t nuke graffiti unless user presses Reset)
    statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
    engineEl.textContent = JSON.stringify({
      totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
    }, null, 2);
    setBoundUI(null);
    alert('Disconnected.');
  } catch (e) {
    alert(e.message);
  }
};

/* ---- test helpers (include author for shouts) ---- */
shotBtn && (shotBtn.onclick = async () => {
  const n = Math.max(1, Number(nInput?.value || 1) || 1);
  const r = await fetch(`${API}/api/admin/test/shot`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ n, author: authorVal() })
  });
  try { await r.json(); } catch {}
});
giftBtn && (giftBtn.onclick = async () => {
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
      }
      setBoundUI(s.bound);
    } catch {}
  };
  ev.onerror = () => setTimeout(connect, 1500);
})();

/* ---------------- initial render of graffiti ---------------- */
renderGW(readGW());
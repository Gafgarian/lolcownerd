const API = location.origin;

/* ========================= DOM ========================= */
const yt       = document.getElementById('yt');
const bindBtn  = document.getElementById('bind');
const discBtn  = document.getElementById('disconnect');
const nInput   = document.getElementById('n');
const shotBtn  = document.getElementById('shot');
const giftBtn  = document.getElementById('gift');
const authorEl = document.getElementById('author');

const statusEl = document.getElementById('status');
const engineEl = document.getElementById('engine');
const logsEl   = document.getElementById('logs');

/* ========================= Cookies / session ========================= */
const CK_ID  = 'pd.videoId';
const CK_MAX = 'pd.maxDrunkPct';
const CK_REC = 'pd.shotRecord';
let currentVideoId = null;

/* ========================= Utils ========================= */
const authorVal = () => (authorEl?.value?.trim() || 'Admin');

function setCookie(k, v, days = 180) {
  document.cookie = `${k}=${encodeURIComponent(v)}; Max-Age=${days * 86400}; Path=/; SameSite=Lax`;
}
function getCookie(k) {
  return document.cookie.split('; ').find(s => s.startsWith(k + '='))?.split('=')[1] || '';
}
function delCookie(k) {
  document.cookie = `${k}=; Max-Age=0; Path=/; SameSite=Lax`;
}

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
function setBoundUI(bound) {
  const on = !!(bound && bound.video_id);
  discBtn.disabled = !on;
  bindBtn.textContent = on ? 'Re-Bind & Start' : 'Bind & Start';
}
function setBindDisabledByField() { bindBtn.disabled = !isValidYouTube(yt.value); }

/* ========================= Logs (sticky bottom) ========================= */
let logsStick = true;
if (logsEl) {
  logsEl.addEventListener('scroll', () => {
    logsStick = (logsEl.scrollTop + logsEl.clientHeight) >= (logsEl.scrollHeight - 8);
  });
}
function setLogs(lines) {
  if (!logsEl) return;
  const txt = (Array.isArray(lines) ? lines : []).join('\n');
  if (logsEl.textContent === txt) return;    // avoid churn
  const atBottom = logsStick;
  logsEl.textContent = txt;
  if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
}
function logLine(s) {
  if (!logsEl) return;
  const atBottom = logsStick;
  logsEl.textContent += (logsEl.textContent ? '\n' : '') + s;
  if (atBottom) logsEl.scrollTop = logsEl.scrollHeight;
}

/* ========================= Parser API (proxied) ========================= */
async function parserActive() {
  const r = await fetch(`${API}/api/parser/active`);
  return r.ok ? r.json() : null;
}
async function parserEnsure(youtubeUrl, opts = {}) {
  const r = await fetch(`${API}/api/parser/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // server accepts { youtube } (also { url } for compatibility)
    body: JSON.stringify({ youtube: youtubeUrl, ...opts })
  });
  return r.json().catch(() => ({ ok: false, error: 'bad_json' }));
}
async function waitForParser(desiredId, tries = 15, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    const a = await parserActive().catch(() => null);
    if (a?.ok && a.status === 'running' && a.videoId === desiredId) return a;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Parser didn’t come up on the requested video yet.');
}

/* ========================= Full reset (server + client) ========================= */
async function fullReset() {
  try { await fetch(`${API}/api/admin/reset`, { method: 'POST' }); } catch {}
  // wipe cookies
  delCookie(CK_ID); delCookie(CK_MAX); delCookie(CK_REC);
  // wipe viewer hydration / admin local state
  localStorage.removeItem('pd.totalShots.last');
  localStorage.removeItem('pd.drunkPct.last');
  localStorage.removeItem('pd.sessionSnapshot');
  localStorage.removeItem('pd.sessionEnded');
  localStorage.removeItem('pd.shotRecord');
  localStorage.removeItem('pd.maxDrunkPct');
  localStorage.removeItem('pd.achievements');

  statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
  engineEl.textContent = JSON.stringify({
    totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
  }, null, 2);
  setLogs([]);
  currentVideoId = null;
  logLine('[admin] Full reset complete (parser stopped, engine cleared, cookies wiped).');
}

/* ========================= Disconnect choice modal ========================= */
async function confirmDisconnect() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.55);display:grid;place-items:center;z-index:9999">
        <div style="background:#161a20;border:1px solid #2a3048;border-radius:12px;padding:16px;min-width:320px">
          <div style="font-weight:800;margin-bottom:10px">Disconnect</div>
          <div style="opacity:.85;margin-bottom:14px">Choose what to do with records for this stream.</div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button id="pdDiscReset"  style="padding:8px 10px;border-radius:8px;border:1px solid #3a425f;background:#1c2232;color:#fff">Disconnect (Reset)</button>
            <button id="pdDiscStore"  style="padding:8px 10px;border-radius:8px;border:1px solid #3a425f;background:#2a8f5a;color:#fff">Disconnect & Store</button>
          </div>
        </div>
      </div>`;
    const overlay = wrap.firstElementChild;
    document.body.appendChild(overlay);
    overlay.querySelector('#pdDiscReset').onclick = () => { overlay.remove(); resolve('reset'); };
    overlay.querySelector('#pdDiscStore').onclick = () => { overlay.remove(); resolve('store'); };
  });
}

/* ========================= Hydrate persisted cookies (viewer uses these) ========================= */
(function showPersistedCookies() {
  const vid = decodeURIComponent(getCookie(CK_ID) || '');
  const rec = getCookie(CK_REC);
  const max = getCookie(CK_MAX);
  if (rec) localStorage.setItem('pd.shotRecord', rec);
  if (max) localStorage.setItem('pd.maxDrunkPct', max);
  if (vid || rec || max) {
    logLine(`[admin] Found persisted: videoId=${vid || '—'}, recordShots=${rec || 0}, maxDrunk=${max || 0}% (applied to Viewer).`);
  }
})();

/* ========================= Field gating ========================= */
yt.addEventListener('input', setBindDisabledByField);
setBindDisabledByField();
discBtn.disabled = true;

/* ========================= Actions ========================= */
document.getElementById('resetAll')?.addEventListener('click', async () => {
  if (!confirm('Reset everything? This stops the parser, disconnects the game, and clears all cookies/logs.')) return;
  await fullReset();
});

bindBtn.onclick = async () => {
  const youtube = yt.value.trim();
  if (!isValidYouTube(youtube)) return alert('Enter a valid YouTube URL or 11-char video id');

  const desired = vidFrom(youtube);
  bindBtn.disabled = true;

  try {
    // clear persisted state if switching video
    const cookieVid = decodeURIComponent(getCookie(CK_ID) || '');
    if (cookieVid && cookieVid !== desired) {
      logLine(`[admin] Different videoId detected (saved=${cookieVid}, new=${desired}). Performing full reset…`);
      await fullReset();
    }

    // ensure parser is on the desired stream
    const active = await parserActive().catch(() => null);
    if (active?.ok && active.status === 'running') {
      if (active.videoId && active.videoId !== desired) {
        const force = confirm(
          `Parser is running on ${active.videoId}.\n\n` +
          `Switch it to ${desired}? (This will stop the current session and start the new one.)`
        );
        if (!force) return;
        logLine(`[admin] Forcing parser restart to ${desired}…`);
        const en = await parserEnsure(youtube, { force: true });
        if (!en?.ok) throw new Error(en?.error || 'Parser restart failed');
        await waitForParser(desired);
      } else {
        logLine(`[admin] Parser already running on ${desired}.`);
      }
    } else {
      logLine(`[admin] Starting parser for ${desired}…`);
      const en = await parserEnsure(youtube);
      if (!en?.ok) throw new Error(en?.error || 'Parser start failed');
      await waitForParser(desired);
    }

    // bind shots engine
    const r = await fetch(`${API}/api/admin/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ youtube })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Bind failed');

    currentVideoId = j.bound?.video_id || desired;
    setBoundUI({ video_id: currentVideoId });
    logLine(`[admin] Bound & started on ${currentVideoId}.`);
    alert(`Bound to video_id: ${currentVideoId}`);
  } catch (e) {
    alert(e.message);
    logLine(`[admin] Error: ${e.message}`);
  } finally {
    setBindDisabledByField();
  }
};

discBtn.onclick = async () => {
  if (discBtn.disabled) return;
  try {
    const choice = await confirmDisconnect(); // 'store' or 'reset'
    discBtn.disabled = true;

    const r = await fetch(`${API}/api/admin/disconnect`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Disconnect failed');

    const s   = j.snapshot || {};
    const vid = j.bound?.video_id || currentVideoId || vidFrom(yt.value) || '';

    // persist snapshot (optional post-session UI)
    localStorage.setItem('pd.sessionEnded', '1');
    localStorage.setItem('pd.sessionSnapshot', JSON.stringify({
      totalShots: s.totalShots ?? 0,
      drunkPct: s.drunkPct ?? 0,
      maxDrunkPct: s.maxDrunkPct ?? 0,
      shotRecord: s.shotRecord ?? 0,
      endedAt: new Date().toISOString()
    }));

    if (choice === 'store' && vid) {
      setCookie(CK_ID,  vid);
      setCookie(CK_REC, String(s.shotRecord ?? 0));
      setCookie(CK_MAX, String(Math.round(s.maxDrunkPct ?? 0)));
      logLine(`[admin] Saved cookies: videoId=${vid}, record=${s.shotRecord ?? 0}, max=${Math.round(s.maxDrunkPct ?? 0)}%.`);
    } else {
      await fullReset(); // wipes cookies + local state + engine
    }

    // soft reset UI when storing
    statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
    engineEl.textContent = JSON.stringify({
      totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
    }, null, 2);
    if (choice !== 'store') setLogs([]);
    setBoundUI(null);
    currentVideoId = null;

    alert(choice === 'store' ? 'Disconnected (records stored).' : 'Disconnected (everything cleared).');
  } catch (e) {
    alert(e.message);
  }
};

/* ========================= Test helpers ========================= */
shotBtn && (shotBtn.onclick = async () => {
  const n = Number(nInput?.value || 1) || 1;
  const r = await fetch(`${API}/api/admin/test/shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n, author: authorVal() })
  });
  try { await r.json(); } catch {}
});

giftBtn && (giftBtn.onclick = async () => {
  const n = Number(nInput?.value || 5) || 5;
  const r = await fetch(`${API}/api/admin/test/gift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n, author: authorVal() })
  });
  try { await r.json(); } catch {}
});

nInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') shotBtn?.click(); });

/* ========================= SSE (live admin state) ========================= */
(function connect() {
  const ev = new EventSource(`${API}/api/sse/admin`);
  ev.onmessage = (m) => {
    let s; try { s = JSON.parse(m.data); } catch { return; }

    statusEl.textContent = JSON.stringify({ bound: s.bound ?? null }, null, 2);
    engineEl.textContent = JSON.stringify({
      totalShots: s.totalShots,
      drunkPct: s.drunkPct,
      activeGifts: s.activeGifts,
      nextGiftEtaSec: s.nextGiftEtaSec,
      queueDepth: s.queueDepth
    }, null, 2);

    setLogs(s.logs);   // <- reliable, sticky-bottom behavior
    setBoundUI(s.bound);
  };
  ev.onerror = () => setTimeout(connect, 1500);
})();
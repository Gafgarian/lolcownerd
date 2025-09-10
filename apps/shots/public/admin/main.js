const API = location.origin;

// DOM
const yt        = document.getElementById('yt');
const bindBtn   = document.getElementById('bind');
const discBtn   = document.getElementById('disconnect');
const nInput    = document.getElementById('n');
const shotBtn   = document.getElementById('shot');
const giftBtn   = document.getElementById('gift');

const statusEl  = document.getElementById('status');
const engineEl  = document.getElementById('engine');
const logsEl    = document.getElementById('logs');

// ---------- helpers ----------
function vidFrom(input) {
  const s = String(input || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    return u.searchParams.get("v") || u.pathname.split("/").filter(Boolean).pop() || "";
  } catch { return ""; }
}

async function parserActive() {
  const r = await fetch(`${API}/api/parser/active`);
  return r.ok ? r.json() : null;
}

async function parserEnsure(youtubeUrl, opts = {}) {
  const r = await fetch(`${API}/api/parser/ensure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // server reads { youtube }, but still accepts { url } via the router shim
    body: JSON.stringify({ youtube: youtubeUrl, ...opts })
  });
  return r.json().catch(() => ({ ok:false, error:"bad_json" }));
}

async function waitForParser(desiredId, tries = 15, delayMs = 1500) {
  for (let i = 0; i < tries; i++) {
    const a = await parserActive().catch(()=>null);
    if (a?.ok && a.status === "running" && a.videoId === desiredId) return a;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error("Parser didn’t come up on the requested video yet.");
}

function logLine(s) {
  const el = document.getElementById("logs");
  if (!el) return;
  el.textContent += `${s}\n`;
  el.scrollTop = el.scrollHeight;
}

function isValidYouTube(val){
  if (!val) return false;
  const s = String(val).trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return true;                       // bare id
  if (/youtu\.be\/[A-Za-z0-9_-]{11}/.test(s)) return true;              // short url
  if (/[?&]v=[A-Za-z0-9_-]{11}/.test(s)) return true;                   // watch url
  return false;
}
function setBoundUI(bound){
  const on = !!(bound && bound.video_id);
  discBtn.disabled = !on;
  // keep bind enabled so user can re-bind to a new link, but switch label for clarity
  bindBtn.textContent = on ? 'Re-Bind & Start' : 'Bind & Start';
}
function setBindDisabledByField(){
  bindBtn.disabled = !isValidYouTube(yt.value);
}

// ---------- field gating ----------
yt.addEventListener('input', setBindDisabledByField);
setBindDisabledByField();   // initial
discBtn.disabled = true;    // initial

// ---------- actions ----------
bindBtn.onclick = async () => {
  const youtube = yt.value.trim();
  if (!isValidYouTube(youtube)) return alert("Enter a valid YouTube URL or 11-char video id");

  try {
    bindBtn.disabled = true;

    // 1) Ensure the parser is running on the correct video (via Shots server proxy)
    const desired = vidFrom(youtube);
    let active = await parserActive().catch(() => null);

    if (active?.ok && active.status === "running") {
      if (active.videoId && active.videoId !== desired) {
        const force = confirm(
          `Parser is running on ${active.videoId}.\n\n` +
          `Switch it to ${desired}? (This will stop the current session and start the new one.)`
        );
        if (!force) { bindBtn.disabled = false; return; }
        logLine(`[admin] Forcing parser restart to ${desired}…`);
        const en = await parserEnsure(youtube, { force:true });
        if (!en?.ok) throw new Error(en?.error || "Parser restart failed");
        await waitForParser(desired);
      } else {
        logLine(`[admin] Parser already running on ${desired}.`);
      }
    } else {
      logLine(`[admin] Starting parser for ${desired}…`);
      const en = await parserEnsure(youtube);
      if (!en?.ok) throw new Error(en?.error || "Parser start failed");
      await waitForParser(desired);
    }

    // 2) Bind Shots engine (unchanged)
    const r = await fetch(`${API}/api/admin/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ youtube })
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Bind failed");

    alert(`Bound to video_id: ${j.bound.video_id}`);
    setBoundUI(j.bound);
    logLine(`[admin] Bound & started on ${j.bound.video_id}.`);
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
    discBtn.disabled = true;
    const r = await fetch(`${API}/api/admin/disconnect`, { method: 'POST' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Disconnect failed');

    // snapshot → localStorage for viewer modal
    const s = j.snapshot || {};
    localStorage.setItem('pd.totalShots.last', String(s.totalShots ?? 0));
    localStorage.setItem('pd.drunkPct.last', String(s.drunkPct ?? 0));
    localStorage.setItem('pd.shotRecord', String(s.shotRecord ?? 0));
    localStorage.setItem('pd.maxDrunkPct', String(s.maxDrunkPct ?? 0));
    localStorage.setItem('pd.sessionEnded', '1');
    localStorage.setItem('pd.sessionSnapshot', JSON.stringify({
      totalShots: s.totalShots ?? 0,
      drunkPct: s.drunkPct ?? 0,
      maxDrunkPct: s.maxDrunkPct ?? 0,
      shotRecord: s.shotRecord ?? 0,
      endedAt: new Date().toISOString()
    }));

    // soft reset UI
    statusEl.textContent = JSON.stringify({ bound: null }, null, 2);
    engineEl.textContent = JSON.stringify({
      totalShots: 0, drunkPct: 0, activeGifts: 0, nextGiftEtaSec: null, queueDepth: 0
    }, null, 2);
    logsEl.textContent = '';
    alert('Disconnected & snapshot saved.');
    setBoundUI(null);
  } catch (e) {
    alert(e.message);
  }
};

// Test shot(s)
shotBtn && (shotBtn.onclick = async () => {
  const n = Number(nInput?.value || 1) || 1;
  const r = await fetch(`${API}/api/admin/test/shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n })
  });
  try { await r.json(); } catch {}
});

// Test gift auto
giftBtn && (giftBtn.onclick = async () => {
  const n = Number(nInput?.value || 5) || 5;
  const r = await fetch(`${API}/api/admin/test/gift`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ n })
  });
  try { await r.json(); } catch {}
});

// Enter submits +Shot(s)
nInput?.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') shotBtn.click(); });

// ---------- live state via SSE ----------
function connect() {
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
        logsEl.textContent = s.logs.join('\n');
        logsEl.scrollTop = logsEl.scrollHeight;
      }
      setBoundUI(s.bound);
    } catch {}
  };
  ev.onerror = () => setTimeout(connect, 1500);
}
connect();
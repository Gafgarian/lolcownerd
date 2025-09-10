// ===== configurable origin (local dev vs remote parser) =====
const PARSER_ORIGIN = window.PARSER_ORIGIN || window.location.origin;

// ===== UI elements =====
const input   = document.getElementById('ytUrl');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const feed    = document.getElementById('feed');

const totalSCEl    = document.getElementById('totalSC');
const totalGiftsEl = document.getElementById('totalGifts');

const totalMembersEl = document.getElementById('totalMembers');
const maxViewersEl   = document.getElementById('maxViewers');

const metaTitleEl   = document.getElementById('metaTitle');
const metaViewersEl = document.getElementById('metaViewers');

// Tier counters UI
const cBlue   = document.getElementById('cBlue');
const cLBlue  = document.getElementById('cLBlue');
const cGreen  = document.getElementById('cGreen');
const cYellow = document.getElementById('cYellow');
const cOrange = document.getElementById('cOrange');
const cPink   = document.getElementById('cPink');
const cRed    = document.getElementById('cRed');

// ===== state =====
let es = null, sessionId = null, currentVideoId = null;

// reconnection state
const MAX_RECONNECTS = 3;
let reconnectAttempts = 0;
let reconnectTimer = null;

let totalSC = 0, totalGifts = 0, totalMembers = 0, maxViewers = 0;
const tierCounters = { blue:0, lblue:0, green:0, yellow:0, orange:0, pink:0, red:0 };
let lastMeta = { title: undefined, viewers: undefined };

// ===== helpers =====
function escapeHTML(s=''){return s.replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function row(html, cls=''){ const d=document.createElement('div'); d.className=`msg ${cls}`; d.innerHTML=html; feed.prepend(d); }
function currencyFormat(n){ return `$${n.toFixed(2)}`; }

function extractVideoId(input) {
  try {
    const u = new URL(input);
    return u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
  } catch {
    // If not a URL, assume they pasted a raw ID
    return input.trim();
  }
}

function normalizeYtInput(input) {
  // Accept popout URL, watch URL, shorts/live URL, or a bare ID
  try {
    const u = new URL(input);
    const v = u.searchParams.get('v') || u.pathname.split('/').filter(Boolean).pop();
    if (!v) return null;
    return {
      videoId: v,
      watch:  `https://www.youtube.com/watch?v=${v}`,
      popout: `https://www.youtube.com/live_chat?is_popout=1&v=${v}`,
      replay: `https://www.youtube.com/live_chat_replay?is_popout=1&v=${v}`,
    };
  } catch {
    const v = String(input).trim();
    if (!v) return null;
    return {
      videoId: v,
      watch:  `https://www.youtube.com/watch?v=${v}`,
      popout: `https://www.youtube.com/live_chat?is_popout=1&v=${v}`,
      replay: `https://www.youtube.com/live_chat_replay?is_popout=1&v=${v}`,
    };
  }
}

// --- color helpers for readable text over YT colors ---
function parseRGBA(str){
  const m = String(str || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r:+m[1], g:+m[2], b:+m[3] };
}
function luminance({r,g,b}){ const L=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4};return 0.2126*L(r)+0.7152*L(g)+0.0722*L(b); }
function pickTextColor(bg){ const rgb=parseRGBA(bg); if(!rgb) return '#000'; const L=luminance(rgb);
  return (1.05)/(L+0.05) >= (L+0.05)/0.05 ? '#fff' : '#000'; }

function updateTotals(){
  totalSCEl.textContent = currencyFormat(totalSC);
  totalGiftsEl.textContent = String(totalGifts);
  if (totalMembersEl) totalMembersEl.textContent = String(totalMembers);
  if (maxViewersEl)   maxViewersEl.textContent   = (maxViewers || '—');
  cBlue.textContent=tierCounters.blue; cLBlue.textContent=tierCounters.lblue;
  cGreen.textContent=tierCounters.green; cYellow.textContent=tierCounters.yellow;
  cOrange.textContent=tierCounters.orange; cPink.textContent=tierCounters.pink; cRed.textContent=tierCounters.red;
}
function resetAll(){
  totalSC=0; totalGifts=0; totalMembers=0; maxViewers=0;
  Object.keys(tierCounters).forEach(k=>tierCounters[k]=0);
  lastMeta = { title: undefined, viewers: undefined };
  if (metaTitleEl)   metaTitleEl.textContent   = '—';
  if (metaViewersEl) metaViewersEl.textContent = '—';
  if (maxViewersEl)  maxViewersEl.textContent  = '—';
  if (totalMembersEl) totalMembersEl.textContent = '0';
  updateTotals();
  feed.innerHTML = '';
}
function setBusy(b){ startBtn.disabled = b; stopBtn.disabled = !b; }

/* ------------------------- reconnect helpers ------------------------- */

function clearReconnectTimer(){ if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer=null; } }

function scheduleReconnect() {
  reconnectAttempts += 1;
  if (reconnectAttempts > MAX_RECONNECTS) {
    verifyLiveAndMaybeBail();
    return;
  }
  const delay = Math.min(10000, 1500 * (2 ** (reconnectAttempts - 1)));
  row(`• connection lost — retry ${reconnectAttempts}/${MAX_RECONNECTS} in ${Math.round(delay/1000)}s…`, 'status');
  clearReconnectTimer();
  reconnectTimer = setTimeout(openEventStream, delay);
}

async function verifyLiveAndMaybeBail() {
  row('• checking stream status…', 'status');
  try {
    const res  = await fetch(`${PARSER_ORIGIN}/status/${encodeURIComponent(sessionId)}`);
    const json = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(json?.error || `status ${res.status}`);

    if (json.live === true) {
      row('• stream looks live — trying a clean restart once…', 'status');
      const ok = await forceRestartSession();
      if (!ok) {
        row('⚠️ Stream appears live, but reconnection failed. Please try Sync again.', 'status');
        stop();
      }
      return;
    }

    row('⚠️ Stream is unavailable or no longer live. Stopped trying to reconnect.', 'status');
    stop();
  } catch (err) {
    row(`⚠️ Could not verify stream (assuming offline): ${escapeHTML(err.message)}`, 'status');
    stop();
  }
}

async function forceRestartSession(){
  try{
    if (es) { es.close(); es=null; }
    if (sessionId) { try{ await fetch(`${PARSER_ORIGIN}/stop/${sessionId}`,{method:'POST'}) }catch{}; }
    const res = await fetch(`${PARSER_ORIGIN}/start`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ url: currentVideoId })
    });
    const json = await res.json().catch(()=>({}));
    if (!res.ok || !json.sessionId) throw new Error('could not restart');
    sessionId = json.sessionId;
    reconnectAttempts = 0;
    openEventStream();
    row('• reconnected to live stream.', 'status');
    return true;
  }catch(err){ return false; }
}

function openEventStream(){
  clearReconnectTimer();
  if (!sessionId) return;
  if (es) { es.close(); es=null; }
  es = new EventSource(`${PARSER_ORIGIN}/events/${sessionId}`);

  es.onopen = () => {
    reconnectAttempts = 0;
    row('• connected', 'status');
  };

  es.onmessage = (e)=>{
    try{
      const d = JSON.parse(e.data);
      const t = new Date(d.at || Date.now()).toLocaleTimeString();

      // server may send keepalive / hello
      if (d.type === 'hello' || d.type === 'status' || d.type === 'Connection Established') {
        row(`• ${escapeHTML(d.message || d.type)}`, 'status');
        return;
      }

      if (d.type === 'meta') {
        // title
        if (metaTitleEl && d.title && d.title !== lastMeta.title) {
          metaTitleEl.textContent = d.title; lastMeta.title = d.title;
        }

        // current viewers
        if (metaViewersEl && d.viewers !== undefined && d.viewers !== null && d.viewers !== '') {
          const n = Number(d.viewers);
          const val = Number.isFinite(n) ? n.toLocaleString() : '—';
          if (val !== metaViewersEl.textContent) {
            metaViewersEl.textContent = val; lastMeta.viewers = n;
          }
          // bump session max off live viewers if needed
          if (Number.isFinite(n) && n > maxViewers) {
            maxViewers = n;
            if (maxViewersEl) maxViewersEl.textContent = n.toLocaleString();
          }
        }

        // ⬅️ NEW: accept server-merged maxViewers (seeded from Supabase) and display it
        if (d.maxViewers !== undefined && d.maxViewers !== null && d.maxViewers !== '') {
          const mv = Number(d.maxViewers);
          if (Number.isFinite(mv) && mv >= 0 && mv !== maxViewers) {
            // take the higher of local session high-water and server merged high-water
            maxViewers = Math.max(maxViewers, mv);
            if (maxViewersEl) maxViewersEl.textContent = maxViewers.toLocaleString();
          }
        }
        return;
      }

      if (d.type === 'chat') {
        row(`<div class="row" style="padding:6px 10px; line-height:1.25">
               <span class="who">[${t}] ${escapeHTML(d.author)}</span>
               <span class="msg-txt">${escapeHTML(d.message)}</span>
             </div>`, 'chat');
        return;
      }

      if (d.type === 'superchat') {
        totalSC += Number(d.amountFloat || 0);
        const tier = d.tier || 'blue';
        tierCounters[tier] = (tierCounters[tier] || 0) + 1;
        updateTotals();

        const primary = d.color || (d.colorVars && d.colorVars.primary) || null;
        const border  = (d.colorVars && d.colorVars.secondary) || primary;
        const textClr = pickTextColor(primary || '#0c1414');
        const cardStyle = primary ?
          `style="background:${primary}; color:${textClr}; border-color:${border || primary}; padding:8px 12px;"` :
          `style="padding:8px 12px"`;
        const amountEl = `<span class="amount" style="font-weight:700; color:${textClr}; margin-left:8px;">${escapeHTML(d.amount || '$?')}</span>`;
        const msgEl = d.message ? `<div class="msg-txt">${escapeHTML(d.message)}</div>` : '';

        row(`<div class="row" ${cardStyle}>
               <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                 <span class="who" style="color:${textClr}; font-weight:600;">[${t}] ${escapeHTML(d.author)}</span>
                 ${amountEl}
               </div>
               ${msgEl}
             </div>`);
        return;
      }

      if (d.type === 'gift') {
        const c = Number(d.count || 1);
        totalGifts += c; updateTotals();
        row(`<div class="row" style="padding:8px 12px">
               <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                 <span class="who">[${t}] ${escapeHTML(d.author)}</span>
                 <span>🎁 <b>${c}</b> membership${c>1?'s':''}</span>
               </div>
             </div>`, 'member');
        return;
      }

      if (d.type === 'membership') {
        totalMembers += 1; updateTotals();
        row(`<div class="row" style="padding:8px 12px">
               <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                 <span class="who">[${t}] ${escapeHTML(d.author)}</span>
                 <span>🟢 ${escapeHTML(d.header || 'New member')}</span>
               </div>
               ${d.message ? `<div class="msg-txt">${escapeHTML(d.message)}</div>` : ''}
             </div>`, 'member');
        return;
      }

      if (d.type === 'milestone') {
        const extra = d.months ? ` (${d.months} month${d.months>1?'s':''})` : '';
        row(`<div class="row" style="padding:8px 12px">
               <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                 <span class="who">[${t}] ${escapeHTML(d.author)}</span>
                 <span>🏅 ${escapeHTML(d.header || 'Milestone')}${extra}</span>
               </div>
               ${d.message ? `<div class="msg-txt">${escapeHTML(d.message)}</div>` : ''}
             </div>`, 'member');
        return;
      }
    }catch(err){
      row(`• parse error: ${escapeHTML(err.message)}`,'status');
    }
  };

  es.onerror = () => {
    // Important: EventSource auto-reconnects by default.
    // We explicitly close it and control limited retries.
    if (es) es.close();
    scheduleReconnect();
  };
}

/* ------------------------------- lifecycle -------------------------------- */

async function start(){
  const raw = input.value.trim();
  if (!raw) return alert('Paste a YouTube URL or video ID first.');

  const norm = normalizeYtInput(raw);
  if (!norm) { row('⚠️ Could not parse a video ID from that input.','status'); return; }

  currentVideoId = norm.videoId;

  resetAll();
  setBusy(true);
  reconnectAttempts = 0;
  clearReconnectTimer();

  row(`• using chat=${escapeHTML(norm.popout)} and meta=${escapeHTML(norm.watch)}`, 'status');

  if (es) { es.close(); es=null; }
  if (sessionId) { try{ await fetch(`${PARSER_ORIGIN}/stop/${sessionId}`,{method:'POST'}) }catch{}; sessionId=null; }

  try{
    const res  = await fetch(`${PARSER_ORIGIN}/start`,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ url: currentVideoId })
    });
    const json = await res.json().catch(()=>({}));

    if(!res.ok || !json.sessionId){
      if (res.status === 429 && json?.error === 'too_many_sessions') {
        row('⚠️ Service is already scraping one video. Stop that session first.','status');
      } else {
        row(`⚠️ Failed to start: ${escapeHTML(JSON.stringify(json))}`,'status');
      }
      setBusy(false);
      return;
    }

    sessionId = json.sessionId;
    openEventStream();
  }catch(err){
    row(`⚠️ Network error: ${escapeHTML(err.message)}`,'status');
    setBusy(false);
  }
}

async function stop(){
  clearReconnectTimer();
  if (es) { es.close(); es=null; }
  if (sessionId) {
    try{ await fetch(`${PARSER_ORIGIN}/stop/${sessionId}`,{method:'POST'}) }catch{};
    row(`• stopped session ${sessionId}`,'status');
    sessionId=null;
  }
  setBusy(false);
}

/* --------------------------------- wiring --------------------------------- */

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
input.addEventListener('keydown', e => { if(e.key==='Enter') start(); });

// ensure cleanup when navigating away (helps Render stay stable)
window.addEventListener('beforeunload', () => {
  if (sessionId) navigator.sendBeacon?.(`${PARSER_ORIGIN}/stop/${sessionId}`);
});
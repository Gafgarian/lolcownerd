// ===== configurable origin (local dev vs remote parser) =====
const PARSER_ORIGIN = window.PARSER_ORIGIN || window.location.origin;

// ===== UI elements =====
const input   = document.getElementById('ytUrl');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const feed    = document.getElementById('feed');

const totalSCEl    = document.getElementById('totalSC');
const totalGiftsEl = document.getElementById('totalGifts');

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
let es = null, sessionId = null;
let totalSC = 0;
let totalGifts = 0;
const tierCounters = { blue:0, lblue:0, green:0, yellow:0, orange:0, pink:0, red:0 };
let lastMeta = { title: undefined, viewers: undefined }; // <-- track last shown

// ===== helpers =====
function escapeHTML(s=''){return s.replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function row(html, cls=''){ const d=document.createElement('div'); d.className=`msg ${cls}`; d.innerHTML=html; feed.prepend(d); }
function currencyFormat(n){ return `$${n.toFixed(2)}`; }

// --- color helpers for readable text over YT colors ---
function parseRGBA(str){
  const m = String(str || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r:+m[1], g:+m[2], b:+m[3] };
}
function luminance({r,g,b}){
  const toLin = v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); };
  const R=toLin(r), G=toLin(g), B=toLin(b);
  return 0.2126*R + 0.7152*G + 0.0722*B;
}
function pickTextColor(bg){
  const rgb = parseRGBA(bg);
  if (!rgb) return '#000';
  const L = luminance(rgb);
  const contrastWhite = (1.05) / (L + 0.05);
  const contrastBlack = (L + 0.05) / 0.05;
  return contrastWhite >= contrastBlack ? '#fff' : '#000';
}

function updateTotals(){
  totalSCEl.textContent    = currencyFormat(totalSC);
  totalGiftsEl.textContent = String(totalGifts);
  cBlue.textContent   = tierCounters.blue;
  cLBlue.textContent  = tierCounters.lblue;
  cGreen.textContent  = tierCounters.green;
  cYellow.textContent = tierCounters.yellow;
  cOrange.textContent = tierCounters.orange;
  cPink.textContent   = tierCounters.pink;
  cRed.textContent    = tierCounters.red;
}
function resetAll(){
  totalSC = 0; totalGifts = 0;
  Object.keys(tierCounters).forEach(k => tierCounters[k]=0);
  lastMeta = { title: undefined, viewers: undefined };       // <-- reset
  if (metaTitleEl)   metaTitleEl.textContent   = '—';
  if (metaViewersEl) metaViewersEl.textContent = '—';
  updateTotals();
  feed.innerHTML = '';
}

// small helpers to disable/enable buttons during a run
function setBusy(b){
  startBtn.disabled = b;
  stopBtn.disabled  = !b;
}

/* ------------------------------- lifecycle -------------------------------- */

async function start(){
  const url = input.value.trim();
  if(!url) return alert('Paste a YouTube URL first.');

  resetAll();
  setBusy(true);

  if (es) { es.close(); es=null; }
  if (sessionId) { try{ await fetch(`${PARSER_ORIGIN}/stop/${sessionId}`,{method:'POST'}) }catch{}; sessionId=null; }

  let res, json;
  try{
    res  = await fetch(`${PARSER_ORIGIN}/start`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({url})
    });
    json = await res.json().catch(()=>({}));
  }catch(err){
    row(`⚠️ Network error: ${escapeHTML(err.message)}`,'status');
    setBusy(false);
    return;
  }

  // Better errors for common cases (429 etc.)
  if(!res.ok || !json.sessionId){
    if (res && res.status === 429 && json?.error === 'too_many_sessions') {
      row('⚠️ Service is already scraping one video. Stop that session first.','status');
    } else {
      row(`⚠️ Failed to start: ${escapeHTML(JSON.stringify(json))}`,'status');
    }
    setBusy(false);
    return;
  }

  sessionId = json.sessionId;
  es = new EventSource(`${PARSER_ORIGIN}/events/${sessionId}`);

  es.onopen = () => row('• connected','status');             // <-- visibility
  es.onmessage = (e)=>{
    try{
      const d = JSON.parse(e.data);
      const t = new Date(d.at || Date.now()).toLocaleTimeString();

      if (d.type === 'chat') {
        row(
          `<div class="row" style="padding:6px 10px; background:transparent; line-height:1.25">
            <span class="who">[${t}] ${escapeHTML(d.author)}</span>
            <span class="msg-txt">${escapeHTML(d.message)}</span>
          </div>`, 'chat'
        );
        return;
      }

      // Server may send 'hello'/'status' lines
      if (d.type === 'hello' || d.type === 'status') {
        row(`• ${escapeHTML(d.message || d.type)}`,'status');
        return;
      }

      if (d.type === 'meta') {
        // Only update UI if values actually changed (prevents flicker).
        if (metaTitleEl && d.title && d.title !== lastMeta.title) {
          metaTitleEl.textContent = d.title;
          lastMeta.title = d.title;
        }
        if (metaViewersEl && d.viewers !== undefined && d.viewers !== null && d.viewers !== '') {
          const n = Number(d.viewers);
          const val = Number.isFinite(n) ? n.toLocaleString() : '—';
          if (val !== metaViewersEl.textContent) {
            metaViewersEl.textContent = val;
            lastMeta.viewers = n;
          }
        }
        return;
      }

      if (d.type === 'superchat') {
        totalSC += Number(d.amountFloat || 0);
        const tier = d.tier || 'blue';
        tierCounters[tier] = (tierCounters[tier] || 0) + 1;
        updateTotals();

        const primary    = d.color || (d.colorVars && d.colorVars.primary) || null;
        const borderCol  = (d.colorVars && d.colorVars.secondary) || primary;
        const textOnCard = pickTextColor(primary || '#0c1414');

        const cardStyle = primary
          ? `style="background:${primary}; color:${textOnCard}; border-color:${borderCol || primary}; padding:8px 12px; line-height:1.25"`
          : `style="padding:8px 12px; line-height:1.25"`;

        const amountEl = `<span class="amount" style="font-weight:700; color:${textOnCard}; margin-left:8px;">${escapeHTML(d.amount || '$?')}</span>`;
        const msgEl = d.message ? `<div class="msg-txt" style="margin-top:2px;">${escapeHTML(d.message)}</div>` : '';

        row(
          `<div class="row" ${cardStyle}>
             <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
               <span class="who" style="color:${textOnCard}; font-weight:600;">[${t}] ${escapeHTML(d.author)}</span>
               ${amountEl}
             </div>
             ${msgEl}
           </div>`
        );
        return;
      }

      if (d.type === 'gift') {
        const c = Number(d.count || 1);
        totalGifts += c;
        updateTotals();
        row(
          `<div class="row" style="padding:8px 12px; line-height:1.25">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <span class="who">[${t}] ${escapeHTML(d.author)}</span>
              <span>🎁 <b>${c}</b> membership${c>1?'s':''}</span>
            </div>
          </div>`, 'member'
        );
        return;
      }

      if (d.type === 'membership') {
        row(
          `<div class="row" style="padding:8px 12px; line-height:1.25">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <span class="who">[${t}] ${escapeHTML(d.author)}</span>
              <span>🟢 ${escapeHTML(d.header || 'New member')}</span>
            </div>
            ${d.message ? `<div class="msg-txt" style="margin-top:2px;">${escapeHTML(d.message)}</div>` : ''}
          </div>`, 'member'
        );
        return;
      }

      if (d.type === 'milestone') {
        const extra = d.months ? ` (${d.months} month${d.months>1?'s':''})` : '';
        row(
          `<div class="row" style="padding:8px 12px; line-height:1.25">
            <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
              <span class="who">[${t}] ${escapeHTML(d.author)}</span>
              <span>🏅 ${escapeHTML(d.header || 'Milestone')}${extra}</span>
            </div>
            ${d.message ? `<div class="msg-txt" style="margin-top:2px;">${escapeHTML(d.message)}</div>` : ''}
          </div>`, 'member'
        );
        return;
      }
    }catch(err){
      row(`• parse error: ${escapeHTML(err.message)}`,'status');
    }
  };

  es.onerror = () => {
    row('• stream hiccup — retrying…','status');
    // EventSource auto-reconnects; keep it open.
  };
}

async function stop(){
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
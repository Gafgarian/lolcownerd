/* retro.js
   - Live status check using mirrored channel HTML: /channel/{id}/streams
   - Detects `[LIVE LIVE Now playing]` and extracts the live video URL
   - Updates avatar (Image 4) to channel’s current icon
   - Re-check on load, manual refresh, and every 3 minutes
   - Secret “channel switch” codes to change which channel is monitored (memory only, not cached)
   - Passcode entry (case-insensitive): "NDF" + MMDDYYYY -> creates session then redirects
*/

/* ================== CONFIG ================== */
const DEFAULT_CHANNEL_ID = 'UCU3iQ0uiduxtArm9337dXug';     // your default channel
const MIRROR = 'https://r.jina.ai';                         // CORS-friendly HTML mirror
const APP_ENTRY = 'app.html';                               // destination after successful login
const SESSION_KEY = 'nerdsSession';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;                // 24h

/* Secret codes -> channel IDs (visit-scoped only; NOT persisted) */
const SECRET_CODES = {
  'c4fe':       'UCBQgQPjVx4wgszEmGR5cPJg',
  'n3rd':       'UCU3iQ0uiduxtArm9337dXug',
  't35t':       'UC9NU92OuAiSLvAarnqZEoUw',
  'b477s':      'UC2xdmM3rcLFD_iN46H8y-6w',
  'liv3':       'UCmxQ_3W5b9kSfpmROqGJ0rA',
  'qu33ns':     'UCOzrx6iM9qQ4lIzf7BbkuCQ',
  'r3w1nd':     'UCUENzb0fUK-6uvLL3zD08Jw',
  'au55y':      'UChcQ2TIYiihd9B4H50eRVlQ',
  'g1ng3r':     'UCRh4qe6HGD10ZsyG56eUdHA',
  't3chta7k':   'UC7WRbUmD6W-dCP_UlDbhI4A',
};

/* ================== SESSION UTILS ================== */

/** Lightweight FNV-1a 32-bit hash -> 8-char hex (sync, no WebCrypto) */
function hashToken(raw) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    // h *= 16777619 (done with shifts to avoid bigints)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

/**
 * Save session: token=hash("NDFmmddyyyy"), at=Date.now()
 * @param {string} expectedRaw The raw daily pass string, e.g. "NDF08172025"
 */
function setSession(expectedRaw) {
  try {
    const token = hashToken(String(expectedRaw));
    const payload = { token, at: Date.now() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {}
}

function isSessionValid(obj) {
  if (!obj || !obj.at) return false;
  return (Date.now() - obj.at) < SESSION_TTL_MS && !!obj.token;
}
function redirect(href) {
  try { window.location.replace(href); } catch { window.location.href = href; }
}

/* ================== CHANNEL (no caching) ================== */
let currentChannelId = DEFAULT_CHANNEL_ID; // always starts at default per page load

/* ================== LIVE BADGE ================== */
(function liveBadge() {
  const badge     = document.getElementById('liveBadge');
  const label     = document.getElementById('liveLabel');
  const refresh   = document.getElementById('liveRefresh');
  const cowImg    = document.getElementById('nerdsIcon');

  if (!badge) return;

  let lastLiveUrl = null; // when live, clicking the cow opens this

  function setBadgeLive(isLive) {
    if (!badge) return;

    // flip LED color
    badge.classList.toggle('is-live', !!isLive);

    // set label text based on live status
    if (label) {
      label.textContent = isLive ? 'NOW STREAMING' : 'OFFLINE';
    }

    // cow is clickable only if live
    if (cowImg) {
      cowImg.style.cursor = isLive ? 'pointer' : 'default';
    }
  }

  async function fetchText(url) {
    const res = await fetch(url, { method: 'GET', mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  /**
   * Parse the mirror’s "markdown-ish" output.
   * - Detect live by locating the literal:  LIVE LIVE Now playing
   * - Extract the live video URL immediately following that token
   * - Extract avatar (Image 4) and apply to the cow image
   */
  function parseLiveFromHTML(html) {
    lastLiveUrl = null;

    // Update avatar from "Image 4"
    const img4 = html.match(/!\[Image 4\]\(([^)]+)\)/i);
    if (img4 && cowImg) cowImg.src = img4[1];

    // Find the LIVE marker and the link that immediately follows it
    const marker = 'LIVE LIVE Now playing';
    const idx = html.indexOf(marker);
    if (idx !== -1) {
      const after = html.slice(idx, idx + 500);
      const linkMatch = after.match(/\((https:\/\/www\.youtube\.com\/watch\?v=[^)]+)\)/i);
      if (linkMatch) lastLiveUrl = linkMatch[1];
      return true;
    }

    // Backups
    if (html.includes('hqdefault_live.jpg')) return true;
    if (html.includes('"isLiveNow":true') || html.includes('"isLiveStream":true')) return true;

    return false;
  }

  function parseLiveFromRSS(xml) {
    return /\b(live|livestream|now live|streaming)\b/i.test(xml);
  }

  async function checkOnce() {
    try {
      setBadgeLive(false, 'Checking…');

      // Primary: mirrored channel STREAMS page (appends /streams)
      const channelStreamsURL =
        `${MIRROR}/https://www.youtube.com/channel/${encodeURIComponent(currentChannelId)}/streams`;

      try {
        const html = await fetchText(channelStreamsURL);
        const isLive = parseLiveFromHTML(html);
        setBadgeLive(isLive);        
        return;
      } catch (e) {
        console.warn('[live badge] primary fetch failed:', e);
      }

      // Fallback: mirrored RSS
      const feedURL =
        `${MIRROR}/https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(currentChannelId)}`;
      try {
        const xml = await fetchText(feedURL);
        const isLive = parseLiveFromRSS(xml);
        setBadgeLive(isLive);
      } catch (err2) {
        console.warn('[live badge] feed fetch failed:', err2);
        setBadgeLive(false);
      }
    } catch (err) {
      console.error('[live badge] error:', err);
      setBadgeLive(false);
    }
  }

  // Run on load
  document.addEventListener('DOMContentLoaded', checkOnce);

  // Manual refresh button
  if (refresh) {
    let busy = false;
    refresh.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      refresh.disabled = true;
      refresh.classList.add('spinning');
      await checkOnce();
      refresh.classList.remove('spinning');
      refresh.disabled = false;
      busy = false;
    });
  }

  // Clicking the cow: open live stream when available
  if (cowImg) {
    cowImg.addEventListener('click', () => {
      if (lastLiveUrl) window.open(lastLiveUrl, '_blank', 'noopener');
    });
  }

  // Re-run every 3 minutes
  setInterval(checkOnce, 3 * 60 * 1000);

  // Expose a tiny helper so the terminal can force a refresh after a secret code
  window.__forceLiveCheck = checkOnce;
})();

/* ================== TERMINAL / PASSCODE ================== */
(function terminalPasscode() {
  const secret   = document.getElementById('secretInput');  // hidden real input
  const echo     = document.getElementById('echo');         // prints asterisks
  const boot     = document.getElementById('boot');
  const barFill  = document.getElementById('barFill');
  const terminal = document.getElementById('screen');

  if (!secret || !echo) return; // not on login screen

  // Ensure the hidden input is interactive
  try {
    secret.type = 'password';
    secret.removeAttribute('disabled');
    secret.readOnly = false;
    secret.autocomplete = 'off';
    secret.autocapitalize = 'off';
    secret.spellcheck = false;
    secret.setAttribute('tabindex', '0');
    secret.style.pointerEvents = 'auto';
  } catch {}

  const focusInput = () => { if (document.activeElement !== secret) secret.focus({ preventScroll:true }); };
  document.addEventListener('DOMContentLoaded', focusInput);
  ['click','mousedown','touchstart'].forEach(evt => {
    (terminal || document).addEventListener(evt, focusInput, { passive:true });
  });

  const updateEcho = () => { echo.textContent = '*'.repeat(secret.value.length); };
  secret.addEventListener('input', updateEcho);

  // Capture typing anywhere on the screen
  window.addEventListener('keydown', (e) => {
    const ae = document.activeElement;
    const typing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
    if (typing && ae !== secret) return;

    if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      focusInput();
      secret.value += e.key;
      updateEcho();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Backspace') {
      focusInput();
      secret.value = secret.value.slice(0, -1);
      updateEcho();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      handleEntry(secret.value.trim());
    }
  }, { capture: true });

  function expectedPasscode() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `NDF${mm}${dd}${yyyy}`.toLowerCase();
  }

  async function handleEntry(value) {
    const code = (value || '').toLowerCase();

    // Secret channel-switch codes (do NOT create a session; not persisted)
    if (SECRET_CODES[code]) {
      currentChannelId = SECRET_CODES[code];         // memory only
      const label = document.getElementById('liveLabel');
      if (label) {
        const prev = label.textContent;
        label.textContent = 'Channel switched';
        setTimeout(() => (label.textContent = prev), 900);
      }
      secret.value = '';
      updateEcho();
      window.__forceLiveCheck && window.__forceLiveCheck();
      return;
    }

    // Regular passcode = grant session and proceed
    const ok = code === expectedPasscode();
    if (!ok) { flashDeny(); return; }

    // After successful passcode validation:
    const expectedRaw = code.toUpperCase();
    setSession(expectedRaw);

    if (boot && barFill) {
      boot.classList.remove('hidden');
      await fakeBoot(barFill);
    }
    redirect(APP_ENTRY);
  }

  // --- terminal-style deny message under the prompt (no overlay) ---
  function flashDeny() {
    const focusInput = () => { if (document.activeElement !== secret) secret.focus({ preventScroll:true }); };

    let box = document.getElementById('termFeedback');
    if (!box) {
      box = document.createElement('div');
      box.id = 'termFeedback';
      box.style.marginTop = '8px';
      box.style.lineHeight = '1.4';
      box.style.whiteSpace = 'pre-wrap';
      // append right after the prompt line (echo’s parent) if available
      const afterPrompt = (echo && echo.parentNode) ? echo.parentNode : document.body;
      afterPrompt.insertAdjacentElement('beforeend', box);
    }

    const line = document.createElement('div');
    line.className = 'term-error';
    line.textContent = 'ACCESS DENIED — Invalid passcode.\nEnter passcode to continue.';
    box.appendChild(line);

    secret.value = '';
    if (echo) echo.textContent = '';
    focusInput();
  }

  function fakeBoot(fillEl) {
    return new Promise(resolve => {
      let p = 0;
      const id = setInterval(() => {
        p = Math.min(100, p + (p < 40 ? 6 : p < 80 ? 4 : 2));
        fillEl.style.width = p + '%';
        if (p >= 100) { clearInterval(id); setTimeout(resolve, 240); }
      }, 70);
    });
  }

  updateEcho();
})();
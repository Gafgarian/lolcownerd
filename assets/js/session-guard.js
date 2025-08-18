(function () {
  const SESSION_KEY = 'nerdsSession';
  const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // keep in sync with retro.js

  /** Same FNV-1a 32-bit hash used in retro.js */
  function hashToken(raw) {
    let h = 0x811c9dc5 >>> 0;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function readSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch { return null; }
  }

  function isFresh(s) {
    return !!s && !!s.at && (Date.now() - s.at) < SESSION_TTL_MS && !!s.token;
  }

  function todayExpectedToken() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    const expectedRaw = `NDF${mm}${dd}${yyyy}`.toUpperCase();
    return hashToken(expectedRaw);
  }

  function redirectToRoot(target) {
    const parts = window.location.href.split('/');
    const rootIndex = parts.indexOf('lolcownerd');
    if (rootIndex !== -1) {
      const base = parts.slice(0, rootIndex + 1).join('/');
      window.location.href = `${base}/${target}`;
    } else {
      // fallback
      window.location.href = `/${target}`;
    }
  }

  try {
    const sess = readSession();
    const ok = isFresh(sess) && sess.token === todayExpectedToken();
    if (!ok) redirectToRoot('index.html');
  } catch {
    redirectToRoot('index.html');
  }
})();
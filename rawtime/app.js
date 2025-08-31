/* RAW TIME — Soundboard logic
   - Loads config.json { connectionUrl, clips: [{ url, sizeKB }] }
   - Sorts clips by sizeKB ascending
   - Renders 75 tiles (or however many provided)
   - Clicking a tile queues: Connection → Clip → Connection
   - Button behavior: shows NOW PLAYING while active; then stays depressed + blank text
   - If a clip errors, shows error badge and allows retry (re-enables tile)
   - No persistence across reloads
*/

const GRID_COLS = 15; // visual reference, layout handled in CSS

const els = {
  grid: document.getElementById('grid'),
  notice: document.getElementById('notice'),
  metaCount: document.getElementById('meta-count'),
  metaQueue: document.getElementById('meta-queue'),
};

// Attempt to fetch local config.json (or fall back to sample)
async function loadConfig() {
  // 0) Site-wide production config (set via window.SOUNDBOARD_CONFIG_URL)
  if (window.SOUNDBOARD_CONFIG_URL) {
    try {
      const res = await fetch(window.SOUNDBOARD_CONFIG_URL, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.clips && json.connectionUrl) return json;
      }
    } catch (e) { console.warn('Prod config fetch failed', e); }
  }

  // 1) URL param override (?config=...)
  const params = new URLSearchParams(location.search);
  const override = params.get('config');
  if (override) {
    try {
      const res = await fetch(override, { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.clips && json.connectionUrl) return json;
      }
    } catch (e) { console.warn('Failed to load ?config', override, e); }
  }

  // 2/3) local files or inline fallback (unchanged)...
  // ... keep your existing tries for 'config.json', 'config.sample.json', then #CONFIG script tag
}

// Helpers
function getDriveId(url) {
  // Support: https://drive.google.com/file/d/{id}/view?... or .../uc?export=download&id={id} or open?id=...
  try {
    const u = new URL(url);
    if (u.hostname.includes('drive.google.com')) {
      const match = u.pathname.match(/\/file\/d\/([^/]+)/);
      if (match) return match[1];
      if (u.searchParams.has('id')) return u.searchParams.get('id');
    }
  } catch (e) {}
  return null;
}
function toDirectDriveUrl(url) {
  const id = getDriveId(url);
  if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  return url; // return as-is if not recognized; may already be direct
}
function formatCount(n) {
  return `${n} clip${n === 1 ? '' : 's'}`;
}

// Playback engine
class Engine {
  constructor(connectionUrl) {
    this.queue = [];
    this.isBusy = false;
    this.connectionUrl = toDirectDriveUrl(connectionUrl);
    this.connection = new Audio(this.connectionUrl);
    this.connection.preload = 'auto';
  }
  enqueue(item) {
    this.queue.push(item);
    this.updateQueueMeta();
    this.kick();
  }
  updateQueueMeta() {
    els.metaQueue.textContent = `Queue: ${this.queue.length}${this.isBusy ? ' (playing)' : ''}`;
  }
  async kick() {
    if (this.isBusy) return;
    if (this.queue.length === 0) { this.updateQueueMeta(); return; }
    this.isBusy = true;
    this.updateQueueMeta();
    const next = this.queue.shift();
    try {
      await this.playSequence(next);
      // mark as played
      next.state = 'played';
      markPlayed(next);
    } catch (err) {
      console.error('Sequence failed', err);
      next.state = 'error';
      markError(next, err);
    } finally {
      this.isBusy = false;
      this.updateQueueMeta();
      // proceed to next
      this.kick();
    }
  }
  async playSequence(item) {
    // Set NOW PLAYING
    markNowPlaying(item);
    // play connection intro (non-blocking if it errors)
    await this.safePlay(this.connectionUrl);
    // play clip (must succeed, or throw)
    await this.mustPlay(toDirectDriveUrl(item.url));
    // play connection outro (non-blocking if it errors)
    await this.safePlay(this.connectionUrl);
  }
  // Attempt to play; on error, just continue
  async safePlay(src) {
    try { await this.playOnce(src); } catch (e) { console.warn('safePlay error', e); }
  }
  // Must play; on error, throw to mark item error
  async mustPlay(src) {
    await this.playOnce(src);
  }
  playOnce(src) {
    return new Promise((resolve, reject) => {
      const a = new Audio();
      a.preload = 'auto';
      a.src = src;
      a.referrerPolicy = 'no-referrer'; 
      let settled = false;

      const onEnded = () => { cleanup(); resolve(); };
      const onError = (e) => { cleanup(); reject(new Error('Audio error')); };

      function cleanup() {
        if (settled) return;
        settled = true;
        a.removeEventListener('ended', onEnded);
        a.removeEventListener('error', onError);
      }

      a.addEventListener('ended', onEnded);
      a.addEventListener('error', onError);
      // iOS requires user gesture; our click triggers the first audio; subsequent should be fine
      const playPromise = a.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          // ok
        }).catch((err) => {
          cleanup();
          reject(err || new Error('Playback failed (promise rejection)'));
        });
      }
    });
  }
}

let engine = null;
let items = []; // { idx, url, sizeKB, el, state }

function renderGrid() {
  els.grid.innerHTML = '';
  items.forEach((it, i) => {
    const btn = document.createElement('button');
    btn.className = 'tile';
    btn.type = 'button';
    btn.dataset.index = String(i);
    btn.disabled = false;

    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '';

    btn.appendChild(num);
    btn.appendChild(label);

    btn.addEventListener('click', () => onTileClick(it));

    it.el = btn;
    it.labelEl = label;
    els.grid.appendChild(btn);
  });
}

function onTileClick(it) {
  if (it.state === 'played') return; // do not replay
  if (it.state === 'queued') return; // already queued
  if (it.state === 'now') return;    // already playing

  // queue it
  it.state = engine && engine.isBusy ? 'queued' : 'now';
  updateTileVisual(it);
  engine.enqueue(it);
}

function updateTileVisual(it) {
  const el = it.el;
  el.classList.remove('played', 'queued', 'now', 'error');
  if (it.state === 'played') {
    el.classList.add('played');
    it.labelEl.textContent = '';
    el.disabled = true;
  } else if (it.state === 'queued') {
    el.classList.add('queued');
    it.labelEl.textContent = 'QUEUED';
    el.disabled = true; // prevent duplicate queues
  } else if (it.state === 'now') {
    el.classList.add('now');
    it.labelEl.textContent = 'NOW PLAYING';
    el.disabled = true;
  } else if (it.state === 'error') {
    el.classList.add('error');
    it.labelEl.textContent = 'ERROR — CLICK TO RETRY';
    el.disabled = false; // allow retry
  } else {
    el.disabled = false;
    it.labelEl.textContent = '';
  }
}

function markNowPlaying(it) {
  it.state = 'now';
  updateTileVisual(it);
}
function markPlayed(it) {
  it.state = 'played';
  updateTileVisual(it);
}
function markError(it, err) {
  console.error('Error on item', it, err);
  it.state = 'error';
  updateTileVisual(it);
}

// Boot
(async function init() {
  try {
    const cfg = await loadConfig();
    engine = new Engine(cfg.connectionUrl);

    items = (cfg.clips || [])
      .map((c, idx) => ({ idx, url: c.url, sizeKB: Number(c.sizeKB) || 0, state: 'ready', el: null, labelEl: null }))
      .sort((a, b) => (a.sizeKB - b.sizeKB)); // shortest (smallest size) first

    els.metaCount.textContent = formatCount(items.length);

    renderGrid();

    // If not exactly 75, show a soft notice (still works with any count)
    if (items.length !== 75) {
      showNotice(`Heads up: config contains ${items.length} clip(s). This board is designed for 75.`);
    }
  } catch (e) {
    console.error(e);
    showNotice('Could not load config.json. Place a config.json next to index.html. Using config.sample.json as a template.');
  }
})();

function showNotice(msg) {
  els.notice.textContent = msg;
  els.notice.hidden = false;
}

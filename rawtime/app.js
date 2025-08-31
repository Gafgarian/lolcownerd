/* Streamdeck-styled RawTime soundboard
   - Square tiles, 5 columns (15 rows).
   - Connection 'sting' button always enabled.
   - No numeric labels on tiles.
   - Random pre/post stingers around the main sequence.
   - 1.5s pause between connection intro and the main clip.
   - No crossOrigin on audio; supports same-host /audio/*.mp3 or Drive download URLs.
*/

const els = {
  grid: document.getElementById('grid'),
  notice: document.getElementById('notice'),
  metaCount: document.getElementById('meta-count'),
  metaQueue: document.getElementById('meta-queue'),
  btnConnection: document.getElementById('btn-connection'),
};

async function loadConfig() {
  // Prefer explicit production URL if provided
  if (window.SOUNDBOARD_CONFIG_URL) {
    const res = await fetch(window.SOUNDBOARD_CONFIG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to fetch production config');
    return res.json();
  }
  // Fallbacks
  for (const p of ['config.json', 'config.sample.json']) {
    try {
      const res = await fetch(p, { cache: 'no-store' });
      if (res.ok) return await res.json();
    } catch {}
  }
  throw new Error('Missing config');
}

// Drive helpers (safe if you still point to Drive)
function getDriveId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('drive.google.com')) {
      const m = u.pathname.match(/\/file\/d\/([^/]+)/);
      if (m) return m[1];
      if (u.searchParams.has('id')) return u.searchParams.get('id');
    }
  } catch {}
  return null;
}
function toDirectDriveUrl(url) {
  const id = getDriveId(url);
  return id ? `https://drive.google.com/uc?export=download&id=${id}` : url;
}

function formatCount(n){ return `${n} clip${n===1?'':'s'}`; }

class Engine {
  constructor(connectionUrl, randoms) {
    this.queue = [];
    this.isBusy = false;
    this.connectionUrl = connectionUrl;
    this.randoms = randoms || [];
    // Preload only the connection
    this.connection = new Audio(this.connectionUrl);
    this.connection.preload = 'auto';
  }
  enqueueClip(item) {
    this.queue.push({ kind:'clip', item });
    this.updateQueueMeta(); this.kick();
  }
  enqueueConnection() {
    this.queue.push({ kind:'sting' });
    this.updateQueueMeta(); this.kick();
  }
  updateQueueMeta() {
    els.metaQueue.textContent = `Queue: ${this.queue.length}${this.isBusy?' (playing)':''}`;
  }
  async kick() {
    if (this.isBusy) return;
    if (this.queue.length === 0) { this.updateQueueMeta(); return; }
    this.isBusy = true; this.updateQueueMeta();
    const task = this.queue.shift();
    try {
      if (task.kind === 'sting') {
        await this.safePlay(this.connectionUrl);
      } else if (task.kind === 'clip') {
        await this.playSequence(task.item);
      }
      if (task.kind === 'clip') {
        task.item.state = 'played'; markPlayed(task.item);
      }
    } catch (err) {
      console.error('Sequence failed', err);
      if (task.kind === 'clip') {
        task.item.state = 'error'; markError(task.item, err);
      }
    } finally {
      this.isBusy = false; this.updateQueueMeta(); this.kick();
    }
  }

  async playSequence(item) {
    markNowPlaying(item);
    // Randoms before the main audio: 10% then 5%
    await this.maybeRandom(0.10);
    await this.maybeRandom(0.05);

    // Connection intro
    await this.safePlay(this.connectionUrl);

    // 1.5s pause before the main audio
    await this.wait(1500);

    // Main audio (must succeed, bubbles errors)
    await this.mustPlay(item.url);

    // Connection outro (no pause afterwards)
    await this.safePlay(this.connectionUrl);

    // Random after main: 5%
    await this.maybeRandom(0.05);
  }

  pickRandomUrl() {
    if (!this.randoms || this.randoms.length === 0) return null;
    const idx = Math.floor(Math.random() * this.randoms.length);
    return this.randoms[idx];
  }
  async maybeRandom(prob) {
    if (Math.random() < prob) {
      const r = this.pickRandomUrl();
      if (r) await this.safePlay(r);
    }
  }

  wait(ms){ return new Promise(res=>setTimeout(res, ms)); }

  async safePlay(src){
    try { await this.playOnce(src); } catch(e){ console.warn('safePlay error', e); }
  }
  async mustPlay(src){ await this.playOnce(src); }

  playOnce(src){
    return new Promise((resolve, reject)=>{
      const a = new Audio();
      a.preload = 'auto';
      a.src = src;
      a.referrerPolicy = 'no-referrer';

      const onEnded = ()=>{ cleanup(); resolve(); };
      const onError = ()=>{ cleanup(); reject(new Error('Audio error')); };
      const cleanup = ()=>{
        a.removeEventListener('ended', onEnded);
        a.removeEventListener('error', onError);
      };

      a.addEventListener('ended', onEnded);
      a.addEventListener('error', onError);
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.catch(err=>{ cleanup(); reject(err||new Error('Playback failed')); });
      }
    });
  }
}

let engine = null;
let items = [];
let randoms = [];

function renderGrid() {
  els.grid.innerHTML = '';
  items.forEach((it) => {
    const btn = document.createElement('button');
    btn.className = 'tile';
    btn.type = 'button';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = '';
    btn.appendChild(label);
    btn.addEventListener('click', () => onTileClick(it));
    it.el = btn; it.labelEl = label;
    els.grid.appendChild(btn);
  });
}

function onTileClick(it){
  if (it.state === 'played' || it.state === 'queued' || it.state === 'now') return;
  it.state = engine && engine.isBusy ? 'queued' : 'now';
  updateTileVisual(it);
  engine.enqueueClip(it);
}

function updateTileVisual(it){
  const el = it.el;
  el.classList.remove('played','queued','now','error');
  if (it.state === 'played') { el.classList.add('played'); it.labelEl.textContent=''; el.disabled = true; }
  else if (it.state === 'queued') { el.classList.add('queued'); it.labelEl.textContent='QUEUED'; el.disabled = true; }
  else if (it.state === 'now') { el.classList.add('now'); it.labelEl.textContent='NOW PLAYING'; el.disabled = true; }
  else if (it.state === 'error') { el.classList.add('error'); it.labelEl.textContent='ERROR — CLICK TO RETRY'; el.disabled = false; }
  else { el.disabled = false; it.labelEl.textContent=''; }
}
function markNowPlaying(it){ it.state='now'; updateTileVisual(it); }
function markPlayed(it){ it.state='played'; updateTileVisual(it); }
function markError(it){ it.state='error'; updateTileVisual(it); }

function buildRandoms(cfg){
  if (Array.isArray(cfg.randoms) && cfg.randoms.length){
    return cfg.randoms;
  }
  // Fallback to /audio/random1..4.mp3 (same-origin)
  const base = (cfg.connectionUrl || '').split('/').slice(0, -1).join('/'); // infer /audio directory
  const dir = base || 'audio';
  return [1,2,3,4].map(i => `${dir}/random${i}.mp3`);
}

(async function init(){
  try {
    const cfg = await loadConfig();

    // Build clip list and sort by sizeKB (asc)
    items = (cfg.clips||[]).map((c, idx)=> ({
      idx,
      url: (c.url || c.href || ''),
      sizeKB: Number(c.sizeKB) || 0,
      state:'ready', el:null, labelEl:null
    })).sort((a,b)=>a.sizeKB - b.sizeKB);

    // Normalize any Drive links if present
    items.forEach(it => { it.url = toDirectDriveUrl(it.url); });

    randoms = buildRandoms(cfg).map(toDirectDriveUrl);
    const connectionUrl = toDirectDriveUrl(cfg.connectionUrl);

    engine = new Engine(connectionUrl, randoms);

    els.metaCount.textContent = formatCount(items.length);
    renderGrid();

    // Connection button always works
    els.btnConnection.addEventListener('click', ()=> engine.enqueueConnection());

    if (items.length !== 75) {
      showNotice(`Heads up: ${items.length} clip(s) loaded; board is designed for 75.`);
    }
  } catch (e) {
    console.error(e);
    showNotice('Could not load config. Ensure config.json is served and valid.');
  }
})();

function showNotice(msg){ els.notice.textContent = msg; els.notice.hidden = false; }
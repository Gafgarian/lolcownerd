/* Streamdeck-styled RawTime soundboard (defensive build)
   - Square tiles, 5 columns (15 rows).
   - Connection 'sting' button always enabled.
   - No numeric labels on tiles.
   - Random pre/post stingers around the main sequence.
   - 1.5s pause between connection intro and the main clip.
   - Defensive config loading + helpful errors.
*/

const els = {
  grid: document.getElementById('grid'),
  notice: document.getElementById('notice'),
  metaCount: document.getElementById('meta-count'),
  metaQueue: document.getElementById('meta-queue'),
  btnConnection: document.getElementById('btn-connection'),
};

async function loadConfig() {
  const tryFetch = async (url) => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return res.json();
  };

  if (window.SOUNDBOARD_CONFIG_URL) {
    console.info('config: using explicit', window.SOUNDBOARD_CONFIG_URL);
    return tryFetch(window.SOUNDBOARD_CONFIG_URL);
  }
  for (const p of ['config.json', 'config.sample.json']) {
    try {
      console.info('config: trying', p);
      const cfg = await tryFetch(p);
      return cfg;
    } catch (e) {
      console.warn('config: miss', p, e);
    }
  }
  throw new Error('No config.json found next to index.html (and no SOUNDBOARD_CONFIG_URL set).');
}

// Google Drive helpers (safe if you still point to Drive)
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
  if (!url) return url;
  const id = getDriveId(url);
  // We prefer "uc?export=download" for <audio> elements.
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
    await this.maybeRandom(0.10); // 10% before
    await this.maybeRandom(0.05); // then 5% before
    await this.safePlay(this.connectionUrl); // intro
    await this.wait(1000); // 1.0s pause
    await this.mustPlay(item.url); // main
    await this.safePlay(this.connectionUrl); // outro (no pause after)
    await this.maybeRandom(0.05); // 5% after
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


function computeTileSize(){
  // Aim to fit 5 columns x 15 rows without (or with minimal) scroll
  const cols = 5, rows = 15, gap = 12;
  const grid = els.grid;
  const footer = document.querySelector('.footer');
  // Account for page paddings around grid (20px left/right, ~28px bottom)
  const availableWidth = Math.max(0, window.innerWidth - 40);
  const gridTop = grid.getBoundingClientRect().top;
  const footerTop = footer ? footer.getBoundingClientRect().top : window.innerHeight;
  const availableHeight = Math.max(0, footerTop - gridTop - 28);
  const sizeByW = Math.floor((availableWidth - gap*(cols-1)) / cols);
  const sizeByH = Math.floor((availableHeight - gap*(rows-1)) / rows);
  // Clamp to a sensible range so tiles don't dominate the screen
  const size = Math.max(56, Math.min(120, sizeByW, sizeByH));
  document.documentElement.style.setProperty('--tile-size', size + 'px');
}

function initResponsiveSizing(){
  // Run once grid exists
  computeTileSize();
  window.addEventListener('resize', computeTileSize, { passive:true });
  window.addEventListener('orientationchange', computeTileSize);
}

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

function buildRandoms(cfg, audioDir){
  if (Array.isArray(cfg.randoms) && cfg.randoms.length){
    return cfg.randoms;
  }
  // Fallback to /audio/random1..4.mp3
  const dir = audioDir || 'audio';
  return [1,2,3,4].map(i => `${dir}/random${i}.mp3`);
}

function getAudioDirFrom(url){
  try{
    const u = new URL(url, location.href);
    return u.pathname.split('/').slice(0,-1).join('/') || 'audio';
  }catch{
    return 'audio';
  }
}

(async function init(){
  try {
    const cfg = await loadConfig();
    if (!cfg || typeof cfg !== 'object') throw new Error('Config is empty or invalid JSON.');

    // Resolve connection URL from several possible keys
    const rawConn = cfg.connectionUrl || cfg.connectionURL || cfg.connection || (cfg.connection && cfg.connection.url);
    if (!rawConn) throw new Error('`connectionUrl` missing in config.json (expected a URL to your CONNECTION.mp3).');
    const connectionUrl = toDirectDriveUrl(rawConn);

    // Build clip list and sort by sizeKB (asc)
    items = (cfg.clips||[]).map((c, idx)=> ({
      idx,
      url: toDirectDriveUrl(c.url || c.href || ''),
      sizeKB: Number(c.sizeKB) || 0,
      state:'ready', el:null, labelEl:null
    })).sort((a,b)=>a.sizeKB - b.sizeKB);

    const audioDir = getAudioDirFrom(connectionUrl);
    randoms = buildRandoms(cfg, audioDir).map(toDirectDriveUrl);

    engine = new Engine(connectionUrl, randoms);

    els.metaCount.textContent = formatCount(items.length);
    renderGrid();
    initResponsiveSizing();

    // Connection button always works
    els.btnConnection.addEventListener('click', ()=> engine.enqueueConnection());

    if (items.length !== 75) {
      showNotice(`Heads up: ${items.length} clip(s) loaded; board is designed for 75.`);
    }
  } catch (e) {
    console.error(e);
    showNotice(e.message || 'Could not load config. Ensure config.json is served and valid.');
  }
})();

function showNotice(msg){ els.notice.textContent = msg; els.notice.hidden = false; }

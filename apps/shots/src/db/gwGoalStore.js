import os from 'os';
import fs from 'fs/promises';
import path from 'path';

export function createGwGoalStore({ dataDir }) {
  const file = (name) => path.join(dataDir, name);
  const fGraffiti = file('gw-graffiti.json');
  const fGoal     = file('gw-goal.json');

  let graffiti = { items: [], rev: 0 };
  let goal = null;

  const listeners = new Set(); // change subscribers (SSE bridge)
  const onChange = (fn) => { if (typeof fn === 'function') listeners.add(fn); return () => listeners.delete(fn); };
  const notify = () => { for (const fn of listeners) try { fn(); } catch {} };

  async function safeWrite(dest, json) {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = dest + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(json, null, 2));
    // atomic rename if possible; if it fails due to ENOENT on dest, just write directly
    try {
      await fs.rename(tmp, dest);
    } catch (e) {
      await fs.writeFile(dest, JSON.stringify(json, null, 2)).catch(()=>{});
      try { await fs.unlink(tmp); } catch {}
    }
  }

  async function load() {
    try { graffiti = JSON.parse(await fs.readFile(fGraffiti, 'utf8')); } catch {}
    try { goal     = JSON.parse(await fs.readFile(fGoal,     'utf8')); } catch {}
  }

  async function safeWrite(dest, json) {
    const payload = JSON.stringify(json, null, 2);
    const dir = path.dirname(dest);
    const tmp = dest + '.tmp';

    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, payload);
      await fs.rename(tmp, dest);
      return;
    } catch (e) {
      // Clean tmp if it exists
      try { await fs.unlink(tmp); } catch {}

      if (e && e.code === 'EACCES') {
        // Fallback to OS temp so the app keeps running
        const fallbackDir = path.join(os.tmpdir(), 'pd-data');
        const alt = path.join(fallbackDir, path.basename(dest));
        try {
          await fs.mkdir(fallbackDir, { recursive: true });
          await fs.writeFile(alt, payload);
          console.warn(`[gwGoalStore] DATA_DIR not writable (${dest}); wrote to ${alt}`);
          return;
        } catch (e2) {
          console.error('[gwGoalStore] fallback write failed:', e2);
        }
      } else {
        console.error('[gwGoalStore] persist failed:', e);
      }
      // At this point we keep in-memory state but don’t crash the server
    }
  }

  function setGraffiti(items = []) {
    const norm = Array.isArray(items) ? items.map(x => ({
      name: String(x?.name ?? x?.n ?? '').trim(),
      crown: !!(x?.crown ?? x?.isCrown ?? x?.king),
    })).filter(x => x.name) : [];
    graffiti = { items: norm, rev: Date.now() };
    safeWrite(fGraffiti, graffiti).then(notify);
  }

  function getGraffiti(){ return graffiti; }

  function saveGoal(g, { keepProgress = true } = {}) {
    const prev = goal || { progress:0 };
    goal = {
      enabled: true,
      mode: g.mode === 'gifting' ? 'gifting' : 'superchat',
      title: g.title || (g.mode === 'gifting' ? 'Gifted memberships' : 'Superchat goal'),
      tier: g.tier || 'blue',
      target: Math.max(1, Number(g.target || 0) | 0),
      progress: keepProgress ? (Number(prev.progress||0)|0) : Math.max(0, Number(g.progress||0)|0),
    };
    safeWrite(fGoal, goal).then(notify);
  }

  function addToGoal(delta = 1) {
    if (!goal) return;
    goal.progress = Math.min(goal.target, Math.max(0, (goal.progress|0) + (delta|0)));
    safeWrite(fGoal, goal).then(notify);
  }

  function clearGoal(){
    goal = null;
    safeWrite(fGoal, goal).then(notify);
  }

  function getGoal(){ return goal; }

  function snapshot(){ return { graffiti, goal }; }

  // Hook used by parser/router to auto-advance goal from events
  function maybeAdvanceFromEvent(evt) {
    if (!goal || !evt) return;

    // Allow string or object
    if (typeof evt === 'string') evt = { text: evt };

    const type  = String(evt.type || '').toLowerCase();
    const text  = String(evt.text || '');
    const tier  = normalizeTier(evt.tier || extractTier(text));
    const gifts = Number.isFinite(evt.gift_count) ? (evt.gift_count | 0) : extractGiftCount(text);

    if (goal.mode === 'superchat') {
      const isSC = type === 'superchat' || /super\s*chat|paid\s*sticker|sticker/i.test(text);
      if (!isSC) return;

      // Tier gating (or ANY)
      if (goal.tier === 'any' || (tier && tier === normalizeTier(goal.tier))) {
        addToGoal(1);
        dbg('SC +1', { tier });
      }
      return;
    }

    // gifting mode
    if (goal.mode === 'gifting') {
      let inc = 0;
      if (type === 'gift') inc = Math.max(1, gifts || 0);
      else if (type === 'membership') inc = 1;                 // single membership
      else inc = gifts || (/gift(?:ed)?\s+membership/i.test(text) ? 1 : 0);

      if (inc) { addToGoal(inc); dbg('GIFT +', inc); }
    }
  }

  function normalizeTier(t) {
    const s = String(t || '').toLowerCase().replace(/\s+/g,'');
    return (s === 'lightblue') ? 'lblue'
         : ['blue','lblue','green','yellow','orange','pink','red'].includes(s) ? s : '';
  }
  function extractTier(s) {
    const m = String(s || '').toLowerCase().match(/light\s*blue|lblue|blue|green|yellow|orange|pink|red/);
    return m ? normalizeTier(m[0].replace(/\s+/g,'')) : '';
  }
  function extractGiftCount(s) {
    const m = String(s || '').replace(/,/g,'').match(/gift(?:ed)?\s*(\d+)\s*memberships?/i);
    return m ? Math.max(1, parseInt(m[1], 10) || 1) : 0;
  }
  function dbg(...args) { if (process.env.DEBUG_GOAL) console.log('[goal]', ...args); }

  // initialize from disk
  load().then(()=>{}).catch(()=>{});

  return {
    getGraffiti, setGraffiti,
    getGoal, saveGoal, addToGoal, clearGoal,
    snapshot,
    onChange, maybeAdvanceFromEvent,
  };
}
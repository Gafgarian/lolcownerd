import { supabase } from '../db/supabase.js';
import {
  COLOR_TO_SHOTS,
  GIFT_BASE_RATE,
  GIFT_MAX_CAP_25,
  GIFT_MAX_CAP_50,
  BONUS_K,
  RAND_GAMMA_BASE,
  RAND_GAMMA_MIN,
} from '../rules.js';
import fs from 'fs';
import path from 'path';

const ACH_PATH = path.resolve(process.cwd(), 'data/achievements.json');
const ACHIEVEMENTS = JSON.parse(fs.readFileSync(ACH_PATH, 'utf-8'));

// Decay tuning: e^{-k*7200}≈0.05 → k≈0.000415
const DECAY_K_BASE = 0.000415;
// viewer influence: 300 = neutral; >300 faster decay; <300 slower
const VIEWERS_BASELINE = 300;
const VIEWERS_INFLUENCE = 0.6;
// tiny jitter to feel organic
const JITTER_STD = 0.0025; // per second

// ---------------------- ADDITIONAL HOST LOGIC
const HOST_ORDER = [
  { name: 'buff' },        // first
  { name: 'batgirl' }       // second
];

// NEW: thresholds at which a NEW host joins based on the *average* drunkness
// Start simple: only add the 2nd host at 50%.
const JOIN_THRESHOLDS = [0.50 /*, 0.67, 0.75, 0.80 …*/];


// Engine state
let hosts = [
  { name: HOST_ORDER[0].name, drunk: 0, frame: 0 }  // start with first host
];
let nextHostIdx = 1;                // points into HOST_ORDER for the next join
let rr = 0;                         // round-robin pointer for shot assignment

function averageDrunk() {
  if (!hosts.length) return 0;
  let sum = 0; for (const h of hosts) sum += h.drunk;
  return sum / hosts.length;
}

// map drunk [0..1] → frame 0..7
function frameForDrunk(p) {
  const idx = Math.max(0, Math.min(7, Math.floor(p * 8))); // 8 frames
  return idx;
}

// Call this after *any* drunkness change.
function maybeJoinNewHost() {
  if (nextHostIdx >= HOST_ORDER.length) return;
  const need = JOIN_THRESHOLDS[Math.min(nextHostIdx - 1, JOIN_THRESHOLDS.length - 1)];
  if (typeof need !== 'number') return;

  if (averageDrunk() >= need) {
    const spec = HOST_ORDER[nextHostIdx++];
    hosts.push({ name: spec.name, drunk: 0, frame: 0 });
    // No changes to existing drunk values; average naturally drops.
  }
}

// Apply N “shots” to the engine
function applyShots(n = 1) {
  for (let i = 0; i < n; i++) {
    if (!hosts.length) continue;
    const idx = rr % hosts.length; rr++;
    const h = hosts[idx];

    // Choose how much one “shot” advances a host (tune as needed)
    const STEP = 0.02; // 2% per shot (example)
    h.drunk = Math.max(0, Math.min(1, h.drunk + STEP));
    h.frame = frameForDrunk(h.drunk);
  }
  maybeJoinNewHost();
}

// expose to your existing engine’s public API
export function engineSnapshot() {
  const avg = averageDrunk();
  return {
    drunkPct: avg,               // keep legacy field but now it’s the average
    totalShots, drunkPctHistory, // whatever else you already had
    hosts: hosts.map(h => ({ name: h.name, drunk: h.drunk, frame: h.frame }))
  };
}

export function onGiftOrShot(n) {
  applyShots(n);
  broadcast(engineSnapshot());   // however you publish SSE to viewer/admin
}

// END

function weightedUnit(n) {
  const gamma = Math.max(RAND_GAMMA_MIN, RAND_GAMMA_BASE - (n / 50) * 0.25);
  return Math.pow(Math.random(), gamma);
}

function makeGiftSchedule(n) {
  const clamped = Math.max(1, Math.min(50, n|0));
  const base = GIFT_BASE_RATE * clamped;
  const maxBonus = BONUS_K * clamped * clamped;
  const cap = clamped >= 50 ? GIFT_MAX_CAP_50 : (clamped >= 25 ? GIFT_MAX_CAP_25 : base + maxBonus);
  const bonus = Math.min(maxBonus * weightedUnit(clamped), cap - base);
  const total = Math.floor(base + bonus);
  const durationMs = clamped * 1000;

  // sorted timestamps relative to now
  const now = performance.now();
  const schedule = [];
  for (let i = 0; i < total; i++) {
    const t = now + (i / total) * durationMs;
    const jitter = (Math.random() - 0.5) * 0.2 * (durationMs / total); // ±10%
    const ts = Math.min(now + durationMs, Math.max(now, t + jitter));
    schedule.push(ts);
  }
  schedule.sort((a, b) => a - b);

  return { total, endsAt: now + durationMs, schedule };
}

export class ClickerEngine {
  constructor() {
    this.bound = null;
    this.lastSeenAt = null;

    // state
    this.totalShots = 0;
    this.drunkUnits = 0;         // raw units (1 per shot)
    this.drunkPct = 0;           // 0..100 derived
    this.maxDrunkPct = 0;
    this.shotRecord = 0;

    this.hosts = [{ name: 'buff', drunk: 0 }];  // 0..1
    this.nextHostIdx = 1;
    this.hostOrder = ['buff', 'batgirl'];       // second folder name
    this._rr = 0;   

    this.shotQueue = [];
    this.autoGift = null;
    this.logs = [];
    this.listeners = new Set();
    this.running = false;
    this.pollHandle = null;
    this.tickHandle = null;
    this.viewers = null;         // latest viewer count
    this.watermark = { id: 0, at: null };
    this.processedIds = new Set();

    // achievements
    this.unlockedIdx = -1;
    this.pendingAchievement = null;

    // broadcast throttle
    this.dirty = true;
    this.lastBroadcast = 0;
    this.broadcastHz = 6;
  }

  _setDirty(){ this.dirty = true; }

  // Randomized rate per second for gifted auto (min 4, max 7 shots/s)
  _pickGiftRate() {
    return 4 + Math.random() * 3; // [4,7)
  }

  // Extend or start the single auto gift timer by `seconds`
  _extendAutoGift(seconds, label='gift') {
    const now = performance.now();
    const ms = Math.max(1, seconds) * 1000;
    if (this.autoGift) {
      this.autoGift.endsAt += ms;              // stack time
      this.log(`gift stack +${seconds}s (remaining ${(Math.max(0, this.autoGift.endsAt - now)/1000).toFixed(1)}s)`);
    } else {
      this.autoGift = {
        endsAt: now + ms,
        acc: 0,                                 // fractional shot accumulator
        rate: this._pickGiftRate(),
        nextRateAt: now + 1000,
        label
      };
      this.log(`gift start ${seconds}s @ ~${this.autoGift.rate.toFixed(2)}/s`);
    }
    this._setDirty();
  }

  resetAll() {
    this.lastSeenAt = null;
    this.totalShots = 0;
    this.drunkUnits = 0;
    this.drunkPct = 0;
    this.maxDrunkPct = 0;
    this.shotRecord = 0;
    this.shotQueue = [];
    this.autoGift = null
    this.unlockedIdx = -1;
    this.pendingAchievement = null;
    this.viewers = null;
    this.watermark = { id: 0, at: null };
    if (this.processedIds) this.processedIds.clear(); else this.processedIds = new Set();
    this._setDirty();
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this._setDirty();
  }

  addListener(res) { this.listeners.add(res); }
  removeListener(res) { this.listeners.delete(res); }

  broadcast() {
    // throttle + send only when dirty
    const now = performance.now();
    const period = 1000 / this.broadcastHz;
    if (!this.dirty && (now - this.lastBroadcast) < period) return;

    const payload = JSON.stringify(this.viewModel());
    for (const res of this.listeners) res.write(`data: ${payload}\n\n`);
    this.lastBroadcast = now;
    this.dirty = false;
  }

  viewModel() {
    const now = performance.now();
    const active = this.autoGift ? 1 : 0;
    const nextEnd = this.autoGift ? this.autoGift.endsAt : null;
    const nextEta = nextEnd ? Math.max(0, nextEnd - now) : null;

    // one-time pop of unlocked achievement (if any)
    const unlocked = this.pendingAchievement;
    this.pendingAchievement = null;

    return {
      bound: this.bound,
      totalShots: this.totalShots,
      drunkPct: Number(this.drunkPct.toFixed(2)),
      drunkUnits: this.drunkUnits,
      maxDrunkPct: Number(this.maxDrunkPct.toFixed(2)),
      shotRecord: this.shotRecord,
      activeGifts: active,
      nextGiftEtaSec: nextEta ? Number((nextEta/1000).toFixed(1)) : null,
      queueDepth: this.shotQueue.length,
      currentViewers: this.viewers,
      nextAchievement: this._nextAchievementMeta(),
      unlocked,           // <-- viewer can toast
      logs: this.getLogTail(120), // helpful for admin
      hostsCount: this.hosts.length
    };
  }

  _nextAchievementMeta(){
    const next = ACHIEVEMENTS[this.unlockedIdx + 1];
    return next ? { threshold: next.threshold, name: next.name, emoji: next.emoji } : null;
  }

  async bindByVideoId(videoId) {
    if (!videoId) throw new Error('videoId required');

    // 1) Lookup stream
    const { data: stream, error: err1 } = await supabase
      .from('streams')
      .select('id, video_id, title')
      .eq('video_id', videoId)
      .limit(1)
      .maybeSingle();
    if (err1) throw new Error(`streams lookup failed: ${err1.message}`);
    if (!stream) throw new Error(`No stream found for video_id=${videoId}`);

    // 2) Tail watermark (do NOT replay history)
    const { data: tail, error: err2 } = await supabase
      .from('interaction_events_v')
      .select('id, at')
      .eq('stream_id', stream.id)
      .order('id', { ascending: false })
      .limit(1);
    if (err2) throw new Error(`events lookup failed: ${err2.message}`);

    const last = tail && tail[0];
    this.watermark = { id: last ? last.id : 0, at: last ? last.at : null };
    if (this.processedIds) this.processedIds.clear(); else this.processedIds = new Set();

    // 3) Bind
    this.bound = { stream_id: stream.id, video_id: stream.video_id, title: stream.title };
    this.lastSeenAt = null;
    this._setDirty();

    this.log(`Bound to video_id=${videoId} stream_id=${stream.id} tail id=${this.watermark.id}`);
    return this.bound;
  }

  start() {
    if (this.running) return;
    this.running = true;

    // poll Supabase events
    this.pollHandle = setInterval(() =>
      this.pollOnce().catch(e => this.log(`poll error: ${e.message}`)), 2000);

    // poll viewer snapshots (every 5s)
    this.viewersHandle = setInterval(() => this.fetchViewers().catch(()=>{}), 5000);

    // 50ms tick
    let lastTs = performance.now();
    this.tickHandle = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTs) / 1000; lastTs = now;

      // drain queued direct shots slowly (~8/s max)
      const perSec = 10;
      const perTick = perSec * dt;
      let n = Math.min(this.shotQueue.length, Math.floor(perTick + this._carry || 0));
      this._carry = (perTick + (this._carry || 0)) - n;
      while (n-- > 0) this._applyOneShot('queue');

      // gifted auto stream: 4–7 shots/sec, randomized each second, stacks time
      if (this.autoGift) {
        if (now >= this.autoGift.nextRateAt) {
          this.autoGift.rate = this._pickGiftRate();
          this.autoGift.nextRateAt = now + 1000;
        }
        // integrate fractional shots
        const dtShots = this.autoGift.rate * dt;
        this.autoGift.acc += dtShots;
        let toFire = Math.floor(this.autoGift.acc);
        if (toFire > 0) {
          this.autoGift.acc -= toFire;
          while (toFire-- > 0) this._applyOneShot('gift');
        }
        // finish
        if (now >= this.autoGift.endsAt) {
          this.log('gift finished');
          this.autoGift = null;
          this._setDirty();
        }
      }

      // decay drunkUnits → drunkPct
      this._applyDecay(dt);

      // achievements check
      this._checkAchievements();

      // broadcast (throttled)
      this.broadcast();
    }, 50);

    this.log('Engine started');
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.pollHandle);
    clearInterval(this.viewersHandle);
    clearInterval(this.tickHandle);
    this.pollHandle = this.viewersHandle = this.tickHandle = null;
    this.running = false;
    this.log('Engine stopped');
  }

  _applyOneShot(reason) {
    if (reason === 'queue') this.shotQueue.shift();
    this.totalShots += 1;
    if (this.totalShots > this.shotRecord) this.shotRecord = this.totalShots;

    // one shot advances *drinker* by 1/500 (→ 100% == 500 shots)
    const STEP = 1 / 500;
    const i = this._rr % this.hosts.length; this._rr++;
    this.hosts[i].drunk = Math.min(1, this.hosts[i].drunk + STEP);

    // auto-join 2nd host the first time the average reaches 0.50
    const avg = this.hosts.reduce((a, h) => a + h.drunk, 0) / this.hosts.length;
    if (avg >= 0.50 && this.hosts.length === 1 && this.nextHostIdx < this.hostOrder.length) {
      this.hosts.push({ name: this.hostOrder[this.nextHostIdx++], drunk: 0 });
      // average naturally halves because we added a 0-drunk guest
      this.log('Guest joined (host #2)');
    }

    this._setDirty();
  }

  _applyDecay(dt) {
    const viewers = this.viewers || 300;
    const factor = (viewers / 300);
    const k = 0.000415 * (1 + 0.6 * (factor - 1));
    const jitter = () => (Math.random() - 0.5) * 0.0025 * dt * 2;

    // decay each host
    for (const h of this.hosts) {
      h.drunk = Math.max(0, h.drunk * Math.exp(-(k*dt)) + jitter());
    }

    // combined meter is the average
    const avg = this.hosts.reduce((a, h) => a + h.drunk, 0) / this.hosts.length;
    const pct = Math.max(0, Math.min(100, avg * 100));
    const old = this.drunkPct;
    this.drunkPct = pct;
    if (pct > this.maxDrunkPct) this.maxDrunkPct = pct;
    if (Math.abs(this.drunkPct - old) >= 0.2) this._setDirty();
  }

  enqueueShots(count, reason) {
    for (let i = 0; i < count; i++) this.shotQueue.push(1);
    this.log(`+${count} shots (${reason})`);
    this._setDirty();
  }

  // Production path: each gift count == seconds to add; 4–7/s randomized
  scheduleGift(_id, count, label) {
    const seconds = Math.max(1, Math.min(50, count|0)); // per YT bundle
    this._extendAutoGift(seconds, label);
  }

  testGiftSeconds(seconds) { this._extendAutoGift(Math.max(1, seconds|0), 'admin-test'); }

  async fetchViewers() {
    if (!this.bound) return;
    const { stream_id } = this.bound;
    const { data, error } = await supabase
      .from('viewer_snapshots')
      .select('viewers, at')
      .eq('stream_id', stream_id)
      .order('at', { ascending: false })
      .limit(1);
    if (!error && data && data[0]) {
      const v = data[0].viewers;
      if (v !== this.viewers) { this.viewers = v; this._setDirty(); }
    }
  }

  _checkAchievements() {
    const nextIdx = this.unlockedIdx + 1;
    const next = ACHIEVEMENTS[nextIdx];
    if (next && this.totalShots >= next.threshold) {
      this.unlockedIdx = nextIdx;
      this.pendingAchievement = next;
      this.log(`ACHIEVE: ${next.name} @ ${next.threshold}`);
      this._setDirty();
    }
  }

  async pollOnce() {
    if (!this.bound) return;
    const { stream_id } = this.bound;

    const { data, error } = await supabase
      .from('interaction_events_v')
      .select('id, at, type, tier, gift_count')
      .eq('stream_id', stream_id)
      .gt('id', this.watermark.id)        // ONLY new rows
      .order('id', { ascending: true })
      .limit(500);

    if (error) { this.log(`poll error: ${error.message}`); return; }
    if (!data || !data.length) return;

    for (const row of data) {
      if (this.processedIds.has(row.id)) continue;
      this.processedIds.add(row.id);

      if (row.type === 'superchat') {
        const shots = (COLOR_TO_SHOTS[row.tier] ?? 0) | 0;
        if (shots > 0) this.enqueueShots(shots, 'poll');
      } else if (row.type === 'gift') {
        const n = Math.max(1, Math.min(50, row.gift_count|0));
        this.scheduleGift(`gift-${row.id}`, n, 'poll');  // stacks time
      } else if (row.type === 'membership') {
        // for now: ignore or map to a tiny auto if you decide (e.g., 1s @ 2/s)
        // this.scheduleGift(`member-${row.id}`, 1, 'membership');
      }
      this.watermark.id = row.id;       // advance watermark
      this.lastSeenAt = row.at;
    }
  }

  // admin-tail logs (latest n)
  getLogTail(n = 120) { return this.logs.slice(-n); }

  // TEST hooks
  testAddShots(n=1){ this.enqueueShots(Math.max(1,n|0), 'admin-test'); }
  testGift(n=5){ this.scheduleGift(`test-${Date.now()}`, Math.max(1, Math.min(50, n|0)), 'admin-gift'); }
}
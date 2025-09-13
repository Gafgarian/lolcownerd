// src/logic/clickerEngine.js
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

// ===== Tuning =====
const DECAY_K_BASE = 0.000415;
const VIEWERS_BASELINE = 300;
const VIEWERS_INFLUENCE = 0.6;
const JITTER_STD = 0.0025;

const AUTO_GIFT_DURATION_SCALE = 2;
const AUTO_GIFT_RATE_SCALE     = 0.5;

const HOST_ORDER = ['buff', 'batgirl', 'stake'];

const JOIN_AT = 0.30;
const JOIN_REARM_AT = 0.27;

const SHOT_START_DELAY_MS = 1500;
const DONO_STAGGER_MS = 160;
const STEP_PER_SHOT = 1 / 500;

// ===== Helpers =====
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function weightedUnit(n) {
  const gamma = Math.max(RAND_GAMMA_MIN, RAND_GAMMA_BASE - (n / 50) * 0.25);
  return Math.pow(Math.random(), gamma);
}

function makeGiftSchedule(n) {
  const clamped = Math.max(1, Math.min(50, n|0));
  const base = GIFT_BASE_RATE * clamped;
  const maxBonus = BONUS_K * clamped * clamped;
  const cap = clamped >= 50 ? GIFT_MAX_CAP_50 :
              (clamped >= 25 ? GIFT_MAX_CAP_25 : base + maxBonus);
  const bonus = Math.min(maxBonus * weightedUnit(clamped), cap - base);
  const total = Math.floor(base + bonus);
  const durationMs = clamped * 1000;

  const now = performance.now();
  const schedule = [];
  for (let i = 0; i < total; i++) {
    const t = now + (i / total) * durationMs;
    const jitter = (Math.random() - 0.5) * 0.2 * (durationMs / total);
    const ts = Math.min(now + durationMs, Math.max(now, t + jitter));
    schedule.push(ts);
  }
  schedule.sort((a, b) => a - b);
  return { total, endsAt: now + durationMs, schedule };
}

// ===== Engine =====
export class ClickerEngine {
  /**
   * @param {{ onEventForGoal?: (evt:{type:string, tier?:string, gift_count?:number})=>void }} [opts]
   */
  constructor(opts = {}) {
    this.bound = null;
    this.lastSeenAt = null;

    // Aggregate state
    this.totalShots = 0;
    this.drunkPct = 0;
    this.drunkUnits = 0;
    this.maxDrunkPct = 0;
    this.shotRecord = 0;

    // Per-host state
    this.hostOrder = HOST_ORDER.slice();
    this.hosts = [{ name: this.hostOrder[0], drunk: 0 }];
    this.nextHostIdx = 1;
    this._rr = 0;
    this._joinArmed = true;

    // Queues / timers
    this.shotQueue = [];
    this.autoGift = null;

    // Misc
    this.logs = [];
    this.listeners = new Set();
    this.running = false;
    this.pollHandle = null;
    this.tickHandle = null;
    this.viewers = null;
    this.watermark = { id: 0, at: null };
    this.processedIds = new Set();

    // One-shot UI pings
    this.unlockedIdx = -1;
    this.pendingAchievement = null;
    this.pendingShout = null;
    this._shout = null;
    this._shoutSeq = 0;
    this._shoutUntil = 0;
    this._shoutTTLms = 2500;

    // Broadcast throttle
    this.dirty = true;
    this.lastBroadcast = 0;
    this.broadcastHz = 6;

    // Goal advancement hook
    this._goalHook = typeof opts.onEventForGoal === 'function' ? opts.onEventForGoal : null;
  }

  // ---- utils ---------------------------------------------------------------
  _setDirty(){ this.dirty = true; }
  _avgHostDrunk() {
    const n = this.hosts.length || 1;
    let sum = 0;
    for (const h of this.hosts) sum += h.drunk;
    return sum / n;
  }
  _noteShout(name) {
    if (!name) return;
    this._shout = { name: String(name).slice(0, 64), seq: ++this._shoutSeq };
    this._shoutUntil = performance.now() + this._shoutTTLms;
    this._setDirty();
  }
  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this._setDirty();
  }
  getLogTail(n = 120) { return this.logs.slice(-n); }

  addListener(res) { this.listeners.add(res); }
  removeListener(res) { this.listeners.delete(res); }

  // ---- lifecycle -----------------------------------------------------------
  resetAll() {
    this.lastSeenAt = null;
    this.totalShots = 0;
    this.drunkPct = 0;
    this.maxDrunkPct = 0;
    this.shotRecord = 0;

    this.hosts = [{ name: this.hostOrder[0], drunk: 0 }];
    this.nextHostIdx = 1;
    this._rr = 0;
    this._joinArmed = true;

    this.shotQueue = [];
    this.autoGift = null;

    this.unlockedIdx = -1;
    this.pendingAchievement = null;
    this.pendingShout = null;

    this.viewers = null;
    this.watermark = { id: 0, at: null };
    if (this.processedIds) this.processedIds.clear(); else this.processedIds = new Set();

    this.logs = [];
    this._setDirty();
  }

  start() {
    if (this.running) return;
    this.running = true;

    this.pollHandle = setInterval(() =>
      this.pollOnce().catch(e => this.log(`poll error: ${e.message}`)),
      2000);

    this.viewersHandle = setInterval(() =>
      this.fetchViewers().catch(()=>{}),
      5000);

    let lastTs = performance.now();
    this.tickHandle = setInterval(() => {
      const now = performance.now();
      const dt = (now - lastTs) / 1000; lastTs = now;

      const perSec = 10;
      const perTick = perSec * dt;

      let readyHead = 0;
      while (readyHead < this.shotQueue.length && this.shotQueue[readyHead] <= now) readyHead++;

      let toFire = Math.min(readyHead, Math.floor(perTick + (this._carry || 0)));
      this._carry = (perTick + (this._carry || 0)) - toFire;
      while (toFire-- > 0) this._applyOneShot('queue');

      if (this.autoGift) {
        if (now >= this.autoGift.nextRateAt) {
          this.autoGift.rate = this._pickGiftRate();
          this.autoGift.nextRateAt = now + 1000;
        }
        const dtShots = this.autoGift.rate * dt;
        this.autoGift.acc += dtShots;
        let giftToFire = Math.floor(this.autoGift.acc);
        if (giftToFire > 0) {
          this.autoGift.acc -= giftToFire;
          while (giftToFire-- > 0) this._applyOneShot('gift');
        }
        if (now >= this.autoGift.endsAt) {
          this.log('gift finished');
          this.autoGift = null;
          this._setDirty();
        }
      }

      this._applyDecay(dt);
      this._checkAchievements();
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

  // ---- internals -----------------------------------------------------------
  _pickGiftRate() {
    return (4 + Math.random() * 3) * AUTO_GIFT_RATE_SCALE;
  }

  _applyOneShot(reason) {
    if (reason === 'queue') this.shotQueue.shift();
    this.totalShots += 1;
    if (this.totalShots > this.shotRecord) this.shotRecord = this.totalShots;

    const i = this._rr % this.hosts.length; this._rr++;
    const h = this.hosts[i];
    h.drunk = clamp01(h.drunk + STEP_PER_SHOT);

    let avg = this._avgHostDrunk();
    if (this._joinArmed && this.nextHostIdx < this.hostOrder.length && avg >= JOIN_AT) {
      const name = this.hostOrder[this.nextHostIdx++];
      this.hosts.push({ name, drunk: 0 });
      this._joinArmed = false;
      this.log(`Guest joined (${this.hosts.length}/${this.hostOrder.length}): ${name}`);
      avg = this._avgHostDrunk();
    }

    this._setDirty();
  }

  _applyDecay(dt) {
    const viewers = this.viewers || VIEWERS_BASELINE;
    const factor = (viewers / VIEWERS_BASELINE);
    const k = DECAY_K_BASE * (1 + VIEWERS_INFLUENCE * (factor - 1));
    const jitter = () => (Math.random() - 0.5) * JITTER_STD * dt * 2;

    for (const h of this.hosts) {
      h.drunk = Math.max(0, h.drunk * Math.exp(-(k * dt)) + jitter());
    }

    const avg = this._avgHostDrunk();
    const pct = Math.max(0, Math.min(100, avg * 100));
    const old = this.drunkPct;
    this.drunkPct = pct;
    if (pct > this.maxDrunkPct) this.maxDrunkPct = pct;

    if (!this._joinArmed && avg < JOIN_REARM_AT) this._joinArmed = true;

    if (Math.abs(this.drunkPct - old) >= 0.2) this._setDirty();
  }

  enqueueShots(count, reason) {
    const now = performance.now();
    const gate = now + SHOT_START_DELAY_MS;

    const isGiftLike = /gift/i.test(String(reason || ''));
    const stagger    = isGiftLike ? 0 : DONO_STAGGER_MS;

    for (let i = 0; i < count; i++) {
      this.shotQueue.push(gate + i * stagger);
    }

    this.log(
      `+${count} shots (${reason || 'queue'}) ready @ +${(SHOT_START_DELAY_MS/1000).toFixed(1)}s` +
      (stagger ? ` (stagger ${stagger}ms)` : '')
    );
    this._setDirty();
  }

  scheduleGift(_id, count, label) {
    const seconds = Math.max(1, Math.min(50, count|0));
    this._extendAutoGift(seconds, label);
  }
  _extendAutoGift(seconds, label='gift') {
    const now = performance.now();
    const ms  = Math.max(1, seconds) * 1000 * AUTO_GIFT_DURATION_SCALE;

    if (this.autoGift) {
      this.autoGift.endsAt += ms;
      this.log(
        `gift stack +${seconds}s (x${AUTO_GIFT_DURATION_SCALE} dur, ` +
        `remaining ${(Math.max(0, this.autoGift.endsAt - now) / 1000).toFixed(1)}s)`
      );
    } else {
      this.autoGift = { endsAt: now + ms, acc: 0, rate: this._pickGiftRate(), nextRateAt: now + 1000, label };
      this.log(
        `gift start ${seconds}s (x${AUTO_GIFT_DURATION_SCALE} dur) ` +
        `@ ~${this.autoGift.rate.toFixed(2)}/s`
      );
    }
    this._setDirty();
  }

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

  async bindByVideoId(videoId) {
    if (!videoId) throw new Error('videoId required');

    const { data: stream, error: err1 } = await supabase
      .from('streams')
      .select('id, video_id, title')
      .eq('video_id', videoId)
      .limit(1)
      .maybeSingle();
    if (err1) throw new Error(`streams lookup failed: ${err1.message}`);
    if (!stream) throw new Error(`No stream found for video_id=${videoId}`);

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

    this.bound = { stream_id: stream.id, video_id: stream.video_id, title: stream.title };
    this.lastSeenAt = null;
    this._setDirty();

    this.log(`Bound to video_id=${videoId} stream_id=${stream.id} tail id=${this.watermark.id}`);
    return this.bound;
  }

  async pollOnce() {
    if (!this.bound) return;
    const { stream_id } = this.bound;

    const { data, error } = await supabase
      .from('interaction_events_v')
      .select('id, at, type, tier, gift_count, author, message')
      .eq('stream_id', stream_id)
      .gt('id', this.watermark.id)
      .order('id', { ascending: true })
      .limit(500);

    if (error) { this.log(`poll error: ${error.message}`); return; }
    if (!data || !data.length) return;

    for (const row of data) {
      if (this.processedIds.has(row.id)) continue;
      this.processedIds.add(row.id);

      const name = row.author || 'NDF Anon';

      if (row.type === 'superchat') {
        const shots = (COLOR_TO_SHOTS[row.tier] ?? 0) | 0;
        if (shots > 0) {
          this.enqueueShots(shots, `SC[${row.tier}] +${shots} shots (poll) by ${name}`);
          this._noteShout(name);
        }
      } else if (row.type === 'gift') {
        const n = Math.max(1, Math.min(50, row.gift_count|0));
        this.scheduleGift(`gift-${row.id}`, n, `poll by ${name}`);
        this._noteShout(name);
      } else if (row.type === 'membership') {
        // optional: ignore
      }

      // NEW: notify goal store on every donor event
      if (this._goalHook) {
        try {
          this._goalHook({
            type: row.type,
            tier: row.tier,
            gift_count: row.gift_count|0
          });
        } catch {} // never break the poll loop
      }

      this.watermark.id = row.id;
      this.lastSeenAt = row.at;
    }
  }

  // ---- API surface used by routes -----------------------------------------
  broadcast() {
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
    const shout = (this._shout && now <= this._shoutUntil) ? this._shout : null;
    if (this._shout && now > this._shoutUntil) this._shout = null;

    const active = this.autoGift ? 1 : 0;
    const nextEnd = this.autoGift ? this.autoGift.endsAt : null;
    const nextEta = nextEnd ? Math.max(0, nextEnd - now) : null;
    const unlocked = this.pendingAchievement; this.pendingAchievement = null;

    return {
      bound: this.bound,
      sandbox: !this.bound && (this.running || this.totalShots > 0 || this.shotQueue.length > 0 || !!this.autoGift),
      totalShots: this.totalShots,
      drunkPct: Number(this.drunkPct.toFixed(2)),
      maxDrunkPct: Number(this.maxDrunkPct.toFixed(2)),
      shotRecord: this.shotRecord,
      activeGifts: active,
      nextGiftEtaSec: nextEta ? Number((nextEta/1000).toFixed(1)) : null,
      queueDepth: this.shotQueue.length,
      currentViewers: this.viewers,
      unlocked,
      shout,
      hostsCount: this.hosts.length,
      logs: this.getLogTail(120),
    };
  }

  testAddShots(n = 1, author = 'Admin'){
    const count = Math.max(1, n|0);
    this.enqueueShots(count, `admin-test by ${author}`);
    this._noteShout(author);
  }
  testGiftSeconds(seconds = 5, author = 'Admin'){
    const s = Math.max(1, seconds|0);
    this._extendAutoGift(s, `admin-gift by ${author}`);
    this._noteShout(author);
  }
}
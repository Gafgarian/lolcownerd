import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';

console.log(process.env.SUPABASE_URL);

// ── Supabase init (NEW) ──
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY || '';
const sb = (SUPABASE_URL && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;


/* ───────────────────────────── logging controls ───────────────────────────── */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = (LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? 2);
const PAGE_CONSOLE = (process.env.PAGE_CONSOLE || 'errors').toLowerCase(); // none|errors|all
const META_VERBOSE = process.env.META_VERBOSE === '1';
const DEDUP_MS = +(process.env.LOG_DEDUP_MS || 15000);

const ts = () => new Date().toISOString();
const should = lvl => lvl <= LOG_LEVEL;

const log = {
  error: (...a) => should(0) && console.error(ts(), ...a),
  warn:  (...a) => should(1) && console.warn(ts(), ...a),
  info:  (...a) => should(2) && console.log(ts(), ...a),
  debug: (...a) => should(3) && console.log(ts(), ...a),
  tag:   (id, ...a) => should(2) && console.log(ts(), `[session ${id}]`, ...a),
};

const IGNORE_RX = [
  /Failed to load resource: net::ERR_FAILED/i,
  /A network error occurred/i,
  /server responded with a status of 403/i,
  /Failed to get ServiceWorkerRegistration objects/i,
  /requestIdleCallback.*IdleRequestOptions/i,
  /A preload for .* is found, but is not used/i,
  /WebGL-0x/i, // GL driver spam
];

const BENIGN_HOSTS_RX =
  /(^|\.)ytimg\.com$|(^|\.)googlevideo\.com$|(^|\.)gstatic\.com$|(^|\.)google-analytics\.com$/i;

const ABORTED_TYPES = new Set(['image','media','font','stylesheet','preload','prefetch','beacon']);

const _dedupSeen = new Map();
function logDedup(key, fn, ttlMs = DEDUP_MS) {
  const now = Date.now();
  const until = (Number(_dedupSeen.get(key)) || 0);
  if (until > now) return;
  try { fn(); } finally { _dedupSeen.set(key, now + ttlMs); }
  for (const [k, u] of _dedupSeen) if (u < now) _dedupSeen.delete(k);
}

const slog = (id, ...args) => should(2) && console.log(ts(), `[session ${id}]`, ...args);

/* ─────────────────────────────── crash logging ────────────────────────────── */
process.on('unhandledRejection', e => log.error('[unhandledRejection]', e));
process.on('uncaughtException',  e => log.error('[uncaughtException]', e));

/* --------------------------------- state ---------------------------------- */
/** id -> { browser, context, page, sinks:Set<res>, videoId, meta, timers, onAutoStop } */
const sessions = new Map();
let _starting = false;

/* ---------------------------- Render-friendly PW --------------------------- */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--renderer-process-limit=1',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-features=Translate,MediaRouter',
  '--mute-audio',
  '--hide-scrollbars',
  '--blink-settings=imagesEnabled=false',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launchBrowserOnce() {
  const browser = await chromium.launch({
    headless: true,
    args: CHROME_ARGS,
    timeout: 240_000,
  });

  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 360, height: 640 },
  });

  await context.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.youtube.com/',
  });

  // Block heavy/irrelevant resources
  await context.route('**/*', route => {
    const req = route.request();
    const t   = req.resourceType();
    let host = '';
    try { host = new URL(req.url()).hostname; } catch {}

    if (ABORTED_TYPES.has(t)) return route.abort();
    if (/doubleclick\.net|googleads|adservice\.google\.com/i.test(host)) return route.abort();
    if ((t === 'xhr' || t === 'fetch') && !/(\.|^)youtube\.com$/i.test(host)) return route.abort();
    return route.continue();
  });

  // Disable Service Workers + animations (lower CPU/mem)
  await context.addInitScript(() => {
    try {
      const sw = navigator.serviceWorker;
      if (sw) {
        sw.getRegistrations?.().then(rs => rs.forEach(r => r.unregister?.()));
        const orig = sw.register?.bind(sw);
        if (orig) sw.register = () => Promise.reject(new Error('sw disabled'));
      }
    } catch {}
    try {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important}';
      document.documentElement.appendChild(style);
    } catch {}
  });

  // Cookie to avoid consent wall
  try {
    const oneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    await context.addCookies([
      { name: 'CONSENT', value: 'YES+cb.20210328-17-p0.en+FX', domain: '.youtube.com', path: '/', expires: oneYear, httpOnly: false, secure: true, sameSite: 'Lax' },
    ]);
  } catch {}

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);
  return { browser, context, page };
}

async function launchBrowserWithRetry(retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await launchBrowserOnce(); }
    catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000)); }
  }
  throw lastErr;
}

/* ----------------------------------- app ----------------------------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

/* -------------------------- helpers & enrichment --------------------------- */
// ── Membership level extraction ──
const MEMBERSHIP_LEVELS = ['ban world','cash cow','pay pig','crown'];

function extractMembershipLevel(raw) {
  const hay = `${raw?.header || ''} ${raw?.message || ''}`.toLowerCase();
  for (const lvl of MEMBERSHIP_LEVELS) {
    if (hay.includes(lvl)) return lvl;        // exact level hit
  }
  // final regex fallback (case-insensitive, handles extra spaces)
  const m = hay.match(/\b(ban\s+world|cash\s+cow|pay\s+pig|crown)\b/i);
  return m ? m[1].toLowerCase() : null;
}

async function sbUpsertStream(videoId, title) {
  if (!sb) return null;
  const { data, error } = await sb
    .from('streams')
    .upsert({ video_id: videoId, title }, { onConflict: 'video_id' })
    .select()
    .single();
  if (error) log.warn('[supabase upsert stream]', error.message);
  return data || null;
}
async function sbUpdateStreamTitle(streamId, title) {
  if (!sb || !streamId || !title) return;
  await sb.from('streams').update({ title }).eq('id', streamId);
}

async function sbUpdateMaxViewers(streamId, proposed) {
  if (!sb || !streamId || !Number.isFinite(proposed) || proposed <= 0) return;
  await sb
    .from('streams')
    .update({ max_viewers: proposed })
    .eq('id', streamId)
    .lt('max_viewers', proposed)
    .select('id'); // no-op if stored >= proposed
}

async function sbInsertEvent(streamId, ev) {
  if (!sb || !streamId) return;

  const row = {
    stream_id: streamId,
    at: new Date(ev.at || Date.now()).toISOString(),
    type: ev.type,
    author: ev.author || null,

    // For membership events, store the LEVEL as the message
    message: ev.type === 'membership'
      ? (ev.membershipLevel || ev.message || 'member')
      : (ev.message || null),

    amount_text: ev.amount || null,
    amount_float: ev.amountFloat || null,
    currency: ev.currencyGuess || null,
    tier: ev.tier || 'unknown',
    yt_color: ev.color || (ev.colorVars && ev.colorVars.primary) || null,
    gift_count: ev.type === 'gift' ? (ev.count || 1) : null
  };

  const { error } = await sb.from('stream_events').insert(row);
  if (error) console.error('[SB] insert event:', error.message, row);
}

async function sbInsertViewerSnapshot(streamId, viewers) {
  if (!sb || !streamId || typeof viewers !== 'number') return;
  await sb.from('viewer_snapshots').insert({ stream_id: streamId, viewers });
}

function toPopoutUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    const vid = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
    return {
      videoId: vid,
      live:   `https://www.youtube.com/live_chat?is_popout=1&v=${vid}`,
      replay: `https://www.youtube.com/live_chat_replay?is_popout=1&v=${vid}`,
      watch:  `https://www.youtube.com/watch?v=${vid}`
    };
  } catch {
    const vid = inputUrl;
    return {
      videoId: vid,
      live:   `https://www.youtube.com/live_chat?is_popout=1&v=${vid}`,
      replay: `https://www.youtube.com/live_chat_replay?is_popout=1&v=${vid}`,
      watch:  `https://www.youtube.com/watch?v=${vid}`
    };
  }
}

async function clickConsentIfPresent(page) {
  const sels = [
    'button[aria-label*="Agree"]',
    'button:has-text("I agree")',
    '#introAgreeButton',
    'button[aria-label*="accept"]',
  ];
  for (const sel of sels) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click({ timeout: 1500 }).catch(()=>{}); break; }
    } catch {}
  }
}

function amountToFloat(s = '') {
  const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : 0;
}
function guessCurrency(s = '') {
  if (/USD|\$/.test(s)) return 'USD';
  if (/CA\$|C\$/.test(s)) return 'CAD';
  if (/€/.test(s)) return 'EUR';
  if (/£/.test(s)) return 'GBP';
  if (/¥/.test(s)) return 'JPY';
  return 'UNK';
}
const COLOR_TO_TIER = {
  'rgba(30,136,229,1)': 'blue',
  'rgba(0,229,255,1)' : 'lblue',
  'rgba(29,233,182,1)': 'green',
  'rgba(255,202,40,1)': 'yellow',
  'rgba(245,124,0,1)' : 'orange',
  'rgba(233,30,99,1)' : 'pink',
  'rgba(230,33,23,1)' : 'red'
};
function tierFromPrimaryColor(c) {
  if (!c) return null;
  const m = String(c).match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  const key = `rgba(${+m[1]},${+m[2]},${+m[3]},1)`;
  return COLOR_TO_TIER[key] || null;
}

function enrichAndFilter(raw, videoId) {
  const at = raw.timestamp || Date.now();
  const base = { at, videoId, author: raw.author || '', message: raw.message || '' };

  switch (raw.type) {
    case 'superchat': {
      const amountFloat = amountToFloat(raw.amount || '');
      if (!amountFloat) return null;
      const currencyGuess = guessCurrency(raw.amount || '');
      const colorTier = tierFromPrimaryColor(raw.color || raw.colorVars?.primary);
      const tier = colorTier || 'unknown';
      return {
        type: 'superchat',
        ...base,
        amount: raw.amount || '',
        amountFloat,
        currencyGuess,
        tier,
        color: raw.color || raw.colorVars?.primary || null,
        colorVars: raw.colorVars || null
      };
    }
    case 'gift': {
      let count = Number.isFinite(raw.count) ? raw.count : 0;
      if (!count || count < 1) {
        const text = ((raw.message || raw.header || '')).replace(/,/g, '').replace(/\s+/g, ' ');
        const m =
          text.match(/(?:sent\s*)?(\d+)\D{0,80}gift(?:ed|ing)?\s*memberships?/i) ||
          text.match(/gift(?:ed|ing)?\D{0,40}(\d+)\D*memberships?/i) ||
          text.match(/(\d+)/);
        if (m) count = parseInt(m[1], 10);
      }
      if (!count || count < 1) count = 1;
      return { type: 'gift', ...base, count };
    }
    case 'membership': {
      const level = extractMembershipLevel(raw);
      return {
        type: 'membership',
        ...base,
        header: raw.header || '',
        message: level || 'member',    
        membershipLevel: level || null 
      };
    }
    case 'milestone': {
      const text = `${raw.header || ''} ${raw.message || ''}`;
      const mm = text.match(/(\d+)\s*month/i);
      const months = mm ? parseInt(mm[1], 10) : undefined;
      return { type: 'milestone', ...base, header: raw.header || '', months };
    }
    case 'chat': {
      if (!base.message && !base.author) return null;
      return { type: 'chat', ...base };
    }
    default:
      return null;
  }
}

const API_KEY = process.env.PARSER_API_KEY || '';
function requireKey(req, res, next) {
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  next();
}

/* ------------------------------- session core ------------------------------ */
async function startSessionDetached(url) {
  const id = nanoid();
  sessions.set(id, {
    browser: null, context: null, page: null,
    sinks: new Set(), videoId: null, meta: {},
    metaTimer: null, metaBusy: false,
    watchdogTimer: null, idleCheckTimer: null, onAutoStop: null
  });
  startSession(url, id)
    .then(() => slog(id, 'ready'))
    .catch(err => {
      log.error(`[session ${id}] failed start`, err);
      const s = sessions.get(id);
      if (s) s.error = err?.message || String(err);
    });
  return id;
}

async function startSession(url, idArg) {
  const id = idArg || nanoid();
  const { live, replay, watch, videoId } = toPopoutUrl(url);
  slog(id, 'start', { live, replay, watch, videoId });

  let browser, context, page;
  try {
    ({ browser, context, page } = await launchBrowserWithRetry(2));

    sessions.set(id, {
      browser, context, page,
      sinks: (sessions.get(id)?.sinks) || new Set(),
      videoId, meta: { title: undefined, viewers: undefined, maxViewers: 0 },
      metaTimer: null, metaBusy: false,
      watchdogTimer: null, idleCheckTimer: null, onAutoStop: null
    });

    const streamRow = await sbUpsertStream(videoId, '');
    const sInit = sessions.get(id);
    if (sInit) {
      sInit.streamId = streamRow?.id || null;
      // Seed meta with the stored high-watermark so reconnects don't start at 0.
      sInit.meta = { title: undefined, viewers: undefined, maxViewers: Number(streamRow?.max_viewers) || 0 };
    }

    /* ── page log filtering ── */
    page.on('console', msg => {
      if (PAGE_CONSOLE === 'none') return;
      const type = msg.type();
      if (PAGE_CONSOLE === 'errors' && type !== 'error') return;
      const text = msg.text() || '';
      if (IGNORE_RX.some(rx => rx.test(text))) return;
      const host = (text.match(/https?:\/\/([^/\s]+)/i) || [,''])[1];
      if (host && BENIGN_HOSTS_RX.test(host)) return;

      logDedup(`console|${type}|${text.slice(0,200)}`, () => {
        log.warn(`[session ${id}] page console ${type}: ${text.slice(0,300)}`);
      });
    });

    page.on('pageerror', e => {
      const text = String(e?.message || e || '');
      if (IGNORE_RX.some(rx => rx.test(text))) return;
      logDedup(`pageerror|${text.slice(0,200)}`, () =>
        log.warn(`[session ${id}] pageerror: ${text}`)
      );
    });

    page.on('requestfailed', req => {
      try {
        const t   = req.resourceType();
        if (ABORTED_TYPES.has(t)) return;
        const url = req.url();
        const host = (url.match(/^https?:\/\/([^/]+)/i) || [,''])[1];
        if (host && BENIGN_HOSTS_RX.test(host)) return;
        const err = req.failure()?.errorText || 'unknown';
        if (IGNORE_RX.some(rx => rx.test(err))) return;
        log.info(`[session ${id}] requestfailed ${t}: ${err} → ${url}`);
      } catch {}
    });

    const push = (payload) => {
      const s = sessions.get(id);
      if (!s) return;
      const line = `data: ${JSON.stringify(payload)}\n\n`;
      for (const sink of s.sinks) sink.write(line);
    };

    let lastChatAt = Date.now();

    // Accept events only from the popout chat frame (prevents dupes)
    await page.exposeBinding('pushChatEvent', (source, payload) => {
      const fUrl = source?.frame?.url() || '';
      if (!/\/(live_chat|live_chat_replay)\?/.test(fUrl)) return;

      if (payload && payload.type && payload.type !== 'status') lastChatAt = Date.now();
      const enriched = enrichAndFilter(payload, videoId);
      if (enriched) {
        push(enriched);
        const s = sessions.get(id);
        if (s?.streamId) sbInsertEvent(s.streamId, enriched).catch(()=>{});
      }
    });

    /* -------------------------- idle closer + autostop -------------------------- */
    function attachIdleCloser(sessionId) {
      const IDLE_MS = 60_000;
      let timer = null;

      const check = () => {
        const s = sessions.get(sessionId);
        if (!s) return;
        if (s.sinks.size === 0) {
          if (!timer) {
            timer = setTimeout(() => {
              slog(sessionId, 'idle: no clients for 60s -> autostop');
              app.emit('autostop', sessionId);
            }, IDLE_MS);
          }
        } else if (timer) {
          clearTimeout(timer); timer = null;
        }
      };
      const t = setInterval(check, 5000);
      const s0 = sessions.get(sessionId); if (s0) s0.idleCheckTimer = t;
    }

    const onAutoStop = async (sid) => {
      if (sid !== id) return;
      const s = sessions.get(sid); if (!s) return;
      slog(id, 'autostop: cleaning up');
      try {
        clearInterval(s.metaTimer);
        clearInterval(s.watchdogTimer);
        clearInterval(s.idleCheckTimer);
        await s.page?.close().catch(()=>{});
        await s.context?.close?.().catch(()=>{});
        await s.browser?.close().catch(()=>{});
      } finally {
        app.off('autostop', s.onAutoStop);
        sessions.delete(sid);
      }
    };
    app.on('autostop', onAutoStop);
    const sAS = sessions.get(id); if (sAS) sAS.onAutoStop = onAutoStop;
    attachIdleCloser(id);

    /* ------------------------------ watchdog nudge ------------------------------ */
    const wd = setInterval(async () => {
      try {
        const lastInPage = await page.evaluate(() => window.__lastPushAt || 0);
        const stale = Date.now() - Math.max(lastChatAt, lastInPage);
        if (stale > 30000) {
          slog(id, 'watchdog: stale chat, nudging page');
          await page.evaluate(() => {
            window.dispatchEvent(new Event('yt-navigate-finish'));
            const e = document.querySelector('yt-live-chat-app') || document.body;
            if (e && e.scrollTo) e.scrollTo(0, 1e9);
          });
        }
      } catch (e) {
        slog(id, 'watchdog error', String(e?.message || e));
      }
    }, 10000);
    const sWD = sessions.get(id); if (sWD) sWD.watchdogTimer = wd;

    /* ------------------------------ chat observer ------------------------------ */
    async function injectObserver() {
      const script = `
      (() => {
        if (window.top !== window) return;
        if (window.__CHAT_OBSERVER_INSTALLED) return;
        window.__CHAT_OBSERVER_INSTALLED = true;

        const now = () => Date.now();
        window.__lastPushAt = now();

        function queryAllDeep(sel, root=document) {
          const out=[]; const seen=new Set(); const stack=[root];
          while (stack.length) {
            const n = stack.pop(); if (!n) continue;
            if (n.querySelectorAll) n.querySelectorAll(sel).forEach(el => { if(!seen.has(el)){ seen.add(el); out.push(el);} });
            const sr = n.shadowRoot; if (sr && !seen.has(sr)) stack.push(sr);
            if (n.children) for (const c of n.children) stack.push(c);
            if (n instanceof ShadowRoot && n.host && !seen.has(n.host)) stack.push(n.host);
          }
          return out;
        }
        const queryDeep = (sel, root=document) => queryAllDeep(sel, root)[0] || null;
        const deepText = (sel, scope=document) => { const el = queryDeep(sel, scope); return (el && (el.textContent||'').trim()) || ''; };

        function findItemsRoot() {
          const hosts = queryAllDeep('yt-live-chat-item-list-renderer');
          for (const host of hosts) {
            const sr = host.shadowRoot; if (!sr) continue;
            const items = sr.querySelector('#items') || sr.querySelector('#contents');
            if (items) return items;
          }
          return queryDeep('#items') || queryDeep('#contents') || null;
        }

        const q = [];
        let flushId = 0;
        const publish = (obj) => {
          q.push(obj);
          if (flushId) return;
          flushId = setTimeout(() => {
            const batch = q.splice(0);
            flushId = 0;
            for (const x of batch) { try { window.pushChatEvent(x); } catch {} }
          }, 50);
        };

        const seen = new Set();
        function keyFor(n){
          const id =
            (n.getAttribute && n.getAttribute('id')) ||
            (n.dataset && (n.dataset.id || n.dataset.messageId || n.dataset.chatId)) || '';
          const who = deepText('#author-name', n);
          const body = (deepText('#message', n) || (n.textContent||'')).replace(/\\s+/g,' ').trim();
          return (n.tagName + '|' + id + '|' + who + '|' + body).slice(0,512);
        }
        function readColors(host){
          try {
            const cs = getComputedStyle(host);
            const v = k => (cs.getPropertyValue(k)||'').trim()||null;
            return {
              primary:v('--yt-live-chat-paid-message-primary-color'),
              chipBg: v('--yt-live-chat-paid-sticker-chip-background-color')
            };
          } catch { return {}; }
        }
        function parse(n){
          const tag = n.tagName?.toLowerCase(); if (!tag) return null;
          if (tag === 'yt-live-chat-paid-message-renderer') {
            const c = readColors(n);
            return { type:'superchat',
              author: deepText('#author-name', n),
              amount: deepText('#purchase-amount, yt-formatted-string#purchase-amount, #amount', n),
              message: deepText('#message', n),
              color: c.primary || null, colorVars: c, timestamp: now() };
          }
          if (tag === 'yt-live-chat-paid-sticker-renderer') {
            const c = readColors(n);
            return { type:'superchat',
              author: deepText('#author-name', n),
              amount: deepText('#purchase-amount, yt-formatted-string#purchase-amount, #amount', n),
              message: 'Super Sticker',
              color: c.primary || c.chipBg || null, colorVars: c, timestamp: now() };
          }
          if (tag === 'yt-live-chat-membership-item-renderer') {
            return { type:'membership',
              author: deepText('#author-name', n),
              header: deepText('#header-subtext, #primary-text, #header', n),
              message: deepText('#message, #subtext, #secondary-text', n),
              timestamp: now() };
          }
          if (tag === 'yt-live-chat-membership-gifting-event-renderer') {
            const body = (n.textContent||'').replace(/,/g,'');
            const m = body.match(/(?:sent\\s*)?(\\d+)\\D{0,80}(?:gift(?:ed)?\\s*)?memberships?/i)
                  || body.match(/gift(?:ed)?\\D{0,40}(\\d+)\\D*memberships?/i)
                  || body.match(/(\\d+)/);
            return { type:'gift',
              author: deepText('#author-name, #header-subtext, #primary-text', n) || 'Gift',
              count: m ? parseInt(m[1],10) : 1, message: body.trim(), timestamp: now() };
          }
          if (tag === 'yt-live-chat-membership-milestone-message-renderer') {
            return { type:'milestone',
              author: deepText('#author-name', n),
              header: deepText('#header-subtext, #header, #primary-text', n),
              message: deepText('#message', n), timestamp: now() };
          }
          if (tag === 'yt-live-chat-text-message-renderer') {
            return { type:'chat',
              author: deepText('#author-name', n),
              message: deepText('#message', n) || (n.textContent||'').trim(),
              timestamp: now() };
          }
          if (tag === 'ytd-sponsorships-live-chat-header-renderer') {
            const primary = deepText('#primary-text', n);
            const body = (primary || (n.textContent || ''))
                          .replace(/,/g, '')
                          .replace(/\\s+/g, ' ')
                          .trim();
            const m =
              body.match(/(?:sent\\s*)?(\\d+)\\D{0,80}gift(?:ed|ing)?\\s*memberships?/i) ||
              body.match(/gift(?:ed|ing)?\\D{0,40}(\\d+)\\D*memberships?/i) ||
              body.match(/(\\d+)/);
            const count = m ? parseInt(m[1], 10) : 1;
            return {
              type: 'gift',
              author: deepText('#author-name, #header-subtext, #primary-text', n) || 'Gift',
              message: body,
              count,
              timestamp: Date.now()
            };
          }
          return null;
        }
        function sweep(root){
          if (!root) return 0;
          const sel = [
            'yt-live-chat-text-message-renderer',
            'yt-live-chat-paid-message-renderer',
            'yt-live-chat-paid-sticker-renderer',
            'yt-live-chat-membership-item-renderer',
            'yt-live-chat-membership-gifting-event-renderer',
            'yt-live-chat-membership-milestone-message-renderer',
            'ytd-sponsorships-live-chat-header-renderer'
          ].join(',');
          let pushed = 0;
          root.querySelectorAll(sel).forEach(n=>{
            const key = keyFor(n);
            if (seen.has(key)) return;
            const d = parse(n); if (!d) return;
            seen.add(key); window.__lastPushAt = now();
            publish(d);
            pushed++;
          });
          return pushed;
        }

        let itemsRoot = null, mo = null;
        function bind(){
          const next = findItemsRoot(); if (!next) return false;
          if (mo) mo.disconnect();
          itemsRoot = next;
          sweep(itemsRoot);
          mo = new MutationObserver(muts => {
            let any = 0;
            for (const m of muts) for (const n of m.addedNodes) {
              if (!(n instanceof HTMLElement)) continue;
              any += sweep(n);
              const d = parse(n);
              if (d) {
                const k = keyFor(n);
                if (!seen.has(k)) { seen.add(k); window.__lastPushAt = now(); publish(d); }
              }
            }
            if (!any) {
              (window.requestIdleCallback || setTimeout)(() => sweep(itemsRoot), 500);
            }
          });
          mo.observe(itemsRoot, { childList:true, subtree:true });
          publish({ type:'status', message:'observer-started', timestamp: now() });
          return true;
        }

        const _attachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init){
          const sr = _attachShadow.call(this, init);
          if (this.tagName && this.tagName.toLowerCase() === 'yt-live-chat-item-list-renderer') {
            setTimeout(bind, 0);
          }
          return sr;
        };

        const start = () => { bind() || setTimeout(start, 1000); };
        start();
        setInterval(() => { if (!itemsRoot || !document.contains(itemsRoot)) bind(); }, 5000);
        setInterval(()=>{ publish({ type:'status', message:'observer-alive', timestamp: now() }); }, 10000);
      })();
      `;
      await page.addInitScript(script);
      await page.evaluate(script);
      slog(id, 'chat observer injected');
    }

    try {
      await page.goto(live, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      slog(id, 'navigated to live chat');
    } catch {
      await page.goto(replay, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      slog(id, 'live failed, navigated to replay chat');
    }
    await clickConsentIfPresent(page);
    await page.waitForSelector('yt-live-chat-app, yt-live-chat-renderer', { timeout: 45_000 }).catch(()=>{});
    await injectObserver();

    /* -------------------- watch meta (keep page alive until viewers) ------------- */

    const META_INTERVAL_MS   = +(process.env.META_INTERVAL_MS || 30_000);
    const META_WAIT_TICK_MS  = +(process.env.META_WAIT_TICK_MS || 3_000);
    const META_WAIT_MAX_MS   = +(process.env.META_WAIT_MAX_MS || 0); // 0 = infinite

    function addWatchParams(url) {
      const u = new URL(url);
      if (!u.searchParams.has('hl'))    u.searchParams.set('hl', 'en');
      if (!u.searchParams.has('bpctr')) u.searchParams.set('bpctr', '9999999999');
      return u.toString();
    }

    async function awaitMetaFromNewPage(ctx, watchUrl, idForLog) {
      const p = await ctx.newPage();
      const started = Date.now();
      try {
        p.setDefaultNavigationTimeout(35_000);
        await p.goto(addWatchParams(watchUrl), { waitUntil: 'domcontentloaded' });
        let title = '', viewers = null, via = null;

        // poll inside this page until we have viewers (or we hit an optional cap)
        const deadline = META_WAIT_MAX_MS > 0 ? (started + META_WAIT_MAX_MS) : Infinity;
        let nextVerboseLog = started;

        while (viewers == null && Date.now() < deadline) {
          const out = await p.evaluate(() => {
            const toNum = s => {
              if (!s) return null;
              const m = String(s).replace(/[.,]/g,'').match(/(\d[\d\s]*)\s*watching\s+now/i);
              return m ? parseInt(m[1].replace(/\s+/g,''), 10) : null;
            };

            const doc = document;
            const titleNow =
              doc.querySelector('meta[property="og:title"]')?.content?.trim() ||
              doc.querySelector('meta[name="title"]')?.content?.trim() ||
              (doc.querySelector('title')?.textContent || '').replace(/\s+-\s+YouTube$/,'').trim() || '';

            let viewersNow = null, viaNow = null;

            for (const t of doc.querySelectorAll('#tooltip')) {
              const n = toNum(t.textContent);
              if (n != null) { viewersNow = n; viaNow = 'tooltip'; break; }
            }
            if (viewersNow == null) {
              const span = doc.querySelector('span.view-count.ytd-video-view-count-renderer');
              const n = toNum(span?.textContent);
              if (n != null) { viewersNow = n; viaNow = 'span.view-count'; }
            }
            if (viewersNow == null) {
              const vc = doc.getElementById('view-count');
              const n = toNum(vc?.getAttribute('aria-label'));
              if (n != null) { viewersNow = n; viaNow = 'aria-label'; }
            }

            return { titleNow, viewersNow, viaNow };
          });

          if (out.titleNow) title = out.titleNow;
          if (typeof out.viewersNow === 'number') { viewers = out.viewersNow; via = out.viaNow; break; }

          const now = Date.now();
          if (META_VERBOSE && now >= nextVerboseLog + 30_000) {
            slog(idForLog, `meta: waiting for viewers… (${Math.round((now - started)/1000)}s)`);
            nextVerboseLog = now;
          }

          await p.waitForTimeout(META_WAIT_TICK_MS);
        }

        const elapsed = Date.now() - started;
        if (META_VERBOSE) slog(idForLog, `meta page ${viewers==null?'gave up':'found viewers'} after ${elapsed}ms ${viewers!=null?`via=${via}`:''}`);
        return { title, viewers, via, elapsed };
      } finally {
        // IMPORTANT: only close when we exit (either viewers obtained or optional cap hit)
        await p.close().catch(()=>{});
      }
    }

    const seeded = Number((sessions.get(id)?.meta || {}).maxViewers) || 0;

    let lastMeta = { title: undefined, viewers: undefined, maxViewers: seeded };
    const sMeta = sessions.get(id); sMeta.meta = lastMeta;

    const pollMeta = async () => {
      const s0 = sessions.get(id);
      if (!s0 || s0.metaBusy) return;
      s0.metaBusy = true;

      let merged; // <-- hoisted so 'finally' can see it

      try {
        const { title, viewers, via } = await awaitMetaFromNewPage(s0.context, watch, id);

        merged = {
          title:   title && title.length ? title : (s0.meta?.title ?? undefined),
          viewers: (typeof viewers === 'number') ? viewers : (s0.meta?.viewers ?? undefined),
          maxViewers: Number(s0.meta?.maxViewers) || 0
        };
        if (typeof merged.viewers === 'number') {
          merged.maxViewers = Math.max(merged.maxViewers, merged.viewers);
        }
        s0.meta = merged;

        const last = lastMeta || { title: undefined, viewers: undefined, maxViewers: 0 };
        const changed =
          merged.title !== last.title ||
          merged.viewers !== last.viewers ||
          merged.maxViewers !== last.maxViewers;

        if (changed) {
          lastMeta = merged;
          push({ type: 'meta', at: Date.now(), videoId, ...merged });

          // Persist (title/snapshot/conditional max update)
          if (s0.streamId) {
            if (typeof merged.title === 'string' && merged.title.length) {
              sbUpdateStreamTitle(s0.streamId, merged.title).catch(()=>{});
            }
            if (typeof merged.viewers === 'number') {
              sbInsertViewerSnapshot(s0.streamId, merged.viewers).catch(()=>{});
            }
            if (Number.isFinite(merged.maxViewers)) {
              sbUpdateMaxViewers(s0.streamId, merged.maxViewers).catch(()=>{});
            }
          }

          slog(id, `meta updated -> viewers:${merged.viewers} max:${merged.maxViewers} titleLen:${(merged.title||'').length} ${via?`via:${via}`:''}`);
        } else if (META_VERBOSE) {
          slog(id, `meta unchanged (titleLen:${(merged.title||'').length} viewers:${merged.viewers} max:${merged.maxViewers})`);
        }
      } catch (e) {
        slog(id, 'meta error', String(e?.message || e));
      } finally {
        const s2 = sessions.get(id);
        if (s2) s2.metaBusy = false; // <-- always release the lock

        // Extra safety: only attempt the DB bump if we actually computed a merged value
        if (s2?.streamId && merged && Number.isFinite(merged.maxViewers)) {
          // atomic "only if higher" update
          sbUpdateMaxViewers(s2.streamId, merged.maxViewers).catch(()=>{});
        }
      }
    };


    // kick and schedule; each cycle will *block until viewers are seen* (or optional cap) then close the tiny page
    await pollMeta();
    const mt = setInterval(pollMeta, META_INTERVAL_MS);
    const s0 = sessions.get(id); if (s0) s0.metaTimer = mt;
    slog(id, `meta polling started @${META_INTERVAL_MS}ms (tick=${META_WAIT_TICK_MS}ms, max=${META_WAIT_MAX_MS||'∞'}ms)`);

  } catch (err) {
    log.error(`[session ${id}] fatal`, err);
    try { await page?.close(); } catch {}
    try { await context?.close?.(); } catch {}
    try { await browser?.close(); } catch {}
    sessions.delete(id);
    throw err;
  }
}

// Optional API key: set PARSER_API_KEY to require x-api-key header
const API_KEY = (process.env.PARSER_API_KEY || '').trim();
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();                          // open if no key set
  const got = String(req.headers['x-api-key'] || '').trim();
  if (got && got === API_KEY) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

/* Return the first active session (we only allow one via /parser API) */
function firstActiveSession() {
  for (const [id, s] of sessions) if (s.browser) return { id, s };
  return null;
}

/* Cleanly stop & remove a session by id */
async function cleanupAndDelete(id) {
  const s = sessions.get(id);
  if (!s) return;
  try {
    clearInterval(s.metaTimer);
    clearInterval(s.watchdogTimer);
    clearInterval(s.idleCheckTimer);
    if (s.onAutoStop) app.off('autostop', s.onAutoStop);
    await s.page?.close().catch(()=>{});
    await s.context?.close?.().catch(()=>{});
    await s.browser?.close()?.catch(()=>{});
  } finally {
    sessions.delete(id);
  }
}

/* Start only if idle; supports force:true to replace current session */
async function startUnique(url, { force = false } = {}) {
  if (_starting) return { started:false, status:'starting_in_progress' };

  const current = firstActiveSession();
  if (current && !force) {
    return {
      started: false,
      status: 'already_running',
      sessionId: current.id,
      videoId:   current.s.videoId,
      meta:      current.s.meta || {}
    };
  }

  if (current && force) await cleanupAndDelete(current.id);

  _starting = true;
  try {
    const id = await startSessionDetached(url);
    return { started:true, status:'started', sessionId:id };
  } finally {
    _starting = false;
  }
}

/* ---------------------------------- routes --------------------------------- */
function activeSessionCount() {
  return [...sessions.values()].filter(s => s.browser).length;
}

/* High-level control API for other apps */
app.use('/parser', requireApiKey);

/* Is the parser running? */
app.get('/parser/active', requireKey, (_req, res) => {
  const [id, s] = [...sessions.entries()].find(([,v]) => v.browser) || [];
  if (!s) return res.json({ ok:true, status:'idle' });
  res.json({
    ok: true,
    status: 'running',
    sessionId: id,
    videoId: s.videoId || null,
    meta: s.meta || null
  });
});

/* Start if idle (or force replace). Body: { url: "https://youtu.be/…", force?:true } */
app.post('/parser/start', async (req, res) => {
  try {
    const { url, force = false } = req.body || {};
    if (!url) return res.status(400).json({ ok:false, error:'missing_url' });
    const out = await startUnique(url, { force: !!force });
    res.json({ ok: out.started || out.status === 'already_running', ...out });
  } catch (e) {
    log.error('[POST /parser/start] error:', e);
    res.status(500).json({ ok:false, error:'failed_to_start', reason: e?.message || String(e) });
  }
});

/* Idempotent: ensure it’s running for this URL (never forces) */
async function ensureParser(url) {
  // is something already running?
  const running = [...sessions.entries()].find(([,v]) => v.browser);
  if (running) {
    const [id, s] = running;
    return { ok:true, started:false, status:'already_running', sessionId:id, videoId:s.videoId || null, meta:s.meta || null };
  }
  if (!url) return { ok:false, error:'missing_url' };

  const sessionId = await startSessionDetached(url);
  return { ok:true, started:true, status:'started', sessionId };
}

// POST body: { "url": "https://www.youtube.com/watch?v=..." }
app.post('/parser/ensure', requireKey, async (req, res) => {
  try {
    console.log(new Date().toISOString(), '[POST /parser/ensure]', req.body);
    const { url } = req.body || {};
    const out = await ensureParser(url);
    res.json(out);
  } catch (e) {
    console.error('[POST /parser/ensure] error:', e);
    res.status(500).json({ ok:false, error:'ensure_failed', reason: String(e?.message || e) });
  }
});

// GET /parser/ensure?url=...
app.get('/parser/ensure', requireKey, async (req, res) => {
  try {
    console.log(new Date().toISOString(), '[GET /parser/ensure]', req.query);
    const out = await ensureParser(req.query.url || '');
    res.json(out);
  } catch (e) {
    console.error('[GET /parser/ensure] error:', e);
    res.status(500).json({ ok:false, error:'ensure_failed', reason: String(e?.message || e) });
  }
});

app.post('/start', async (req, res) => {
  if (activeSessionCount() >= 2) {
    return res.status(429).json({ error: 'too_many_sessions' });
  }
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    log.info('[POST /start] url=', url);
    const sessionId = await startSessionDetached(url);
    return res.json({ sessionId });
  } catch (e) {
    log.error('[POST /start] error:', e);
    return res.status(500).json({ error: 'failed_to_start', reason: e?.message || String(e) });
  }
});

app.get('/events/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 5000\n\n');

  slog(req.params.id, `SSE open; sinks before=${s.sinks.size}`);
  res.write(`data: ${JSON.stringify({ type:'Connection Established', id:req.params.id, videoId: s.videoId })}\n\n`);

  if (s.meta && (s.meta.title || s.meta.viewers !== undefined || s.meta.maxViewers !== undefined)) {
    res.write(`data: ${JSON.stringify({ type:'meta', at: Date.now(), videoId: s.videoId, ...s.meta })}\n\n`);
  }

  const hb = setInterval(() => res.write(':\n\n'), 15000);
  s.sinks.add(res);
  slog(req.params.id, `SSE registered; sinks now=${s.sinks.size}`);
  req.on('close', () => {
    clearInterval(hb);
    s.sinks.delete(res);
    slog(req.params.id, `SSE closed; sinks now=${s.sinks.size}`);
  });
});

app.post('/stop/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ ok: true });
  try {
    slog(req.params.id, 'manual stop: cleaning up');
    clearInterval(s.metaTimer);
    clearInterval(s.watchdogTimer);
    clearInterval(s.idleCheckTimer);
    if (s.onAutoStop) app.off('autostop', s.onAutoStop);
    await s.page?.close().catch(()=>{});
    await s.context?.close?.().catch(()=>{});
    await s.browser?.close().catch(()=>{});
  } finally {
    sessions.delete(req.params.id);
  }
  res.json({ ok: true });
});

/* ---------------------------------- server --------------------------------- */
const PORT = process.env.PORT || 8080;
const srv = app.listen(PORT, () => log.info(`Scraper listening on http://localhost:${PORT}`));

process.on('SIGTERM', async () => {
  try {
    for (const [, s] of sessions) {
      try {
        clearInterval(s.metaTimer);
        clearInterval(s.watchdogTimer);
        clearInterval(s.idleCheckTimer);
        if (s.onAutoStop) app.off('autostop', s.onAutoStop);
      } catch {}
      await s.page?.close().catch(()=>{});
      await s.context?.close?.().catch(()=>{});
      await s.browser?.close().catch(()=>{});
    }
  } finally {
    srv.close(()=>process.exit(0));
  }
});
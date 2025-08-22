// server.js
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { chromium } from 'playwright';

/* ------------------------------ crash logging ------------------------------ */
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('SIGTERM', async () => {
  try {
    for (const [id, s] of sessions) {
      clearInterval(s.metaTimer);
      await s.page?.close().catch(()=>{});
      await s.watchPage?.close().catch(()=>{});
      await s.browser?.close().catch(()=>{});
    }
  } finally {
    process.exit(0);
  }
});

/* --------------------------------- state ---------------------------------- */
/** id -> { browser, page, watchPage, sinks:Set<res>, videoId, meta, metaTimer } */
const sessions = new Map();

/* ---------------------------- Render‑friendly PW ---------------------------- */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
  '--disable-background-networking',
  '--disable-extensions',
  '--disable-features=Translate,MediaRouter',
  '--mute-audio',
  '--hide-scrollbars',
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
    viewport: { width: 1280, height: 800 },
  });

  await context.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

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
      if (!count || count < 1) count = 1; // default to 1 if the UI omits the number
      return { type: 'gift', ...base, count };
    }
    case 'membership':
      return { type: 'membership', ...base, header: raw.header || '' };
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

/* ------------------------------- session core ------------------------------ */
async function startSessionDetached(url) {
  const id = nanoid();
  sessions.set(id, {
    browser: null, page: null, watchPage: null,
    sinks: new Set(), videoId: null, meta: {}, metaTimer: null
  });
  startSession(url, id)
    .then(() => console.log('[session %s] ready', id))
    .catch(err => {
      console.error('[session %s] failed', id, err);
      const s = sessions.get(id);
      if (s) s.error = err?.message || String(err);
    });
  return id;
}

async function startSession(url, idArg) {
  const id = idArg || nanoid();
  const { live, replay, watch, videoId } = toPopoutUrl(url);

  const { browser, context, page } = await launchBrowserWithRetry(2);
  const watchPage = await context.newPage();

  sessions.set(id, {
    browser, page, watchPage,
    sinks: (sessions.get(id)?.sinks) || new Set(),
    videoId, meta: {}, metaTimer: null
  });

  const push = (payload) => {
    const s = sessions.get(id);
    if (!s) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const sink of s.sinks) sink.write(line);
  };

  let lastChatAt = Date.now();

  await page.exposeBinding('pushChatEvent', (_src, payload) => {
    if (payload && payload.type && payload.type !== 'status') {
      lastChatAt = Date.now();
    }
    const enriched = enrichAndFilter(payload, videoId);
    if (enriched) push(enriched);
  });

  // watchdog: if no chat-ish events for 30s, nudge the page to rebinding path
  setInterval(async () => {
    try {
      const lastInPage = await page.evaluate(() => window.__lastPushAt || 0);
      const stale = Date.now() - Math.max(lastChatAt, lastInPage);
      if (stale > 30000) {
        await page.evaluate(() => {
          // fire the SPA event handler + force a scan
          window.dispatchEvent(new Event('yt-navigate-finish'));
          const e = document.querySelector('yt-live-chat-app') || document.body;
          if (e && e.scrollTo) e.scrollTo(0, 1e9);
        });
      }
    } catch {}
  }, 10000);

  async function injectObserver() {
    const script = `
    (() => {
      if (window.__CHAT_OBSERVER_INSTALLED) return;
      window.__CHAT_OBSERVER_INSTALLED = true;
      const now = () => Date.now();
      window.__lastPushAt = now();

      /* ---------- deep query helpers (pierce shadow DOM) ---------- */
      const isEl = n => n && n.nodeType === 1;
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

      /* ---------- find the live list container (#items inside shadow) ---------- */
      function findItemsRoot() {
        const hosts = queryAllDeep('yt-live-chat-item-list-renderer');
        for (const host of hosts) {
          const sr = host.shadowRoot; if (!sr) continue;
          const items = sr.querySelector('#items') || sr.querySelector('#contents');
          if (items) return items;
        }
        return queryDeep('#items') || queryDeep('#contents') || null;
      }

      /* ---------- parse renderers ---------- */
      const seen = new Set();
      function keyFor(n){
        const who = deepText('#author-name', n);
        const body = deepText('#message', n) || (n.textContent||'').trim();
        return (n.tagName + '|' + who + '|' + body).slice(0,256);
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
          // Prefer the visible primary line
          const primary = deepText('#primary-text', n);
          const body = (primary || (n.textContent || ''))
                        .replace(/,/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
          // Robust count extraction (handles: "Sent 1 Foo gift memberships", "gifted 10 memberships", etc.)
          const m =
            body.match(/(?:sent\s*)?(\d+)\D{0,80}gift(?:ed|ing)?\s*memberships?/i) ||
            body.match(/gift(?:ed|ing)?\D{0,40}(\d+)\D*memberships?/i) ||
            body.match(/(\d+)/);
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
          try { window.pushChatEvent(d); } catch {}
          pushed++;
        });
        return pushed;
      }

      /* ---------- bind MO and auto-rebind on root swaps ---------- */
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
              if (!seen.has(k)) { seen.add(k); window.__lastPushAt = now(); try { window.pushChatEvent(d); } catch {} }
            }
          }
          if (!any) sweep(itemsRoot); // virtualization fallback
        });
        mo.observe(itemsRoot, { childList:true, subtree:true });
        try { window.pushChatEvent({ type:'status', message:'observer-started', timestamp: now() }); } catch {}
        return true;
      }

      // Patch attachShadow early so we re-bind if YT swaps the live list host
      const _attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(init){
        const sr = _attachShadow.call(this, init);
        // If a new chat list host appears, try to (re)bind
        if (this.tagName && this.tagName.toLowerCase() === 'yt-live-chat-item-list-renderer') {
          setTimeout(bind, 0);
        }
        return sr;
      };

      // Initial bind, plus a light heartbeat recheck
      const start = () => { bind() || setTimeout(start, 1000); };
      start();
      setInterval(() => { if (!itemsRoot || !document.contains(itemsRoot)) bind(); }, 5000);

      // alive ping
      setInterval(()=>{ try { window.pushChatEvent({ type:'status', message:'observer-alive', timestamp: now() }); } catch {} }, 10000);
    })();
    `;
    await page.addInitScript(script);
    await page.evaluate(script);
  }

  try {
    await page.goto(live, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch {
    await page.goto(replay, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }
  await clickConsentIfPresent(page);
  await page.waitForSelector('yt-live-chat-app, yt-live-chat-renderer', { timeout: 45_000 }).catch(()=>{});
  await injectObserver();

  // watch page for title/viewers
  await watchPage.goto(watch, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(()=>{});
  await clickConsentIfPresent(watchPage);

  /* ----------------------- watch page metadata scraping ---------------------- */
  async function scrapeWatchMeta(page) {
    // Allow slow hydrations locally
    await page.waitForFunction(() => {
      const og  = document.querySelector('meta[property="og:title"]')?.content?.trim();
      const h1  = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim();
      const nm  = document.querySelector('meta[name="title"]')?.content?.trim();
      const yti = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails?.title) || '';
      const dt  = (document.title || '').trim();
      return Boolean((og && og.length) || (h1 && h1.length) || (nm && nm.length) || (yti && yti.length) || (dt && dt !== 'YouTube'));
    }, { timeout: 15000 }).catch(()=>{});

    // Do *all* DOM scraping inside the page context so we don't use a stray `await` in the wrong scope.
    const { title, viewers } = await page.evaluate(() => {
      const pick = (...vals) => (vals.find(v => v && String(v).trim().length) || '').trim();

      const h1El    = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      const h1Title = h1El?.getAttribute?.('title') || '';
      const h1Text  = h1El?.textContent || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
      const metaNameTitle = document.querySelector('meta[name="title"]')?.content || '';
      const yti     = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails?.title) || '';
      let docTitle  = document.title || '';
      if (docTitle.endsWith(' - YouTube')) docTitle = docTitle.slice(0, -' - YouTube'.length).trim();

      const numberFrom = (s='') => {
        const cleaned = s.replace(/[.,]/g,'');
        const m = cleaned.match(/(\d[\d\s]*)\s*(?:watching\s+now|watching|viewers?\s*live|currently\s*watching)/i);
        return m ? parseInt(m[1].replace(/\s+/g,''), 10) : undefined;
      };

      // Try the obvious placements first
      const vc       = document.querySelector('#view-count');
      const aria     = vc?.getAttribute?.('aria-label') || '';
      const vcText   = vc?.textContent || '';
      let viewers    = numberFrom(aria) ?? numberFrom(vcText);

      if (viewers === undefined) {
        const els = document.querySelectorAll('ytd-watch-metadata yt-formatted-string, span, div');
        for (const el of els) {
          viewers = numberFrom(el.textContent || '');
          if (viewers !== undefined) break;
        }
      }

      // Last-chance fallback: scan full body text once
      if (viewers === undefined) {
        const blob = (document.body?.innerText || '').replace(/[.,]/g,' ');
        const m = blob.match(/(\d[\d\s]*)\s*(?:watching\s+now|watching|viewers?\s*live|currently\s*watching)/i);
        if (m) viewers = parseInt(m[1].replace(/\s+/g,''), 10);
      }

      return { title: pick(h1Title, h1Text, ogTitle, metaNameTitle, yti, docTitle), viewers };
    });

    return { title, viewers };
  }

  let lastMeta = { title: undefined, viewers: undefined };

  const pushMeta = async () => {
    try {
      const next = await scrapeWatchMeta(watchPage);
      const s = sessions.get(id);
      if (!s) return;
      s.meta = next;
      const changed =
        next.title !== lastMeta.title ||
        next.viewers !== lastMeta.viewers ||
        (lastMeta.viewers === undefined && typeof next.viewers === 'number');
      if (changed) {
        lastMeta = next;
        push({ type: 'meta', at: Date.now(), videoId, ...next });
      }
    } catch {}
  };

  // fast for ~1 min, then 10s cadence
  let ticks = 0;
  const fastTimer = setInterval(async () => {
    await pushMeta();
    if (++ticks === 12) {
      clearInterval(fastTimer);
      const steady = setInterval(pushMeta, 10_000);
      const s = sessions.get(id);
      if (s) s.metaTimer = steady;
    }
  }, 5_000);
  await pushMeta();

  // store metaTimer so /stop can clear it if we’re still in fast phase
  const s0 = sessions.get(id);
  if (s0 && !s0.metaTimer) s0.metaTimer = fastTimer;
}

/* ---------------------------------- routes --------------------------------- */
function activeSessionCount() {
  return [...sessions.values()].filter(s => s.browser).length;
}

app.post('/start', async (req, res) => {
  if (activeSessionCount() >= 1) {
    return res.status(429).json({ error: 'too_many_sessions' });
  }
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    console.log('[POST /start] url=', url);
    const sessionId = await startSessionDetached(url);
    return res.json({ sessionId });
  } catch (e) {
    console.error('[POST /start] error:', e);
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

  res.write(`data: ${JSON.stringify({ type:'Connection Established', id:req.params.id, videoId: s.videoId })}\n\n`);
  if (s.meta && (s.meta.title || s.meta.viewers !== undefined)) {
    res.write(`data: ${JSON.stringify({ type:'meta', at: Date.now(), videoId: s.videoId, ...s.meta })}\n\n`);
  }

  const hb = setInterval(() => res.write(':\n\n'), 15000);
  s.sinks.add(res);
  req.on('close', () => { clearInterval(hb); s.sinks.delete(res); });
});

app.post('/stop/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.json({ ok: true });
  try {
    clearInterval(s.metaTimer);
    await s.page?.close().catch(()=>{});
    await s.watchPage?.close().catch(()=>{});
    await s.browser?.close().catch(()=>{});
  } finally {
    sessions.delete(req.params.id);
  }
  res.json({ ok: true });
});

/* ---------------------------------- server --------------------------------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Scraper listening on http://localhost:${PORT}`));
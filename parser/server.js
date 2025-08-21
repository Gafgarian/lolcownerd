import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { chromium } from 'playwright';

/* ------------------------------ process hooks ----------------------------- */
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));
process.on('SIGTERM', async () => {
  try {
    for (const [, s] of sessions) {
      clearInterval(s.metaTimer);
      await s.page?.close().catch(()=>{});
      await s.watchPage?.close().catch(()=>{});
      await s.browser?.close().catch(()=>{});
    }
  } finally {
    process.exit(0);
  }
});

/** Active sessions: id -> { browser, page, watchPage, sinks:Set<res>, videoId, meta, metaTimer } */
const sessions = new Map();

/* -------------------------- launch config (Render) ------------------------- */
const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-zygote',
  '--single-process',
  '--disable-gpu',
  '--lang=en-US,en;q=0.9'
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function launchBrowser() {
  const browser = await chromium.launch({ headless: true, args: CHROME_ARGS });
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'en-US',
    viewport: { width: 1280, height: 800 }
  });

  // Trim heavy resources
  await context.route('**/*', route => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  // Pre-consent cookie (best-effort)
  try {
    const oneYear = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    await context.addCookies([
      { name: 'CONSENT', value: 'YES+cb.20210328-17-p0.en+FX', domain: '.youtube.com', path: '/', expires: oneYear, httpOnly: false, secure: true, sameSite: 'Lax' }
    ]);
  } catch {}

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(120_000);
  page.setDefaultTimeout(120_000);
  return { browser, context, page };
}

/* ---------------------------------- app ----------------------------------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

/* ----------------------------- helpers/utils ------------------------------ */

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

/** normalize/whitelist events from the in-page observer */
function enrichAndFilter(raw, videoId) {
  const at = raw.timestamp || Date.now();
  const base = { at, videoId, author: raw.author || '', message: raw.message || '' };

  switch (raw.type) {
    case 'superchat': {
      const amountFloat = amountToFloat(raw.amount || '');
      if (!amountFloat) return null;
      return {
        type: 'superchat',
        ...base,
        amount: raw.amount || '',
        amountFloat,
        currencyGuess: guessCurrency(raw.amount || ''),
        tier: tierFromPrimaryColor(raw.color || raw.colorVars?.primary) || 'unknown',
        color: raw.color || raw.colorVars?.primary || null,
        colorVars: raw.colorVars || null
      };
    }
    case 'gift': {
      const text = (raw.message || '').replace(/,/g,'').replace(/\s+/g,' ');
      let m = text.match(/(?:sent\s*)?(\d+)\D{0,80}(?:gift(?:ed)?\s*)?memberships?/i)
           || text.match(/gift(?:ed)?\D{0,40}(\d+)\D*memberships?/i)
           || text.match(/(\d+)/);
      const count = m ? parseInt(m[1],10) : 0;
      if (!count) return null;
      return { type:'gift', ...base, count };
    }
    case 'membership': return { type:'membership', ...base, header: raw.header || '' };
    case 'milestone': {
      const mm = `${raw.header||''} ${raw.message||''}`.match(/(\d+)\s*month/i);
      const months = mm ? parseInt(mm[1],10) : undefined;
      return { type:'milestone', ...base, header: raw.header || '', months };
    }
    default: return null;
  }
}

/* ------------------------ detached starter (non-blocking) ------------------ */
async function startSessionDetached(url) {
  const id = nanoid();
  // seed minimal record so /events can connect immediately
  sessions.set(id, { browser:null, page:null, watchPage:null, sinks:new Set(), videoId:null, meta:{}, metaTimer:null });

  startSession(url, id)
    .then(() => console.log('[session %s] ready', id))
    .catch(err => {
      console.error('[session %s] failed', id, err);
      const s = sessions.get(id);
      if (s) s.error = err?.message || String(err);
    });

  return id;
}

/* ---------------------------- playwright session --------------------------- */
async function startSession(url, id) {
  const { live, replay, watch, videoId } = toPopoutUrl(url);
  const { browser, context, page } = await launchBrowser();
  const watchPage = await context.newPage();

  // Update the seeded record **right away** so sinks/meta/videoId are correct
  {
    const rec = sessions.get(id) || { sinks:new Set() };
    rec.browser = browser;
    rec.page = page;
    rec.watchPage = watchPage;
    rec.videoId = videoId;
    rec.meta = rec.meta || {};
    sessions.set(id, rec);
  }

  const push = (payload) => {
    const s = sessions.get(id);
    if (!s) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const sink of s.sinks) sink.write(line);
  };

  await page.exposeBinding('pushChatEvent', (_src, payload) => {
    const enriched = enrichAndFilter(payload, videoId);
    if (enriched) push(enriched);
  });

  async function injectObserver() {
    const script = `
      (() => {
        const now = () => Date.now();
        const txt = (sel, root=document) => root.querySelector(sel)?.textContent?.trim() ?? '';

        function extractAmount(el){
          const raw = txt('#purchase-amount', el) || txt('#amount', el) || txt('yt-formatted-string#purchase-amount', el);
          return raw || '';
        }
        function readSCColors(el){
          const cs = getComputedStyle(el);
          const getVar = n => (cs.getPropertyValue(n) || '').trim() || null;
          return {
            primary:   getVar('--yt-live-chat-paid-message-primary-color'),
            secondary: getVar('--yt-live-chat-paid-message-secondary-color'),
            header:    getVar('--yt-live-chat-paid-message-header-color'),
            timestamp: getVar('--yt-live-chat-paid-message-timestamp-color'),
            chipBg:    getVar('--yt-live-chat-paid-sticker-chip-background-color')
          };
        }
        function parseNode(n){
          const tag = n.tagName?.toLowerCase();
          if (tag === 'yt-live-chat-paid-message-renderer') {
            const colors = readSCColors(n);
            return { type:'superchat', author:txt('#author-name',n), amount:extractAmount(n), message:txt('#message',n),
                     color: colors.primary || n.getAttribute('body-background-color') || null, colorVars: colors, timestamp: now() };
          }
          if (tag === 'yt-live-chat-paid-sticker-renderer') {
            const colors = readSCColors(n);
            return { type:'superchat', author:txt('#author-name',n), amount:extractAmount(n), message:'Super Sticker',
                     color: colors.primary || colors.chipBg || n.getAttribute('money-chip-background-color') || n.getAttribute('background-color') || null,
                     colorVars: colors, timestamp: now() };
          }
          if (tag === 'ytd-sponsorships-live-chat-header-renderer') {
            const body = (n.textContent || '').trim();
            const isGift = /gift/i.test(body);
            if (isGift) {
              const primary = n.querySelector('#primary-text')?.textContent || '';
              const text = (primary || body).replace(/,/g,'').replace(/\\s+/g,' ');
              let m = text.match(/(?:sent\\s*)?(\\d+)\\D{0,80}(?:gift(?:ed)?\\s*)?memberships?/i)
                   || text.match(/gift(?:ed)?\\D{0,40}(\\d+)\\D*memberships?/i)
                   || text.match(/(\\d+)/);
              const count = m ? parseInt(m[1],10) : 1;
              return { type:'gift', author: (n.querySelector('#author-name')?.textContent?.trim()
                        || n.querySelector('#header-subtext')?.textContent?.trim() || 'Gift'),
                        count, message: body, timestamp: now() };
            }
            return { type:'membership', author: n.querySelector('#author-name')?.textContent?.trim() || '',
                     header: n.querySelector('#header-subtext')?.textContent?.trim() || '',
                     message: n.querySelector('#message')?.textContent?.trim() || '', timestamp: now() };
          }
          if (tag === 'yt-live-chat-membership-gifting-event-renderer') {
            const body = (n.textContent || '').trim();
            const text = body.replace(/,/g,'').replace(/\\s+/g,' ');
            let m = text.match(/(?:sent\\s*)?(\\d+)\\D{0,80}(?:gift(?:ed)?\\s*)?memberships?/i)
                 || text.match(/gift(?:ed)?\\D{0,40}(\\d+)\\D*memberships?/i)
                 || text.match(/(\\d+)/);
            const count = m ? parseInt(m[1],10) : 1;
            return { type:'gift', author: n.querySelector('#author-name')?.textContent?.trim() || 'Gift', count, message: body, timestamp: now() };
          }
          if (tag === 'yt-live-chat-membership-milestone-message-renderer') {
            return { type:'milestone', author: txt('#author-name',n), header: txt('#header-subtext',n), message: txt('#message',n), timestamp: now() };
          }
          return null;
        }

        function primeDump(){
          const sel = [
            'yt-live-chat-paid-message-renderer',
            'yt-live-chat-paid-sticker-renderer',
            'yt-live-chat-membership-item-renderer',
            'yt-live-chat-membership-gifting-event-renderer',
            'yt-live-chat-membership-milestone-message-renderer'
          ].join(',');
          document.querySelectorAll(sel).forEach(n => {
            const d = parseNode(n);
            if (d) window.pushChatEvent(d);
          });
        }

        const root =
          document.querySelector('yt-live-chat-item-list-renderer #items') ||
          document.querySelector('#items') ||
          document.querySelector('#item-offset') ||
          document.querySelector('#contents') ||
          document.body;

        if (!root) { window.pushChatEvent({ type:'status', message:'chat-root-not-found' }); return; }
        try {
          var childCount = (root && root.children) ? root.children.length : 0;
          window.pushChatEvent({ type:'status', message:'observer-starting; children=' + childCount });
        } catch {}

        primeDump();
        const mo = new MutationObserver(muts => {
          for (const m of muts) for (const n of m.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            const d = parseNode(n);
            if (d) window.pushChatEvent(d);
          }
        });
        mo.observe(root, { childList:true, subtree:true });
        window.pushChatEvent({ type:'status', message:'observer-started' });
      })();
    `;
    await page.addInitScript(script);
    await page.evaluate(script);
  }

  // Navigate chat (live then replay)
  try {
    await page.goto(live,   { waitUntil:'domcontentloaded', timeout:45000 });
  } catch {
    await page.goto(replay, { waitUntil:'domcontentloaded', timeout:45000 });
  }
  await clickConsentIfPresent(page);
  await page.waitForSelector('yt-live-chat-item-list-renderer #items, #items, #item-offset, #contents', { timeout:45000 }).catch(()=>{});
  await injectObserver();

  // Open watch page for meta
  try {
    await watchPage.goto(watch, { waitUntil:'domcontentloaded', timeout:60000 });
    await clickConsentIfPresent(watchPage);
    await watchPage.waitForSelector('ytd-watch-flexy', { timeout:10000 }).catch(()=>{});
  } catch (e) {
    console.warn('[watch meta] navigation failed:', e?.message || e);
  }

  // ---- metadata scraping ----
  async function scrapeWatchMeta(page) {
    await page.waitForFunction(() => {
      const og  = document.querySelector('meta[property="og:title"]')?.content?.trim();
      const h1  = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim();
      const yti = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails?.title) || '';
      const dt  = (document.title || '').trim();
      return Boolean((og && og.length) || (h1 && h1.length) || (yti && yti.length) || (dt && dt !== 'YouTube'));
    }, { timeout: 8000 }).catch(()=>{});

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
        const m = s.replace(/[.,]/g,'').match(/(\d[\d\s]*)\s*(?:watching\s+now|watching)/i);
        return m ? parseInt(m[1].replace(/\s+/g,''), 10) : undefined;
      };

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
      if (viewers === undefined) {
        viewers = numberFrom(document.body?.innerText || '');
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

      // store for new /events subscribers
      s.meta = next;

      const changed =
        next.title !== lastMeta.title ||
        next.viewers !== lastMeta.viewers ||
        (lastMeta.viewers === undefined && typeof next.viewers === 'number');

      if (changed) {
        lastMeta = next;
        push({ type:'meta', at: Date.now(), videoId, ...next });
      }
    } catch (e) {
      // swallow, try again on next tick
    }
  };

  // first snapshot soon after open
  await pushMeta();

  // poll fast for a minute, then steady
  let ticks = 0;
  const timer = setInterval(async () => {
    await pushMeta();
    if (++ticks === 12) { // ≈1 min at 5s
      clearInterval(timer);
      const steady = setInterval(pushMeta, 10000);
      const s = sessions.get(id); if (s) s.metaTimer = steady;
    }
  }, 5000);

  // register timer (initial phase)
  {
    const s = sessions.get(id);
    if (s) s.metaTimer = timer;
  }

  // final: make sure the session record has everything (important!)
  {
    const s = sessions.get(id) || { sinks:new Set() };
    s.browser = browser; s.page = page; s.watchPage = watchPage;
    s.videoId = videoId; s.meta = lastMeta;
    sessions.set(id, s);
  }
}

/* --------------------------------- routes --------------------------------- */

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

/* --------------------------------- server --------------------------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Scraper listening on http://localhost:${PORT}`));
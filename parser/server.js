import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';

// helpful crash logs
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

/** Active sessions: id -> { browser, page, watchPage, sinks:Set<res>, videoId, meta, metaTimer } */
const sessions = new Map();

// 🔹 detached starter: do NOT await startSession here
async function startSessionDetached(url) {
  const id = nanoid();
  // seed session record so /events works even if start is still warming up
  sessions.set(id, { browser:null, page:null, watchPage:null, sinks:new Set(), videoId:null, meta:{}, metaTimer:null });

  // kick off the heavy work in the background
  startSession(url, id).then(() => {
    console.log('[session %s] ready', id);
  }).catch(err => {
    console.error('[session %s] failed', id, err);
    const s = sessions.get(id);
    if (s) s.error = err?.message || String(err);
  });

  return id;
}

import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));



/* -------------------------- helpers & enrichment -------------------------- */

function toPopoutUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    const vid = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).pop();
    return {
      videoId: vid,
      live:   `https://www.youtube.com/live_chat?is_popout=1&v=${vid}`,
      replay: `https://www.youtube.com/live_chat_replay?is_popout=1&v=${vid}`,
      watch:  `https://www.youtube.com/watch?v=${vid}`   // NEW for metadata scraping
    };
  } catch {
    // allow raw videoId input
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

// Pull the first numeric from an amount string like "$4.99", "CA$5.00", "¥500"
function amountToFloat(s = '') {
  const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Try to guess currency label from amount string
function guessCurrency(s = '') {
  if (/USD|\$/.test(s)) return 'USD';            // crude but good enough for counting
  if (/CA\$|C\$/.test(s)) return 'CAD';
  if (/€/.test(s)) return 'EUR';
  if (/£/.test(s)) return 'GBP';
  if (/¥/.test(s)) return 'JPY';
  return 'UNK';
}

// --- SuperChat colors from YouTube (lowest → highest) ---
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
  // normalize to rgba(r,g,b,1)
  const m = String(c).match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  const key = `rgba(${+m[1]},${+m[2]},${+m[3]},1)`;
  return COLOR_TO_TIER[key] || null;
}

/** Enrich a raw payload from the DOM observer, returning null if it should be dropped. */
function enrichAndFilter(raw, videoId) {
  const at = raw.timestamp || Date.now();

  // Normalize keys we depend on
  const base = {
    at,
    videoId,
    author: raw.author || '',
    message: raw.message || ''
  };

  switch (raw.type) {
    case 'superchat': {
      const amountFloat = amountToFloat(raw.amount || '');
      const currencyGuess = guessCurrency(raw.amount || '');
      const colorTier = tierFromPrimaryColor(raw.color || raw.colorVars?.primary);  // ✅ YouTube color
      const tier = colorTier || 'unknown';           // never fall back to amount tier

      // Drop bogus/empty superchats
      if (!amountFloat) return null;

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
      // Derive count from the message text if not present on the raw event
      let count = 0; 
      const text = (raw.message || '')
        .replace(/,/g, '')   // remove commas in numbers
        .replace(/\s+/g, ' '); // normalize spaces

      let m = text.match(/(?:sent\s+)?(\d{1,80})(?:\s*gift(?:ed)?\s*memberships?)/i);
      if (!m) m = text.match(/gift(?:ed)?\D{0,40}(\d+)\D*memberships?/i);
      if (!m) m = text.match(/(\d+)/);

      if (m) {
        count = parseInt(m[1], 10);
      }
      if (!count || count < 1) return null;
      return {
        type: 'gift',
        ...base,
        count
      };
    }

    case 'membership': {
      return {
        type: 'membership',
        ...base,
        header: raw.header || ''
      };
    }

    case 'milestone': {
      // Try to extract months from the header like "Member for 10 months"
      const text = `${raw.header || ''} ${raw.message || ''}`;
      const mm = text.match(/(\d+)\s*month/i);
      const months = mm ? parseInt(mm[1], 10) : undefined;
      return {
        type: 'milestone',
        ...base,
        header: raw.header || '',
        months
      };
    }

    // Everything else is dropped server-side.
    default:
      return null;
  }
}

/* ---------------------------- playwright session --------------------------- */

async function startSession(url, idArg) {
  const id = idArg || nanoid();
  const { live, replay, watch, videoId } = toPopoutUrl(url);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  const watchPage = await context.newPage();             // NEW: separate watch tab for meta

  // Push events to all EventSource sinks for this session
  const push = (payload) => {
    const s = sessions.get(id);
    if (!s) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const sink of s.sinks) sink.write(line);
  };

  // Binding used by the in-page observer
  await page.exposeBinding('pushChatEvent', (_src, payload) => {
    // Filter + enrich here; ONLY forward whitelisted types
    const enriched = enrichAndFilter(payload, videoId);
    if (enriched) push(enriched);
  });

  async function injectObserver() {
    const script = `
      (() => {
        const now = () => Date.now();
        const txt = (sel, root=document) => root.querySelector(sel)?.textContent?.trim() ?? '';

        function extractAmount(el){
          const raw =
            txt('#purchase-amount', el) ||
            txt('#amount', el) ||
            txt('yt-formatted-string#purchase-amount', el);
          return raw || '';
        }

        function readSCColors(el){
          const cs = getComputedStyle(el);
          const getVar = name => (cs.getPropertyValue(name) || '').trim() || null;
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
            return {
              type: 'superchat',
              author: txt('#author-name', n),
              amount: extractAmount(n),
              message: txt('#message', n),
              color: colors.primary || n.getAttribute('body-background-color') || null,
              colorVars: colors,
              timestamp: now()
            };
          }

          if (tag === 'yt-live-chat-paid-sticker-renderer') {
            const colors = readSCColors(n);
            return {
              type: 'superchat',
              author: txt('#author-name', n),
              amount: extractAmount(n),
              message: 'Super Sticker',
              color: colors.primary || colors.chipBg || n.getAttribute('money-chip-background-color') || n.getAttribute('background-color') || null,
              colorVars: colors,
              timestamp: now()
            };
          }

          if (tag === 'ytd-sponsorships-live-chat-header-renderer') {
            const body = (n.textContent || '').trim();
            const isGift = /gift/i.test(body);
            if (isGift) {
              const primary = n.querySelector('#primary-text')?.textContent || '';
              const text = (primary || body).replace(/,/g,'').replace(/\s+/g,' ');
              // Allow words between number and "gift"/"memberships", and both orders:
              // "Sent 20 LolcowQueens gift memberships" OR "gifted 5 memberships"
              let m = text.match(/(?:sent\s*)?(\d+)\D{0,80}(?:gift(?:ed)?\s*)?memberships?/i);
              if (!m) m = text.match(/gift(?:ed)?\D{0,40}(\d+)\D*memberships?/i);
              if (!m) m = text.match(/(\d+)/); // final fallback
              const count = m ? parseInt(m[1], 10) : 1;
              return {
                type: 'gift',
                author: (n.querySelector('#author-name')?.textContent?.trim()
                         || n.querySelector('#header-subtext')?.textContent?.trim()
                         || 'Gift'),
                count,
                message: body,
                timestamp: now()
              };
            }
            // Not a gift → treat as normal membership header
            return {
              type: 'membership',
              author: n.querySelector('#author-name')?.textContent?.trim() || '',
              header: n.querySelector('#header-subtext')?.textContent?.trim() || '',
              message: n.querySelector('#message')?.textContent?.trim() || '',
              timestamp: now()
            };
          }

          // Dedicated gifting event renderer (some channels use this)
          if (tag === 'yt-live-chat-membership-gifting-event-renderer') {
            const body = (n.textContent || '').trim();
            const text = body.replace(/,/g,'').replace(/\s+/g,' ');
            let m = text.match(/(?:sent\s*)?(\d+)\D{0,80}(?:gift(?:ed)?\s*)?memberships?/i);
            if (!m) m = text.match(/gift(?:ed)?\D{0,40}(\d+)\D*memberships?/i);
            if (!m) m = text.match(/(\d+)/);
            const count = m ? parseInt(m[1], 10) : 1;
            return {
              type: 'gift',
              author: n.querySelector('#author-name')?.textContent?.trim() || 'Gift',
              count,
              message: body,
              timestamp: now()
            };
          }  

          if (tag === 'yt-live-chat-membership-milestone-message-renderer') {
            return {
              type: 'milestone',
              author: txt('#author-name', n),
              header: txt('#header-subtext', n),
              message: txt('#message', n),
              timestamp: now()
            };
          }

          // We *intentionally* ignore normal messages server-side.
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
          document.querySelectorAll(sel).forEach(n=>{
            const d = parseNode(n);
            if(d) window.pushChatEvent(d);
          });
        }

        const root = document.querySelector('#item-offset') || document.querySelector('#contents') || document.body;
        if(!root){ window.pushChatEvent({type:'status', message:'chat-root-not-found'}); return; }

        primeDump();

        const mo = new MutationObserver(muts=>{
          for(const m of muts){
            for(const n of m.addedNodes){
              if(!(n instanceof HTMLElement)) continue;
              const d = parseNode(n);
              if(d) window.pushChatEvent(d);
            }
          }
        });
        mo.observe(root, {childList:true, subtree:true});
        window.pushChatEvent({type:'status', message:'observer-started'});
      })();
    `;
    await page.addInitScript(script);
    await page.evaluate(script);
  }

  // Try live first; fall back to replay
  try {
    await page.goto(live, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  } catch {
    await page.goto(replay, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  }

  await injectObserver();

  // NEW: open watch page for title/viewers/likes scraping
  await watchPage.goto(watch, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  // give the page a moment to hydrate, and dismiss consent if shown
  await clickConsentIfPresent(watchPage);
  await watchPage.waitForSelector('ytd-watch-flexy', { timeout: 10_000 }).catch(()=>{});

  /* ----------------------- watch page metadata scraping ---------------------- */
  async function scrapeWatchMeta(page) {
    // Try to wait a little for *any* title source on cold loads
    await page.waitForFunction(() => {
      const og  = document.querySelector('meta[property="og:title"]')?.content?.trim();
      const h1  = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim();
      const yti = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails?.title) || '';
      const dt  = (document.title || '').trim();
      return Boolean((og && og.length) || (h1 && h1.length) || (yti && yti.length) || (dt && dt !== 'YouTube'));
    }, { timeout: 8000 }).catch(()=>{});

    const { title, viewers } = await page.evaluate(() => {
      const pick = (...vals) => (vals.find(v => v && String(v).trim().length) || '').trim();

      // ---- TITLE (same as before but merged together) ----
      const h1El    = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      const h1Title = h1El?.getAttribute?.('title') || '';
      const h1Text  = h1El?.textContent || '';
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
      const metaNameTitle = document.querySelector('meta[name="title"]')?.content || '';
      const yti     = (window.ytInitialPlayerResponse && window.ytInitialPlayerResponse.videoDetails?.title) || '';
      let docTitle  = document.title || '';
      if (docTitle.endsWith(' - YouTube')) docTitle = docTitle.slice(0, -' - YouTube'.length).trim();

      // ---- VIEWERS (robust) ----
      const numberFrom = (s='') => {
        const m = s.replace(/[.,]/g,'').match(/(\d[\d\s]*)\s*(?:watching\s+now|watching)/i);
        return m ? parseInt(m[1].replace(/\s+/g,''), 10) : undefined;
      };

      // 1) aria-label on #view-count (sometimes present)
      const vc       = document.querySelector('#view-count');
      const aria     = vc?.getAttribute?.('aria-label') || '';
      const vcText   = vc?.textContent || '';
      let viewers    = numberFrom(aria) ?? numberFrom(vcText);

      // 2) scan nearby yt-formatted-string lines
      if (viewers === undefined) {
        const els = document.querySelectorAll('ytd-watch-metadata yt-formatted-string, span, div');
        for (const el of els) {
          viewers = numberFrom(el.textContent || '');
          if (viewers !== undefined) break;
        }
      }

      // 3) last resort: a very cheap whole-page text scan
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

      // Always store the freshest snapshot for new subscribers
      s.meta = next;

      // Emit if *anything* changed OR if we didn't have viewers before and now we do
      const changed =
        next.title !== lastMeta.title ||
        next.viewers !== lastMeta.viewers ||
        (lastMeta.viewers === undefined && typeof next.viewers === 'number');

      if (changed) {
        lastMeta = next;
        const payload = { type: 'meta', at: Date.now(), videoId, ...next };
        const line = `data: ${JSON.stringify(payload)}\n\n`;
        for (const sink of s.sinks) sink.write(line);
      }
    } catch (e) {
      // swallow; we’ll try again on the next tick
    }
  };

  // Poll: faster for the first minute (to “catch” viewers), then settle
  let metaInterval = 5000;
  let metaTicks = 0;
  const metaTimer = setInterval(async () => {
    await pushMeta();
    metaTicks += 1;
    if (metaTicks === 12) { // after ~1 minute at 5s
      clearInterval(metaTimer);
      setInterval(pushMeta, 10000); // 10s steady
    }
  }, metaInterval);

  await pushMeta(); // prime once immediately
}
/* --------------------------------- routes --------------------------------- */

app.post('/start', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url' });

    console.log('[POST /start] url=', url);
    const sessionId = await startSessionDetached(url); // respond immediately
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
  res.write('retry: 5000\n\n');            // let EventSource auto-retry

  res.write(`data: ${JSON.stringify({ type:'Connection Established', id:req.params.id, videoId: s.videoId })}\n\n`);
  if (s.meta && (s.meta.title || s.meta.viewers !== undefined)) {
    res.write(`data: ${JSON.stringify({ type:'meta', at: Date.now(), videoId: s.videoId, ...s.meta })}\n\n`);
  }

  const hb = setInterval(() => res.write(':\n\n'), 15000); // heartbeat
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
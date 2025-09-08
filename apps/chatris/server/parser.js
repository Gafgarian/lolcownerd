import { parseCommand, CHAT_COOLDOWN_MS, donationEffectFrom } from './rules.js';

const TD = new TextDecoder();

export function makeParserConnector(game, { emitLog, broadcast }) {
  let sessionId = null;
  let controller = null;

  const state = {
    baseUrl  : null,
    token    : null,
    streamUrl: null,  // /start uses { url }
    videoId  : null,  // or uses { video_id }
  };

  // callbacks supplied by admin.js
  let cbs = { onOpen:null, onEvent:null, onError:null, onEvent2:null, onError2:null };

  const log = (msg, extra={}) => { try { emitLog?.(msg, extra); } catch {} };

  // --------------------------- helpers ---------------------------
  const tryJSON = (x) => { try { return JSON.parse(x); } catch { return x; } };

  function normalizeData(raw) {
    if (raw == null) return null;
    let m = typeof raw === 'string' ? raw.trim() : raw;

    // Some servers send quoted JSON: "{\"type\":\"chat\",...}"
    m = tryJSON(m);
    if (typeof m === 'string') m = tryJSON(m);

    // Some wrap as { data: "{...}" }
    if (m && typeof m === 'object' && typeof m.data === 'string') {
      const inner = tryJSON(m.data);
      if (inner && typeof inner === 'object') m = inner;
    }

    if (!m || typeof m !== 'object') return null;

    // Normalize keys we care about
    m.type   = String(m.type ?? m.kind ?? m.event ?? '').toLowerCase();
    m.amount = Number(m.amount_float ?? m.amount ?? 0);
    m.count  = Number(m.gift_count   ?? m.count  ?? 0);
    m.tier  = String(m.tier ?? '').toLowerCase();
    m.color = typeof m.color === 'string' ? m.color : (m.colorVars?.primary || null);
    return m;
  }

  async function startSession() {
    if (!state.baseUrl) throw new Error('parser baseUrl not set');
    await stopSession();

    const url  = new URL('/start', state.baseUrl);
    const body = state.streamUrl ? { url: state.streamUrl } : { video_id: state.videoId };

    log('parser_starting', { url: url.toString(), hasToken: !!state.token, body });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      body: JSON.stringify(body)
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.sessionId) throw new Error(`parser /start failed: ${JSON.stringify(json)}`);

    sessionId = json.sessionId;
    log('parser_started', { sessionId });
    await connectEvents();
  }

  async function connectEvents() {
    if (!sessionId) return;

    controller = new AbortController();
    const eventsUrl = new URL(`/events/${sessionId}`, state.baseUrl);

    const res = await fetch(eventsUrl, {
      headers: {
        Accept: 'text/event-stream',
        ...(state.token ? { Authorization: `Bearer ${state.token}` } : {})
      },
      signal: controller.signal
    });

    if (!res.ok || !res.body) {
      const err = new Error(`parser SSE ${res.status}`);
      log('parser_connect_fail', { status: res.status });
      throw err;
    }

    log('parser_connected', { sessionId, events: eventsUrl.toString() });
    try { cbs.onOpen?.({ sessionId, events: eventsUrl.toString() }); } catch {}

    // --- Minimal SSE parsing (no external libs) ---
    const reader = res.body.getReader();
    let buf = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += TD.decode(value, { stream: true });

        // Split complete events on blank line
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);

          // Parse one SSE block
          let eventName = 'message';
          const dataLines = [];

          for (const line of block.split(/\r?\n/)) {
            if (!line) continue;
            if (line.startsWith(':')) continue;             // comment / heartbeat
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5));
          }

          if (!dataLines.length) continue;

          const rawData = dataLines.join('\n').trim();

          // Admin hook for raw
          try { cbs.onEvent2?.({ type: eventName, data: rawData }); } catch {}

          const m = normalizeData(rawData);
          if (!m) continue;

          let consumed = false;
          try {
           const r = cbs.onEvent ? cbs.onEvent(m) : false;
           consumed = (r instanceof Promise) ? await r : !!r;
          } catch (e) {
           log('parser_onEvent_hook_err', { error: String(e) });
          }
          try {
           if (!consumed) handle(m);
          } catch (err) {
            log('parser_event_error', {
              error: String(err && err.stack || err),
              where: 'handle',
              eventType: m && m.type,
              snippet: (() => { try { return JSON.stringify(m).slice(0, 240); } catch { return String(m).slice(0, 240); } })()
            });
          }
        }
      }
    } catch (e) {
      log('parser_stream_closed', { error: String(e) });
      try { cbs.onError2?.(e); } catch {}
    }
  }

  async function stopSession() {
    if (controller) { try { controller.abort(); } catch {} controller = null; }
    if (sessionId) {
      try {
        const url = new URL(`/stop/${sessionId}`, state.baseUrl);
        await fetch(url, { method: 'POST', headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
      } catch {}
      log('parser_stopped', { sessionId });
      sessionId = null;
    }
  }

  // Stop *other* sessions for this videoId (best effort)
  async function killByVideoId(videoId) {
    if (!videoId) return 0;

    // Prefer a dedicated endpoint if parser supports it
    try {
      const direct = new URL(`/stopByVideo/${encodeURIComponent(videoId)}`, state.baseUrl);
      const r = await fetch(direct, { method: 'POST', headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        log('parser_kill_by_video_direct', { videoId, result: j });
        return Number(j.killed || 0);
      }
    } catch {}

    // Fallback: list → stop
    try {
      const listUrl = new URL('/sessions', state.baseUrl);
      const r2 = await fetch(listUrl, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
      const sessions = await r2.json().catch(() => []);
      const victims = (Array.isArray(sessions) ? sessions : []).filter(s => s?.videoId === videoId && s?.id && s.id !== sessionId);
      let killed = 0;
      for (const s of victims) {
        try {
          const url = new URL(`/stop/${s.id}`, state.baseUrl);
          const r = await fetch(url, { method: 'POST', headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
          if (r.ok) killed++;
        } catch {}
      }
      log('parser_kill_by_video_scan', { videoId, killed });
      return killed;
    } catch (e) {
      log('parser_kill_by_video_error', { videoId, error: String(e) });
      return 0;
    }
  }

  // ---- Vote / cooldown guards ----
  const cooldownMap = new Map();   // author → last vote ms
  const burstGuard  = new Map();   // author → last seen ms (short dedupe)

  function okToCountVote(who) {
    if (!who) return false;
    const now  = Date.now();
    const last = burstGuard.get(who) || 0;
    if (now - last < 250) return false;    // drop bursts within 250ms
    burstGuard.set(who, now);
    return true;
  }

  function addVote(cmd) {
    if (typeof game?.queueVote === 'function') {
      game.queueVote(cmd);
    } else {
      // fallback: internal bucket (server resolves periodically)
      game._windowCounts = game._windowCounts || { left:0, right:0, rotate:0 };
      game._windowCounts[cmd] = (game._windowCounts[cmd] || 0) + 1;
    }
  }

  // ---- Default event handling ----
  function handle(m) {
    const type = String(m.type || '').toLowerCase();

    if (type === 'chat') {
      const msg = String(m.message || '');
      const cmd = parseCommand(msg);
      if (!cmd) return;
      const who  = m.author || m.channel || 'anon';
      const last = cooldownMap.get(who) || 0;
      if (Date.now() - last < CHAT_COOLDOWN_MS) return;
      cooldownMap.set(who, Date.now());
      // write into game’s bucket so the window loop sees it
      game._windowCounts = game._windowCounts || { left:0, right:0, rotate:0 };
      game._windowCounts[cmd] = (game._windowCounts[cmd] || 0) + 1;
      emitLog('chat_cmd', { author: who, cmd });
      return;
    }

    if (type === 'superchat') {
      const amount = Number(m.amount || 0);
      const effect = game.effectForAmount ? game.effectForAmount(amount) : null;
      if (!effect) return;
      const added = game.applyEffect(effect);
      broadcast('toast', { kind: 'superchat', author: m.author, message: m.message, amount, effect, added });
      emitLog('donation_effect', { author: m.author, amount, effect, added });
      return;
    }

    if (type === 'gift' || type === 'gifted' || type === 'gifted_members') {
      const count = Number(m.count || 0);
      if (!count) return;
      game.onGifts ? game.onGifts(count) : (game.giftsRecent = (game.giftsRecent || 0) + count);
      broadcast('toast', { kind: 'gift', author: m.author, count });
      emitLog('gift', { author: m.author, count });
    }
  }

  // --------------------------- public API ---------------------------
  return {
    configure(env, callbacks = {}) {
      // env can be { baseUrl, token } or just a string baseUrl
      const base = typeof env === 'string' ? env : env?.baseUrl;
      if (!base) throw new Error('configure() requires baseUrl');
      state.baseUrl = new URL(base);
      state.token   = (typeof env === 'object' && env?.token) ? env.token : null;

      if (callbacks && typeof callbacks !== 'object') {
        throw new TypeError('`callbacks` must be an object; use { onOpen, onEvent, onError }');
      }
      cbs = {
        onOpen  : callbacks.onOpen   || null,
        onEvent : callbacks.onEvent  || null,   // normalized object
        onEvent2: callbacks.onEvent2 || null,   // raw {type, data}
        onError : callbacks.onError  || null,
        onError2: callbacks.onError2 || null,
      };

      // allow persisting selectors if passed here
      state.streamUrl = callbacks.streamUrl || state.streamUrl;
      state.videoId   = callbacks.videoId   || state.videoId;

      log('parser_configured', {
        baseUrl: state.baseUrl.toString(),
        hasToken: !!state.token,
        callbacks: Object.keys(cbs).filter(k => !!cbs[k])
      });
    },

    async start(urlOrId) {
      if (urlOrId?.startsWith?.('http')) state.streamUrl = urlOrId;
      else if (urlOrId) state.videoId = urlOrId;
      await startSession();
    },

    async stop() { await stopSession(); },

    async killByVideoId(videoId) { return killByVideoId(videoId); },

    get sessionId() { return sessionId; }
  };
}
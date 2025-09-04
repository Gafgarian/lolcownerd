/* ---------- tiny helpers ---------- */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.substring(2), v);
    else n.setAttribute(k, v);
  });
  children.flat().forEach(c => n.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return n;
}

/* Fabric noise for background (data URI so no extra file) */
(function makeFabric() {
  const cf = document.createElement("canvas"); cf.width = 240; cf.height = 240;
  const g = cf.getContext("2d");
  g.fillStyle = "#2d2c22"; g.fillRect(0, 0, 240, 240);
  for (let y = 0; y < 240; y += 4) { g.fillStyle = `rgba(255,255,255,${0.015 + Math.random() * 0.01})`; g.fillRect(0, y, 240, 1); }
  for (let x = 0; x < 240; x += 4) { g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.02})`; g.fillRect(x, 0, 1, 240); }
  document.documentElement.style.setProperty("--fabric-tex", `url('${cf.toDataURL()}')`);
})();

/* ---------- Tooltip ---------- */
const tooltip = document.getElementById("tooltip");
let tipTimer;
function showTip(text, x, y) {
  if (text) tooltip.textContent = text;
  tooltip.style.left = (x + 12) + "px";
  tooltip.style.top = (y - 8) + "px";
  tooltip.classList.add("show");
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => tooltip.classList.remove("show"), 900);
}

/* ---------- MAP CANVASES ---------- */
const MAP_VB_W = 1000, MAP_VB_H = 562.5;
let MAP_IMG = null, MAP_CANVAS = null, MAP_CTX = null, MAG_CANVAS = null, MAG_CTX = null;

function drawMap() {
  MAP_CANVAS = document.getElementById("mapCanvas");
  MAG_CANVAS = document.getElementById("magCanvas");
  MAP_CTX = MAP_CANVAS.getContext("2d");
  MAG_CTX = MAG_CANVAS.getContext("2d");

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = MAP_CANVAS.parentElement.getBoundingClientRect();

  MAP_CANVAS.width = Math.floor(rect.width * dpr);
  MAP_CANVAS.height = Math.floor(rect.height * dpr);
  MAG_CANVAS.width = MAP_CANVAS.width;
  MAG_CANVAS.height = MAP_CANVAS.height;

  const draw = () => {
    MAP_CTX.clearRect(0, 0, MAP_CANVAS.width, MAP_CANVAS.height);
    MAP_CTX.drawImage(MAP_IMG, 0, 0, MAP_CANVAS.width, MAP_CANVAS.height);
  };

  if (!MAP_IMG) {
    MAP_IMG = new Image();
    MAP_IMG.onload = draw;
    MAP_IMG.src = "assets/images/ndf_map.png";
  } else {
    draw();
  }
}
const ndfIconEl = document.getElementById("ndfIcon");

/* ---------- Icon registry per-hex ---------- */
const HEX_ICONS = {
  1: { src: "assets/images/icons/ndfHQ.png", title: "Nerds Defense Force HQ", alt: "NDF HQ" }
};

/* ---------- Hex grid build ---------- */
let HEX_AXIAL = [], HEX_NODES = [];
let HEX_META = null;
const UNLOCKED = new Set([1]); // demo: HQ captured

function axialToPixel(q, rAx) {
  const { r, SQRT3, cx0, cy0 } = HEX_META;
  return { x: r * (SQRT3 * q + (SQRT3 / 2) * rAx) + cx0, y: r * (1.5 * rAx) + cy0 };
}
function axialDistance(a, b) {
  const x1 = a.q, z1 = a.r, y1 = -x1 - z1;
  const x2 = b.q, z2 = b.r, y2 = -x2 - z2;
  return Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2), Math.abs(z1 - z2));
}

function buildHex() {
  const svg = document.getElementById("hexSvg");
  svg.innerHTML = "";
  HEX_AXIAL = []; HEX_NODES = [];

  const w = MAP_VB_W, h = MAP_VB_H;
  const margin = 6;
  const cols = 24;
  const r = (w - 2 * margin) / (1.5 * (cols - 1) + 2);
  const SQRT3 = Math.sqrt(3);
  const cx0 = w / 2, cy0 = h / 2;
  HEX_META = { r, SQRT3, cx0, cy0 };

  function hexPath(px, py) {
    let d = ""; for (let i = 0; i < 6; i++) {
      const a = (60 * i - 30) * Math.PI / 180;
      d += (i ? "L" : "M") + (px + r * Math.cos(a)).toFixed(2) + "," + (py + r * Math.sin(a)).toFixed(2);
    } return d + "Z";
  }
  function* spiral(radius) {
    yield { q: 0, r: 0 };
    const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
    for (let k = 1; k <= radius; k++) {
      let q = -k, r = k;
      for (let side = 0; side < 6; side++) {
        for (let step = 0; step < k; step++) {
          yield { q, r }; q += DIRS[side].q; r += DIRS[side].r;
        }
      }
    }
  }

  const ringsX = Math.ceil(((w / 2) - margin) / (SQRT3 * r));
  const ringsY = Math.ceil(((h / 2) - margin) / (1.5 * r));
  const R = Math.max(ringsX, ringsY) + 2;

  let id = 1;
  for (const axial of spiral(R)) {
    const { x, y } = axialToPixel(axial.q, axial.r);
    if (x < -r || x > w + r || y < -r || y > h + r) continue;

    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", hexPath(x, y));
    p.setAttribute("class", "hex");
    p.setAttribute("role", "button"); p.setAttribute("tabindex", "0");
    p.setAttribute("data-id", id); p.setAttribute("data-q", axial.q); p.setAttribute("data-r", axial.r);
    p.setAttribute("vector-effect", "non-scaling-stroke");

    // stack hovered hex to top & magnify
    p.addEventListener("mouseenter", () => svg.appendChild(p));
    p.addEventListener("mouseenter", () => drawMagnify(id, 1.12));
    p.addEventListener("mousemove", () => drawMagnify(id, 1.12));
    p.addEventListener("mouseleave", clearMagnify);

    // click → detail modal (with icon if attached)
    p.addEventListener("click", (e) => {
      const hid = Number(e.currentTarget.getAttribute("data-id"));
      const meta = HEX_ICONS[hid];
      const titleEl = document.getElementById("modaltitle");
      const contentEl = document.getElementById("modalcontent");
      if (meta) {
        titleEl.textContent = meta.title;
        contentEl.innerHTML = `
          <div class="media">
            <img src="${meta.src}" alt="${meta.alt || ""}">
            <div>
              <p><strong>Hex #${hid}</strong></p>
              <p>${meta.title}</p>
            </div>
          </div>`;
      } else {
        titleEl.textContent = "Hex Selected";
        contentEl.innerHTML = `You clicked hex <strong>#${hid}</strong>.`;
      }
      document.getElementById("modal").classList.add("show");
    });
    p.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); p.click(); } });

    svg.appendChild(p);
    HEX_AXIAL[id] = axial; HEX_NODES[id] = p;
    id++;
  }

  applyTerritoryClasses();
  placeHQIcon();
  updateProgress();
}

/* ===== Universal closers (ESC, backdrop, buttons) ===== */
function closeBackdrop(backdropId){
  const el = document.getElementById(backdropId);
  if (el && (el.classList.contains('show') || el.classList.contains('open'))){
    el.classList.remove('show','open');
    return true;
  }
  return false;
}
document.addEventListener('click', (e) => {
  // [data-close] anywhere closes its nearest backdrop/modal
  const btn = e.target.closest('[data-close]');
  if (btn){
    const bd = btn.closest('.modal-backdrop, .file-backdrop');
    if (bd){ bd.classList.remove('show','open'); }
  }
  // clicking backdrop (outside modal) closes
  const bd = e.target.classList.contains('modal-backdrop') ? e.target :
             e.target.classList.contains('file-backdrop') ? e.target : null;
  if (bd){ bd.classList.remove('show','open'); }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  let closed = false;
  closed = closeBackdrop('linkBackdrop') || closed;
  closed = closeBackdrop('modal') || closed;
  closed = closeBackdrop('fileBackdrop') || closed;
  if (!closed && adminPanel.classList.contains('open')) closeAdminPanel();
});

/* ---------- Territory look ---------- */
function applyTerritoryClasses() {
  for (let id = 1; id < HEX_NODES.length; id++) {
    const node = HEX_NODES[id]; if (!node) continue;
    node.className = "hex";
    if (UNLOCKED.has(id)) { node.classList.add("captured"); continue; }
    let dmin = Infinity;
    for (const u of UNLOCKED) {
      const d = axialDistance(HEX_AXIAL[id], HEX_AXIAL[u]);
      if (d < dmin) dmin = d;
    }
    node.classList.add("locked");
    if (dmin === 1) node.classList.add("adjacent");
    else if (dmin === 2) node.classList.add("near");
    else if (dmin === 3 || dmin === 4) node.classList.add("mid");
    else node.classList.add("far");
  }
}

/* Position HQ icon (hex #1) and snap to pixel to avoid blur */
function placeHQIcon() {
  if (!HEX_META || !HEX_AXIAL[1]) return;

  const mc = document.getElementById("mapContent");
  if (ndfIconEl.parentElement !== mc) { mc.appendChild(ndfIconEl); }

  const { x, y } = axialToPixel(HEX_AXIAL[1].q, HEX_AXIAL[1].r);
  const sx = document.getElementById("mapCanvas").clientWidth / MAP_VB_W;
  const sy = document.getElementById("mapCanvas").clientHeight / MAP_VB_H;
  const snappedX = Math.round(x * sx) / sx;
  const snappedY = Math.round(y * sy) / sy;

  ndfIconEl.style.position = 'absolute';
  ndfIconEl.style.left = (snappedX / MAP_VB_W * 100) + "%";
  ndfIconEl.style.top = (snappedY / MAP_VB_H * 100) + "%";
}

/* ---------- Hex magnifier ---------- */
function clearMagnify() { if (MAG_CTX) { MAG_CTX.clearRect(0, 0, MAG_CANVAS.width, MAG_CANVAS.height); } }
function drawMagnify(id, scale) {
  if (!HEX_AXIAL[id] || !MAP_IMG || !MAP_CANVAS) return;
  const sx = MAP_CANVAS.width / MAP_VB_W;
  const sy = MAP_CANVAS.height / MAP_VB_H;
  const { r } = HEX_META;
  const { x, y } = axialToPixel(HEX_AXIAL[id].q, HEX_AXIAL[id].r);
  const cx = x * sx, cy = y * sy, rad = r * sx;

  MAG_CTX.save();
  MAG_CTX.clearRect(0, 0, MAG_CANVAS.width, MAG_CANVAS.height);

  MAG_CTX.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (60 * i - 30) * Math.PI / 180;
    const px = cx + rad * Math.cos(a);
    const py = cy + rad * Math.sin(a);
    if (i === 0) MAG_CTX.moveTo(px, py); else MAG_CTX.lineTo(px, py);
  }
  MAG_CTX.closePath();
  MAG_CTX.clip();

  MAG_CTX.translate(cx, cy);
  MAG_CTX.scale(scale, scale);
  MAG_CTX.translate(-cx, -cy);
  MAG_CTX.drawImage(MAP_IMG, 0, 0, MAP_CANVAS.width, MAP_CANVAS.height);
  MAG_CTX.restore();
}

/* ---------- Zoom & drag ---------- */
let zoom = 1, panX = 0, panY = 0;
const mapContent = () => document.getElementById("mapContent");
const viewportEl = () => document.getElementById("mapViewport");

function applyTransform() {
  mapContent().style.transform = `translate(calc(-50% + ${panX}px), calc(-50% + ${panY}px)) scale(${zoom})`;
  document.getElementById("zoomOut").disabled = zoom <= 1.001;
  document.getElementById("zoomIn").disabled = zoom >= 4 - 1e-3;
}
function clampPan() {
  const vp = viewportEl().getBoundingClientRect();
  const maxX = (vp.width * (zoom - 1)) / 2;
  const maxY = (vp.height * (zoom - 1)) / 2;
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
}
function setZoom(next, fx, fy) {
  const vp = viewportEl().getBoundingClientRect();
  const old = zoom; zoom = Math.max(1, Math.min(4, next)); if (Math.abs(zoom - old) < 1e-3) return;

  const content = mapContent().getBoundingClientRect();
  const cx = (typeof fx === "number" ? fx : (vp.left + vp.width / 2));
  const cy = (typeof fy === "number" ? fy : (vp.top + vp.height / 2));
  const dx = cx - (content.left + content.width / 2);
  const dy = cy - (content.top + content.height / 2);

  panX += dx * (1 - old / zoom);
  panY += dy * (1 - old / zoom);

  clampPan(); applyTransform();
}
document.getElementById("zoomIn").addEventListener("click", (e) => setZoom(zoom + 0.5, e.clientX, e.clientY));
document.getElementById("zoomOut").addEventListener("click", (e) => setZoom(zoom - 0.5, e.clientX, e.clientY));

(function enableDrag() {
  let dragging = false, lastX = 0, lastY = 0;
  const vp = viewportEl();

  const start = (x, y) => {
    if (zoom <= 1.001) return;
    dragging = true; lastX = x; lastY = y;
  };
  const move = (x, y) => {
    if (!dragging) return;
    const dx = x - lastX, dy = y - lastY;
    panX += dx; panY += dy; clampPan(); applyTransform();
    lastX = x; lastY = y;
  };
  const end = () => { dragging = false; };

  vp.addEventListener("mousedown", e => start(e.clientX, e.clientY));
  window.addEventListener("mousemove", e => move(e.clientX, e.clientY));
  window.addEventListener("mouseup", end);

  vp.addEventListener("touchstart", e => { if (e.touches.length) { const t = e.touches[0]; start(t.clientX, t.clientY); } }, { passive: true });
  window.addEventListener("touchmove", e => { if (!dragging || !e.touches.length) return; const t = e.touches[0]; move(t.clientX, t.clientY); }, { passive: true });
  window.addEventListener("touchend", end);
})();

/* ---------- Folder table ---------- */
const ITEMS = [
  { id: "apps", title: "Applications", text: "Open NDF apps & games.", type: "envelope" },
  { id: "missions", title: "NDF Missions (Coming Soon)", text: "Operations & mission briefs.", type: "envelope" },
  { id: "segments", title: "Segments", text: "On-show segments.", type: "envelope" }
];
const itemsGrid = document.getElementById("itemsGrid");
function makeItemCard(item) {
  return el("div", {
    class: "item", role: "button", tabindex: "0", "data-id": item.id,
    onmouseenter: (e) => showTip(item.title, e.clientX, e.clientY),
    onmousemove: (e) => showTip("", e.clientX, e.clientY),
    onmouseleave: () => tooltip.classList.remove("show"),
    onclick: () => openItem(item)
  }, el("h3", {}, item.title), el("p", {}, item.text));
}
function renderItems() { itemsGrid.innerHTML = ""; ITEMS.forEach(it => itemsGrid.appendChild(makeItemCard(it))); }
renderItems();

function openItem(item) {
  document.getElementById("fileTab").textContent = item.title.toUpperCase();
  document.getElementById("fileTitle").textContent = item.title;

  if (item.id === "apps") {
    document.getElementById("fileBody").innerHTML = appsListHTML();
  } else if (item.id === "missions") {
    document.getElementById("fileBody").innerHTML = `
      <p>Mission dossiers:</p>
      <ul style="margin:0; padding-left:18px; line-height:1.6"></ul>`;
  } else if (item.id === "segments") {
    document.getElementById("fileBody").innerHTML = `
      <p>Segment controllers:</p>
      <ul style="margin:0; padding-left:18px; line-height:1.6">
        <li>Lore-ology</li><li>Nerdsfari</li><li>Weeb's Anime Corner</li><li>Fuck Math</li>
      </ul>`;
  }
  document.getElementById("fileBackdrop").classList.add("show");
}

function appsListHTML() {
  const apps = [
    { slug: "garages", label: "LCU Grand Prix - Garages" },
    { slug: "racer", label: "LCU Grand Prix - Track" },
    { slug: "balls", label: "Dragonball Scanner" },
    { slug: "becky", label: "Becky Ball" },
    { slug: "deal", label: "Deal or no Deal" },
    { slug: "hunger", label: "Hunger Games" },
    { slug: "jump", label: "Nerds Can't Jump" },
    { slug: "slice", label: "Trim the Fats" },
    { slug: "voting", label: "Voting Machine" }
  ];
  const rows = apps.map(a => `<li><a href="apps/${a.slug}/${a.slug}.html">${a.label}</a></li>`).join("");
  return `<p>Choose an application:</p>
          <ul style="margin:0; padding-left:18px; line-height:1.6">${rows}</ul>`;
}

/* ---------- Progress ---------- */
function updateProgress() {
  const total = HEX_NODES.filter(Boolean).length;
  const unlocked = [...UNLOCKED].length;
  const pct = total ? (unlocked / total * 100) : 0;
  document.getElementById("progFill").style.width = pct.toFixed(1) + "%";
  document.getElementById("progLabel").textContent = `Campaign Progress — ${pct.toFixed(1)}%`;
}

/* ---------- Init & resize ---------- */
function build() { drawMap(); buildHex(); applyTransform(); }
build();
let rTO; window.addEventListener("resize", () => { clearTimeout(rTO); rTO = setTimeout(() => { drawMap(); placeHQIcon(); applyTransform(); }, 120); });

/* =========================================================
   ===================  ADMIN PANEL  =======================
   ========================================================= */

const adminToggleBtn = document.getElementById("adminToggle");
const adminPanel = document.getElementById("adminPanel");
const btnLogout = document.getElementById("btnLogout");
const btnLink = document.getElementById("btnLink");
const linkState = document.getElementById("linkState");
const adminLog = document.getElementById("adminLog");
const linkBackdrop = document.getElementById("linkBackdrop");
const linkSave = document.getElementById("linkSave");
const linkCancel = document.getElementById("linkCancel");
const streamUrlInput = document.getElementById("streamUrl");

/* ===== Stats tracking for parser events ===== */
const STATS = { superchat: 0, gifted: 0, membership: 0, viewers: null };
function renderStats(){
  const g = (id) => document.getElementById(id);
  if (!g('statSuperchat')) return; // HTML counters might not be present in some views
  g("statSuperchat").textContent  = STATS.superchat;
  g("statGifted").textContent     = STATS.gifted;
  g("statMembership").textContent = STATS.membership;
  if (g("statViewers")) {
    g("statViewers").textContent = (STATS.viewers == null)
      ? '—'
      : Number(STATS.viewers).toLocaleString();
  }
}
function resetStats(){
  STATS.superchat = STATS.gifted = STATS.membership = 0;
  STATS.viewers = null;
  renderStats();
}

/* =================== PARSER CONNECTION =================== */
/** Pick parser origin: meta override, then localhost fallback, then production default */
const META_ORIGIN = document.querySelector('meta[name="nerds-parser-origin"]')?.content?.trim();
const PARSER_ORIGIN =
  META_ORIGIN ||
  ((location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? 'http://localhost:8080'
                                                                             : 'https://your-parser-domain.example');

let es = null;        // current EventSource
let sessionId = null; // current parser session id

/** Append a line to the admin log area */
function logAdmin(msg) {
  const time = new Date().toLocaleTimeString();
  adminLog.textContent += `[${time}] ${msg}\n`;
  adminLog.scrollTop = adminLog.scrollHeight;
}

/** Reset UI bits related to a link */
function resetLinkUI() {
  linkState.textContent = 'No stream linked';
  btnLink.textContent = 'Link stream';
}

/** Cleanly stop the current parser session */
async function stopParser() {
  if (es) { try { es.close(); } catch {} es = null; }
  if (sessionId) {
    try { await fetch(`${PARSER_ORIGIN}/stop/${sessionId}`, { method: 'POST' }); }
    catch {}
    sessionId = null;
  }
}

/** Start a new parser session for a given YouTube URL */
async function startParser(url) {
  // Fresh slate for each link
  resetStats();
  adminLog.textContent = "";

  await stopParser();              // ensure any previous session is closed
  logAdmin(`Starting parser…`);
  let res, json;
  try {
    res = await fetch(`${PARSER_ORIGIN}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
  } catch (e) {
    logAdmin(`❌ Network error contacting parser: ${e.message || e}`);
    resetLinkUI();
    return;
  }

  try { json = await res.json(); } catch { json = {}; }
  if (!res.ok || !json.sessionId) {
    logAdmin(`⚠️ Failed to start: ${JSON.stringify(json)}`);
    resetLinkUI();
    return;
  }

  sessionId = json.sessionId;
  linkState.textContent = 'Stream linked';
  btnLink.textContent = 'Stream linked';
  logAdmin(`✅ Session ${sessionId} started`);

  // Subscribe to updates
  try {
    es = new EventSource(`${PARSER_ORIGIN}/events/${sessionId}`);
  } catch (e) {
    logAdmin(`❌ Could not open event stream: ${e.message || e}`);
    return;
  }

  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data);
      const t = (data.type || "").toLowerCase();

      // Stream meta → update viewers in stats
      if (t === 'meta' && typeof data.viewers !== 'undefined') {
        STATS.viewers = Number(data.viewers) || 0;
        renderStats();
      }

      // Normalize type and increment counters
      if (t === "superchat") {
        STATS.superchat++;
      } else if (t === "gift" || t === "gifted" || t === "gifted_members") {
        STATS.gifted++;
      } else if (t === "membership" || t === "new_membership") {
        STATS.membership++;
      }
      renderStats();

      logAdmin(`→ ${t || 'event'}: ${JSON.stringify(data)}`);
    } catch {
      logAdmin(`→ ${ev.data}`);
    }
  };
  es.onerror = () => { logAdmin('⚠️ Event stream error. Will need to relink.'); };
}

/* =================== UI WIRING (panel + modal) =================== */
function openAdminPanel(){
  adminPanel.classList.add("open");
  adminPanel.setAttribute("aria-hidden","false");
  adminToggleBtn.setAttribute("aria-expanded","true");
}
function closeAdminPanel(){
  adminPanel.classList.remove("open");
  adminPanel.setAttribute("aria-hidden","true");
  adminToggleBtn.setAttribute("aria-expanded","false");
}

(function wireAdmin() {
  // Toggle open/close without disabling the button permanently
  adminToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    adminPanel.classList.contains('open') ? closeAdminPanel() : openAdminPanel();
  });

  // Click outside closes panel
  document.addEventListener('click', (e) => {
    if (!adminPanel.classList.contains('open')) return;
    if (adminPanel.contains(e.target) || e.target === adminToggleBtn) return;
    closeAdminPanel();
  });

  // Logout: clear session + go to real root /lolcownerd/index.html (works local + web)
  btnLogout.addEventListener('click', async (e) => {
    e.preventDefault();
    await stopParser();
    try { localStorage.removeItem('nerdsSession'); } catch {}
    const root = `${location.origin}/lolcownerd/index.html`;
    try { window.location.replace(root); } catch { window.location.href = root; }
  });
})();

/* =================== LINK STREAM MODAL =================== */
(function wireLinkModal() {
  const openBtn  = btnLink;
  const backdrop = linkBackdrop;
  const input    = streamUrlInput;
  const saveBtn  = linkSave;
  const cancel   = linkCancel;

  const open = () => { backdrop.classList.add('open'); setTimeout(() => input.focus(), 0); };
  const close = () => { backdrop.classList.remove('open'); input.value = ''; };

  // If a stream is linked, clicking the button disconnects and clears;
  // otherwise open the "Link" modal.
  openBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (sessionId) {
      await stopParser();
      resetLinkUI();
      adminLog.textContent = "";
      resetStats();
      logAdmin('🔌 Disconnected and cleared console.');
      return;
    }
    open();
  });

  cancel.addEventListener('click', (e) => { e.preventDefault(); close(); });
  // backdrop click closes (handled globally too, but this is explicit)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  saveBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) { input.focus(); return; }
    close();
    await startParser(url);
  });
})();
// ------ canvas & HUD refs ------
const boardEl  = document.getElementById('board');
const ctx      = boardEl.getContext('2d');

const nextEl   = document.getElementById('next');
const nctx     = nextEl.getContext('2d');

const scoreEl  = document.getElementById('score');
const highEl   = document.getElementById('high');
const speedEl  = document.getElementById('speed');
const toastBox = document.getElementById('toast');

// ------ tuning (client only; board size syncs from server state) ------
const CELL = 32;
let COLS = 20, ROWS = 40;            // will be updated from /state
let FLOOR_ROWS = 2;                  // server sends this too

// 8/16-bit palette (I,O,T,S,Z,J,L) → ids 1..7
const COLORS = ['#20D4F8','#FFC54D','#B98AFF','#49E37B','#FF5C5C','#68A8FF','#F7A33A'];

// shapes for local rendering of current/next
const SHAPES = [
  [[1,1,1,1]],                // I
  [[2,2],[2,2]],              // O
  [[0,3,0],[3,3,3]],          // T
  [[0,4,4],[4,4,0]],          // S
  [[5,5,0],[0,5,5]],          // Z
  [[6,0,0],[6,6,6]],          // J
  [[0,0,7],[7,7,7]],          // L
];

function rotCW(m){
  const h=m.length, w=m[0].length, out=Array.from({length:w},()=>Array(h).fill(0));
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) out[x][h-1-y]=m[y][x];
  return out;
}
function shapeOf(id, r=0){ let s=SHAPES[id]; for(let i=0;i<(r%4);i++) s=rotCW(s); return s; }

function resizeCanvas(canvas, cols, rows, cell){
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width  = `${cols*cell}px`;
  canvas.style.height = `${rows*cell}px`;
  canvas.width  = Math.floor(cols*cell*dpr);
  canvas.height = Math.floor(rows*cell*dpr);
  canvas.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}

// unified cell drawing (with tiny bevel)
function drawCell(c, x, y, val, cell=CELL){
  if (!val) return;
  const color = COLORS[(val-1)%COLORS.length] || '#8bb8ff';
  c.fillStyle = color;
  c.fillRect(x*cell+1, y*cell+1, cell-2, cell-2);
  c.fillStyle = 'rgba(255,255,255,0.08)'; // top/left
  c.fillRect(x*cell+1, y*cell+1, cell-2, 3);
  c.fillRect(x*cell+1, y*cell+1, 3, cell-2);
  c.fillStyle = 'rgba(0,0,0,0.18)';       // bottom/right
  c.fillRect(x*cell+1, y*cell+cell-4, cell-2, 3);
  c.fillRect(x*cell+cell-4, y*cell+1, 3, cell-2);
}

// ultra-subtle grid, single stroke so alpha doesn't stack
function renderGrid(c, cols, rows, cell = CELL){
  c.save();
  c.globalAlpha = 0.05;        // very faint overall
  c.strokeStyle = '#ffffff';
  c.lineWidth = 1;

  // draw all lines in one path (prevents brightness stacking)
  c.beginPath();
  // 0.5 offset for crisp 1px lines on whole-pixel canvas
  for (let x = 0; x <= cols; x++){
    const X = x * cell + 0.5;
    c.moveTo(X, 0);
    c.lineTo(X, rows * cell);
  }
  for (let y = 0; y <= rows; y++){
    const Y = y * cell + 0.5;
    c.moveTo(0, Y);
    c.lineTo(cols * cell, Y);
  }
  c.stroke();
  c.restore();
}

function renderPlayfieldGrid(){
  const PAD  = 2;
  const WALL = Math.max(6, Math.floor(CELL * 0.22));

  // interior rect (exclude side walls + 2-row floor)
  const x = PAD + WALL;
  const y = 0;
  const w = COLS * CELL - 2 * (PAD + WALL);
  const h = (ROWS - FLOOR_ROWS) * CELL;
  if (w <= 0 || h <= 0) return;

  ctx.save();
  // clip to the interior
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // translate so grid 0,0 aligns to the inner-left/top of the well
  ctx.translate(x, y);
  renderGrid(ctx, COLS, ROWS - FLOOR_ROWS, CELL);
  ctx.restore();
}

function renderBoard(board){
  if (!board || !board.length) return;
  const rows = board.length, cols = board[0].length;
  if (rows !== ROWS || cols !== COLS){
    ROWS = rows; COLS = cols;
    resizeCanvas(boardEl, COLS, ROWS, CELL);
  }
  ctx.clearRect(0,0,boardEl.width,boardEl.height);
  for (let y=0; y<rows; y++){
    for (let x=0; x<cols; x++){
      const v = board[y][x];
      if (v) drawCell(ctx, x, y, v);
    }
  }
  renderPlayfieldGrid();
}

function renderCurrent(cur){
  if (!cur) return;
  const s = shapeOf(cur.id, cur.r);
  for (let y=0; y<s.length; y++){
    for (let x=0; x<s[0].length; x++){
      if (s[y][x]) drawCell(ctx, cur.x + x, cur.y + y, s[y][x]);
    }
  }
}

function renderNext(nextId){
  if (nextId == null) { nctx.clearRect(0,0,nextEl.width,nextEl.height); return; }
  const MINI = 26;
  if (nextEl.style.width !== `${5*MINI}px`) resizeCanvas(nextEl, 5, 5, MINI);
  nctx.clearRect(0,0,nextEl.width,nextEl.height);
  const s = shapeOf(nextId, 0);
  const offsetX = Math.floor((5 - s[0].length)/2);
  const offsetY = Math.floor((5 - s.length)/2);
  for (let y=0; y<s.length; y++){
    for (let x=0; x<s[0].length; x++){
      if (s[y][x]) drawCell(nctx, offsetX + x, offsetY + y, s[y][x], MINI);
    }
  }
}

// 3-D gray “brick” rectangles (for side walls + 2-row floor)
function drawBrickRect(c, x, y, w, h){
  c.fillStyle = '#cfd6e4';
  c.fillRect(x, y, w, h);
  const b = Math.max(1, Math.floor(Math.min(w,h)*0.58));
  c.fillStyle = 'rgba(255,255,255,0.2)'; // top/left
  c.fillRect(x, y, w, b);
  c.fillRect(x, y, b, h);
  c.fillStyle = 'rgba(0,0,0,0.3)';       // bottom/right
  c.fillRect(x, y+h-b, w, b);
  c.fillRect(x+w-b, y, b, h);
}

function renderWellWalls(){
  const PAD  = 2;                                   // inset from canvas edge
  const WALL = Math.max(10, Math.floor(CELL*0.3));  // side wall thickness

  // side columns (one brick per play row)
  for (let y=0; y<ROWS; y++){
    drawBrickRect(ctx, PAD, y*CELL, WALL, CELL);                 // left
    drawBrickRect(ctx, COLS*CELL - WALL - PAD, y*CELL, WALL, CELL);                 // right
  }

  // two-row floor behind pieces
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  for (let x=0; x<COLS; x++){
    drawBrickRect(ctx, x*CELL, (ROWS-2)*CELL, CELL, CELL);  // row -2
    drawBrickRect(ctx, x*CELL, (ROWS-1)*CELL, CELL, CELL);  // bottom row
  }
  ctx.restore();
}

// ------ countdown + modal helpers ------
let lastScore = 0, lastHigh = 0;

function effectLabel(effect, added=0){
  if (!effect) return '';
  if (effect.type === 'clear_rows') return `${effect.count} Lines Cleared`;
  if (effect.type === 'swap_next')  return `Next piece swapped`;
  if (effect.type === 'half_rows')  return `Removed half of all rows (${added} scored)`;
  if (effect.type === 'full_reset') return `Full board reset (${added} scored)`;
  return '';
}

function showCountdown(n=3){
  const box = document.getElementById('countdown');
  if (!box) return;
  box.style.display = 'flex';
  let t = n;
  box.textContent = t;
  const int = setInterval(()=>{
    t--;
    if (t <= 0){
      box.textContent = 'GO!';
      clearInterval(int);
      setTimeout(()=>{ box.style.display='none'; }, 600);
    } else {
      box.textContent = t;
    }
  }, 1000);
}

function showGameOverModal(){
  const m = document.getElementById('gameModal');
  const msg = document.getElementById('gameModalMsg');
  if (!m || !msg) return;
  const beat = lastScore > lastHigh;
  msg.textContent =
`Final Score: ${lastScore}
High Score: ${lastHigh}${beat ? '\n\n🎉 New high score set — nice! 🎉' : ''}`;
  m.style.display = 'flex';
}

document.getElementById('restartBtn')?.addEventListener('click', async ()=>{
  try { await fetch('/admin/restart', { method:'POST' }); } catch {}
  const m = document.getElementById('gameModal'); if (m) m.style.display='none';
  showCountdown(3);
});

// ------ SSE wiring (no TDZ) ------
let es;

function onState(ev){
  const s = JSON.parse(ev.data);

  // keep latest (for modal + client floor rows)
  lastScore  = s.score ?? lastScore;
  lastHigh   = s.highScore ?? lastHigh;
  FLOOR_ROWS = Number(s.floorRows ?? FLOOR_ROWS);

  // HUD
  scoreEl.textContent = String(s.score ?? 0);
  highEl.textContent  = String(s.highScore ?? 0);
  const base = 1000;
  const speed = s.gravityMs ? (base / s.gravityMs).toFixed(2) : '1.00';
  speedEl.textContent = `x${speed}`;

  // draw
  renderBoard(s.board);
  renderCurrent(s.current);
  renderWellWalls();

  const nextId = (s.next != null) ? s.next : (Array.isArray(s.nextQueue) ? s.nextQueue[0] : null);
  renderNext(nextId);
}

function onToast(ev){
  const t = JSON.parse(ev.data);
  const el = document.createElement('div');
  el.className='card';
  if (t.kind === 'superchat') {
    el.innerHTML = `<b>${t.author}</b> Superchat – “${t.message||''}”<br/>${effectLabel(t.effect, t.added)}`;
  } else if (t.kind === 'gift') {
    el.innerHTML = `<b>${t.author}</b> Gifted <b>${t.count}</b> memberships<br/>Speed reduced by ${(t.count*2)}%`;
  }
  toastBox.innerHTML = ''; toastBox.appendChild(el);
  setTimeout(()=>{ if (toastBox.contains(el)) toastBox.removeChild(el); }, 5000);
}

function attachSSE(){
  if (es) es.close();
  es = new EventSource('/state');
  es.addEventListener('state', onState);
  es.addEventListener('toast', onToast);
  es.addEventListener('countdown', ev => {
    const d = JSON.parse(ev.data || '{}');
    showCountdown(Number(d.seconds) || 3);
  });
  es.addEventListener('error', () => { showGameOverModal(); });
}

window.addEventListener('beforeunload', ()=>{ try { es?.close(); } catch {} });

// initial sizing + connect
resizeCanvas(boardEl, COLS, ROWS, CELL);
attachSSE();
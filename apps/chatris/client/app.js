const boardEl = document.getElementById('board');
const ctx = boardEl.getContext('2d');

const nextEl = document.getElementById('next');
const nctx = nextEl.getContext('2d');

const scoreEl = document.getElementById('score');
const highEl  = document.getElementById('high');
const speedEl = document.getElementById('speed');
const viewersEl = document.getElementById('viewers');
const toast = document.getElementById('toast');

const CELL = 32;
let COLS = 10, ROWS = 40; // will sync to server on first state

// 8/16-bit-ish palette for piece ids 1..7 (I,O,T,S,Z,J,L)
const COLORS = ['#20D4F8','#FFC54D','#B98AFF','#49E37B','#FF5C5C','#68A8FF','#F7A33A'];

// Shapes for drawing current/next locally
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
  const h=m.length,w=m[0].length,out=Array.from({length:w},()=>Array(h).fill(0));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)out[x][h-1-y]=m[y][x];
  return out;
}
function shapeOf(id,r=0){ let s=SHAPES[id]; for(let i=0;i<(r%4);i++) s=rotCW(s); return s; }

function resizeCanvas(canvas, cols, rows, cell){
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${cols*cell}px`;
  canvas.style.height = `${rows*cell}px`;
  canvas.width = Math.floor(cols*cell*dpr);
  canvas.height = Math.floor(rows*cell*dpr);
  canvas.getContext('2d').setTransform(dpr,0,0,dpr,0,0);
}

/** FIX: unified drawCell that accepts context + cell size */
function drawCell(c, x, y, val, cell=CELL){
  if (!val) return;
  const color = COLORS[(val-1)%COLORS.length] || '#8bb8ff';
  // simple pixel-ish bevel
  c.fillStyle = color;
  c.fillRect(x*cell+1, y*cell+1, cell-2, cell-2);
  c.fillStyle = 'rgba(255,255,255,0.08)';
  c.fillRect(x*cell+1, y*cell+1, cell-2, 3);
  c.fillRect(x*cell+1, y*cell+1, 3, cell-2);
  c.fillStyle = 'rgba(0,0,0,0.18)';
  c.fillRect(x*cell+1, y*cell+cell-4, cell-2, 3);
  c.fillRect(x*cell+cell-4, y*cell+1, 3, cell-2);
}

function renderGrid(c, cols, rows, cell=CELL){
  c.strokeStyle = 'rgba(255,255,255,0.06)';
  c.lineWidth = 1;
  for (let x=0; x<=cols; x++){ c.beginPath(); c.moveTo(x*cell,0); c.lineTo(x*cell, rows*cell); c.stroke(); }
  for (let y=0; y<=rows; y++){ c.beginPath(); c.moveTo(0,y*cell); c.lineTo(cols*cell, y*cell); c.stroke(); }
}

function renderBoard(board){
  if (!board || !board.length) return;
  const rows = board.length, cols = board[0].length;
  if (rows !== ROWS || cols !== COLS){
    ROWS = rows; COLS = cols; resizeCanvas(boardEl, COLS, ROWS, CELL);
  }
  ctx.clearRect(0,0,boardEl.width,boardEl.height);
  // draw locked cells
  for (let y=0; y<rows; y++){
    for (let x=0; x<cols; x++){
      const v = board[y][x];
      if (v) drawCell(ctx, x, y, v);
    }
  }
  renderGrid(ctx, COLS, ROWS, CELL);
}

function renderCurrent(cur){
  if(!cur) return;
  const s = shapeOf(cur.id, cur.r);
  for(let y=0;y<s.length;y++){
    for(let x=0;x<s[0].length;x++){
      if(s[y][x]) drawCell(ctx, cur.x+x, cur.y+y, s[y][x]);
    }
  }
}

function renderNext(nextId){
  if (nextId == null) { nctx.clearRect(0,0,nextEl.width,nextEl.height); return; }
  const MINI = 26;
  resizeCanvas(nextEl, 5, 5, MINI);
  nctx.clearRect(0,0,nextEl.width,nextEl.height);
  const s = shapeOf(nextId, 0);
  const offsetX = Math.floor((5 - s[0].length)/2);
  const offsetY = Math.floor((5 - s.length)/2);
  for (let y=0; y<s.length; y++){
    for (let x=0; x<s[0].length; x++){
      drawCell(nctx, offsetX + x, offsetY + y, s[y][x], MINI);
    }
  }
  renderGrid(nctx, 5, 5, MINI);
}

/** More “traditional” well bumpers on both sides + floor, drawn *inside* canvas */
function renderWellWalls(){
  const wall = Math.max(6, Math.floor(CELL*0.2)); // thickness in px
  ctx.save();
  ctx.fillStyle = 'rgba(235,240,255,0.22)';
  // left column of "blocks"
  for (let y=0; y<ROWS; y++){
    ctx.fillRect(1, y*CELL+1, wall, CELL-2);
  }
  // right column
  for (let y=0; y<ROWS; y++){
    ctx.fillRect(COLS*CELL - wall - 1, y*CELL+1, wall, CELL-2);
  }
  // floor
  ctx.fillRect(1, ROWS*CELL - wall - 1, COLS*CELL-2, wall);
  ctx.restore();
}

// ---- SSE wiring ----
const es = new EventSource('/state');

es.addEventListener('state', e=>{
  const s = JSON.parse(e.data);

  scoreEl.textContent   = String(s.score ?? 0);
  highEl.textContent    = String(s.highScore ?? 0);
  viewersEl.textContent = `Viewers: ${s.emaViewers ?? 0}`;

  const base = 1000;
  const speed = s.gravityMs ? (base / s.gravityMs).toFixed(2) : '1.00';
  speedEl.textContent = `Speed: x${speed}`;

  renderBoard(s.board);
  renderCurrent(s.current);
  renderWellWalls();

  const nextId = (s.next != null) ? s.next : (Array.isArray(s.nextQueue) ? s.nextQueue[0] : null);
  renderNext(nextId);
});

es.addEventListener('toast', e=>{
  const t = JSON.parse(e.data);
  const el = document.createElement('div');
  el.className='card';
  if (t.kind === 'superchat') {
    el.innerHTML = `<b>${t.author}</b> Superchat – “${t.message||''}”<br/>${effectLabel(t.effect, t.added)}`;
  } else if (t.kind === 'gift') {
    el.innerHTML = `<b>${t.author}</b> Gifted <b>${t.count}</b> memberships<br/>Speed reduced by ${(t.count*2)}%`;
  }
  document.getElementById('toast').innerHTML = '';
  document.getElementById('toast').appendChild(el);
  setTimeout(()=>{ if (document.getElementById('toast').contains(el)) document.getElementById('toast').removeChild(el); }, 5000);
});

function effectLabel(effect, added=0){
  if (!effect) return '';
  if (effect.type === 'clear_rows') return `${effect.count} Lines Cleared`;
  if (effect.type === 'swap_next') return `Next piece swapped`;
  if (effect.type === 'half_rows') return `Removed half of all rows (${added} scored)`;
  if (effect.type === 'full_reset') return `Full board reset (${added} scored)`;
  return '';
}

// initial size (crisp)
resizeCanvas(boardEl, COLS, ROWS, CELL);
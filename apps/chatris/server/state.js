import {
  BOARD_W, BOARD_H, FLOOR_ROWS, parseCommand, CHAT_COOLDOWN_MS, donationEffectFrom
} from './rules.js';

// If you keep SHAPES here:
const SHAPES = [
  [[1,1,1,1]],
  [[2,2],[2,2]],
  [[0,3,0],[3,3,3]],
  [[0,4,4],[4,4,0]],
  [[5,5,0],[0,5,5]],
  [[6,0,0],[6,6,6]],
  [[0,0,7],[7,7,7]],
];

function rotCW(m){ const h=m.length,w=m[0].length,o=Array.from({length:w},()=>Array(h).fill(0));
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) o[x][h-1-y]=m[y][x]; return o; }
function shapeOf(id,r=0){ let s=SHAPES[id]; for(let i=0;i<(r%4);i++) s=rotCW(s); return s; }

export class GameState {
  constructor() {
    this.board = Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(0));
    this.floorRows = FLOOR_ROWS;         
    this.score = 0;
    this.highScore = 0;
    this.emaViewers = 0;
    this.giftsRecent = 0;
    this.nextQueue = [];
    this.current = null; 
    this.running = false;
    this.sinceId = 0;     
    this.sinceViewerId = 0;
    this._gravAccMs = 0;
  }

  // --- lifecycle ------------------------------------------------------------
  start(){ this.clearBoard(false); this.running = true; if (!this.nextQueue.length) this._refillBag(); this.spawn(); }
  end(){ this.running = false; this.highScore = Math.max(this.highScore, this.score); }
  clearBoard(keepScore=false){ this.board = Array.from({ length: BOARD_H }, () => Array(BOARD_W).fill(0)); if(!keepScore) this.score=0; this.current=null; }
  resetAll(){ this.clearBoard(false); this.highScore=0; this.nextQueue=[]; this.current=null; }

  // --- piece queue / spawn --------------------------------------------------
  _refillBag() {
    const bag=[0,1,2,3,4,5,6]; // 0..6 piece IDs
    for (let i=bag.length-1;i>0;i--){ const j=(Math.random()* (i+1))|0; [bag[i],bag[j]]=[bag[j],bag[i]]; }
    this.nextQueue.push(...bag);
  }
  spawn() {
    if (!this.nextQueue.length) this._refillBag();
    const id = this.nextQueue.shift();
    const s  = shapeOf(id, 0);
    const w  = s[0].length;
    const x0 = Math.floor((BOARD_W - w) / 2);
    this.current = { id, x:x0, y:0, r:0 };
  }

  // --- collision, locking, lines -------------------------------------------
  collides(id, x, y, r){
    const s = shapeOf(id, r);
    for (let dy=0; dy<s.length; dy++){
      for (let dx=0; dx<s[0].length; dx++){
        if (!s[dy][dx]) continue;
        const gx = x+dx, gy = y+dy;
        if (gx < 0 || gx >= BOARD_W) return true;                      
        if (gy >= BOARD_H - this.floorRows) return true;              
        if (gy >= 0 && this.board[gy][gx]) return true;               
      }
    }
    return false;
  }

  lockCurrent(){
    if (!this.current) return;
    const { id, x, y, r } = this.current, s = shapeOf(id, r);
    for (let dy=0; dy<s.length; dy++)
      for (let dx=0; dx<s[0].length; dx++)
        if (s[dy][dx]) {
          const gx=x+dx, gy=y+dy;
          if (gy>=0 && gy<BOARD_H && gx>=0 && gx<BOARD_W) this.board[gy][gx]=s[dy][dx];
        }
    this.current=null;
    this.clearLines();
  }

  clearLines(){
    const bottomPlayable = BOARD_H - this.floorRows - 1;
    for (let y = bottomPlayable; y >= 0; ){
      if (this.board[y].every(Boolean)) {
        this.board.splice(y,1);
        this.board.unshift(Array(BOARD_W).fill(0));
        this.score += 1;
      } else y--;
    }
  }

  // --- step / gravity -------------------------------------------------------
  stepDown(){
    if (!this.current) return;
    const { id,x,y,r } = this.current;
    if (this.collides(id, x, y+1, r)) { this.lockCurrent(); this.spawn(); return true; }
    this.current.y++; return false;
  }

  pausedUntil = 0;

  pauseFor(ms){
    this.pausedUntil = Date.now() + ms;
    // optional: clear falling piece so the first spawn happens after countdown
    this.current = null;
    this._acc = 0;
  }  

  tick(dt, gravityMs=1000){
    if (!this.running) return;
    this._gravAccMs += dt;
    while (this._gravAccMs >= gravityMs){ this._gravAccMs -= gravityMs; this.stepDown(); }
  }

  // --- controls -------------------------------------------------------------
  moveLeft(){ if (this.current && !this.collides(this.current.id, this.current.x-1, this.current.y, this.current.r)) this.current.x--; }
  moveRight(){ if (this.current && !this.collides(this.current.id, this.current.x+1, this.current.y, this.current.r)) this.current.x++; }
  rotate(){
    if (!this.current) return;
    const nr = (this.current.r + 1) % 4;
    if (!this.collides(this.current.id, this.current.x, this.current.y, nr)) { this.current.r = nr; return; }
    // simple wall kick: try ±1
    if (!this.collides(this.current.id, this.current.x-1, this.current.y, nr)) { this.current.x--; this.current.r = nr; return; }
    if (!this.collides(this.current.id, this.current.x+1, this.current.y, nr)) { this.current.x++; this.current.r = nr; return; }
  }

  // --- effects (donations) --------------------------------------------------
  applyEffect(effect) {
    if (!effect) return 0;
    if (effect.type === 'clear_rows') {
      // clear N **playable** rows from the top of the stack preserving floor
      let cleared = 0;
      for (let n = 0; n < effect.count; n++) {
        // find highest non-empty playable row
        let target = -1;
        for (let y = 0; y < BOARD_H - this.floorRows; y++) {
          if (this.board[y].some(Boolean)) { target = y; break; }
        }
        if (target === -1) break;
        this.board.splice(target, 1);
        this.board.unshift(Array(BOARD_W).fill(0));
        cleared++;
      }
      // scoring handled in server/rules if needed
      return cleared;
    }
    if (effect.type === 'swap_next') {
      // Replace the next piece with a random new one
      const rand = (Math.random()*7)|0;
      if (this.nextQueue.length) this.nextQueue[0] = rand; else this.nextQueue.push(rand);
      return 0;
    }
    if (effect.type === 'half_rows') {
      // remove half of all **playable** occupied rows (round down)
      const playable = BOARD_H - this.floorRows;
      let occupied = [];
      for (let y=0;y<playable;y++) if (this.board[y].some(Boolean)) occupied.push(y);
      const toRemove = Math.floor(occupied.length / 2);
      while (occupied.length && occupied.length > (occupied.length - toRemove)) {
        const y = occupied.shift();
        this.board.splice(y,1);
        this.board.unshift(Array(BOARD_W).fill(0));
      }
      return toRemove;
    }
    if (effect.type === 'full_reset') {
      // reset board but keep score/highScore
      for (let y=0;y<BOARD_H - this.floorRows;y++) this.board[y].fill(0);
      this.current = null;
      this.nextQueue.length = 0; this._refillBag(); this.spawn();
      return 0;
    }
    return 0;
  }

  
  parseCommand(text, author, cooldownMap) {
    const cmd = parseCommand(text);
    if (!cmd) return null;
    const last = cooldownMap.get(author) || 0;
    if (Date.now() - last < CHAT_COOLDOWN_MS) return null;
    cooldownMap.set(author, Date.now());
    return cmd;
  }

  queueVote(cmd) {
    if (!this._windowCounts) this._windowCounts = { left: 0, right: 0, rotate: 0 };
    if (cmd === 'left' || cmd === 'right' || cmd === 'rotate') {
      this._windowCounts[cmd] = (this._windowCounts[cmd] || 0) + 1;
    }
  }

  effectForAmount(amount) { return donationEffectFrom(amount); }

  onGifts(count) { this.giftsRecent += count; }
}
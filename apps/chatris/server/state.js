// server/state.js
import { BOARD_W, BOARD_H } from './rules.js';

// 7 piece shapes, 0=empty; values 1..7 double as color ids.
const SHAPES = [
  // 0: I
  [[1,1,1,1]],
  // 1: O
  [[2,2],[2,2]],
  // 2: T
  [[0,3,0],[3,3,3]],
  // 3: S
  [[0,4,4],[4,4,0]],
  // 4: Z
  [[5,5,0],[0,5,5]],
  // 5: J
  [[6,0,0],[6,6,6]],
  // 6: L
  [[0,0,7],[7,7,7]],
];

function rotCW(mat){
  const h = mat.length, w = mat[0].length;
  const out = Array.from({length: w}, () => Array(h).fill(0));
  for (let y=0; y<h; y++) for (let x=0; x<w; x++) out[x][h-1-y] = mat[y][x];
  return out;
}
function shapeOf(id, r){
  let s = SHAPES[id];
  for (let i=0; i<(r%4); i++) s = rotCW(s);
  return s;
}

export class GameState {
  constructor(){ this.resetAll(); }

  resetAll(){
    this.board = Array.from({length: BOARD_H}, () => Array(BOARD_W).fill(0));
    this.score = 0;            // lines cleared (your spec)
    this.highScore = 0;
    this.nextQueue = this.seedBag();
    this.current = null;
    this.sinceId = 0;
    this.emaViewers = 0;
    this.giftsRecent = 0;
    this.hudToast = null;
    this._gravAccMs = 0;
    this.running = false;
  }

  start(){
    this.resetAll();
    this.running = true;
    this.current = this.spawn();
  }
  end(){
    this.running = false;
    this.highScore = Math.max(this.highScore, this.score);
  }
  clearBoard(keepScore=true){
    this.board = Array.from({length: BOARD_H}, () => Array(BOARD_W).fill(0));
    if (!keepScore) this.score = 0;
  }

  seedBag(){ return this.rollBag().concat(this.rollBag()); }
  rollBag(){
    const bag = [0,1,2,3,4,5,6];
    for (let i=bag.length-1; i>0; i--){ const j = Math.floor(Math.random()*(i+1)); [bag[i],bag[j]]=[bag[j],bag[i]]; }
    return bag;
  }
  ensureQueue(){ if (this.nextQueue.length < 7) this.nextQueue.push(...this.rollBag()); }

  spawn(){
    this.ensureQueue();
    const id = this.nextQueue.shift();
    const piece = { id, x: Math.floor(BOARD_W/2)-2, y: 0, r: 0 };
    // game over if cannot place
    if (!this.canPlace(piece)) { this.end(); }
    return piece;
  }

  canPlace(piece){
    const s = shapeOf(piece.id, piece.r);
    for (let y=0; y<s.length; y++){
      for (let x=0; x<s[0].length; x++){
        const v = s[y][x];
        if (!v) continue;
        const bx = piece.x + x;
        const by = piece.y + y;
        if (bx < 0 || bx >= BOARD_W || by < 0 || by >= BOARD_H) return false;
        if (this.board[by][bx]) return false;
      }
    }
    return true;
  }

  mergeCurrent(){
    const s = shapeOf(this.current.id, this.current.r);
    for (let y=0; y<s.length; y++){
      for (let x=0; x<s[0].length; x++){
        const v = s[y][x];
        if (!v) continue;
        const bx = this.current.x + x;
        const by = this.current.y + y;
        if (by >= 0 && by < BOARD_H && bx >= 0 && bx < BOARD_W) {
          this.board[by][bx] = v;
        }
      }
    }
  }

  moveLeft(){
    if (!this.running || !this.current) return;
    const p = { ...this.current, x: this.current.x - 1 };
    if (this.canPlace(p)) this.current = p;
  }
  moveRight(){
    if (!this.running || !this.current) return;
    const p = { ...this.current, x: this.current.x + 1 };
    if (this.canPlace(p)) this.current = p;
  }
  rotate(){
    if (!this.running || !this.current) return;
    const r = (this.current.r + 1) % 4;
    // simple kick attempts on X
    const kicks = [0, -1, 1, -2, 2];
    for (const k of kicks){
      const p = { ...this.current, r, x: this.current.x + k };
      if (this.canPlace(p)) { this.current = p; return; }
    }
  }

  tick(dtMs, gravityMs) {
    if (!this.running || !this.current) return;
    this._gravAccMs = (this._gravAccMs || 0) + dtMs;
    while (this._gravAccMs >= gravityMs) {
      this._gravAccMs -= gravityMs;
      this.stepDown();
    }
  }

  stepDown(){
    const p = { ...this.current, y: this.current.y + 1 };
    if (this.canPlace(p)) {
      this.current = p;
    } else {
      // lock piece
      this.mergeCurrent();
      // clear lines (natural -> add to score)
      const cleared = this.clearFullRows();
      if (cleared > 0) this.score += cleared;
      // next piece
      this.current = this.spawn();
    }
  }

  clearFullRows(){
    let removed = 0;
    for (let y = BOARD_H - 1; y >= 0; y--){
      if (this.board[y].every(v => v !== 0)) {
        this.board.splice(y,1);
        this.board.unshift(Array(BOARD_W).fill(0));
        removed++;
        y++; // re-check this index after unshift
      }
    }
    return removed;
  }

  // Donation effects (match your spec)
  applyEffect(effect){
    if (!effect) return 0;

    if (effect.type === 'swap_next') {
      const all = [0,1,2,3,4,5,6];
      const curNext = this.nextQueue[0];
      const candidates = all.filter(p => p !== curNext);
      this.nextQueue[0] = candidates[Math.floor(Math.random()*candidates.length)];
      return 0;
    }

    if (effect.type === 'clear_rows') {
      let removed = 0;
      for (let i=BOARD_H-1; i>=0 && removed<effect.count; ) {
        if (this.board[i].some(c=>c)) { this.board.splice(i,1); this.board.unshift(Array(BOARD_W).fill(0)); removed++; }
        else i--;
      }
      // per your rule: these DO NOT add to score
      return 0;
    }

    if (effect.type === 'half_rows') {
      const occupied = this.board.filter(r => r.some(c=>c)).length;
      const toRemove = Math.floor(occupied/2);
      let removed = 0;
      for (let i=BOARD_H-1; i>=0 && removed<toRemove; ) {
        if (this.board[i].some(c=>c)) { this.board.splice(i,1); this.board.unshift(Array(BOARD_W).fill(0)); removed++; }
        else i--;
      }
      // pink adds to score
      this.score += removed;
      return removed;
    }

    if (effect.type === 'full_reset') {
      const occupied = this.board.filter(r => r.some(c=>c)).length;
      this.board = Array.from({length: BOARD_H}, () => Array(BOARD_W).fill(0));
      this.score += occupied; // red adds to score
      // keep current piece workable (respawn cleanly)
      this.current = this.spawn();
      return occupied;
    }

    return 0;
  }
}
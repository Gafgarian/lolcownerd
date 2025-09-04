// assets/js/lib/config.js
export const IMG_BASE  = "assets/images";
export const OVERHEAD  = id => `${IMG_BASE}/cars/overhead/${id}.png`;
export const SIDE      = id => `${IMG_BASE}/cars/side/${id}-side.png`;
export const GRASS_TILE= `${IMG_BASE}/other/grassBg.png`;
export const CARS_JSON = "assets/config/cars.json";

// visual identity only; stats come from cars.json
export const TEAMS = [
  { id:'cafe',     name:'Cafe',     color:'#ffce9e', label:{ bg:'#3b2f2f', fg:'#ffce9e' } },
  { id:'reaper',   name:'Reapers',  color:'#76ff03', label:{ bg:'#2a2a2a', fg:'#76ff03' } },
  { id:'test',     name:'Test',     color:'#ffd600', label:{ bg:'#ffd600', fg:'#111' } },
  { id:'nerd',     name:'Nerds',    color:'#c2afff', label:{ bg:'#7a2b86', fg:'#c2afff' } },
  { id:'queens',   name:'Queens',   color:'#ff5aa5', label:{ bg:'#d4af37', fg:'#ff5aa5' } },
  { id:'live',     name:'Live',     color:'#1e88e5', label:{ bg:'#e53935', fg:'#1e88e5' } },
  { id:'shortbus', name:'ShortBus', color:'#9be7ff', label:{ bg:'#2e7d32', fg:'#9be7ff' } },
  { id:'rewind',   name:'Rewind',   color:'#ef5350', label:{ bg:'#111',    fg:'#ef5350' } },
  { id:'balls',    name:'Balls',    color:'#ff5aa5', label:{ bg:'#ff5aa5', fg:'#111' } },
  { id:'aussy',    name:'Aussy',    color:'#ffd180', label:{ bg:'#5a3d2b', fg:'#ffd180' } },
  { id:'chubby',   name:'Chubby',   color:'#ff5aa5', label:{ bg:'#1e88e5', fg:'#ff5aa5' } },
  { id:'nuts',     name:'Nuts',     color:'#ffcc80', label:{ bg:'#8e24aa', fg:'#ffcc80' } },
];

export const SPRITE_HEADING_OFFSET = Math.PI / 2;
export const STRAIGHT_THRESH = 0.0010;
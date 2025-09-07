/* LCU Garages – roll-up animation + reflection
   Side panel shows a two-column grid of stats read from assets/config/cars.json
   (SPD, ACC, HAN, PIT, END, RSK) beneath the overhead car view.
*/

const SHOWS = [
  { slug:'cafe',    name:'Cafe',    accent:'#ff3b4e' },
  { slug:'reaper',  name:'Reapers', accent:'#7affc2' },
  { slug:'nuts',    name:'Nuts',    accent:'#c38cff' },
  { slug:'test',    name:'Test',    accent:'#ffe14a' },

  { slug:'queens',  name:'Queens',  accent:'#ff69c7' },
  { slug:'live',    name:'Live',    accent:'#28a6ff' },
  { slug:'shortbus',name:'ShortBus',accent:'#00ce7a' },
  { slug:'rewind',  name:'Rewind',  accent:'#ff4343' },
  
  { slug:'balls',   name:'Balls',   accent:'#ff7bb3' },
  { slug:'aussy',   name:'Aussy',   accent:'#ff9c33' },
  { slug:'nerd',    name:'Nerds',   accent:'#32c1ff' },  
  { slug:'chubby',  name:'Chubby',  accent:'#ff7ad8' },
];

const CROWNS = [{slug:'lock'},{slug:'lock'}];

const $ = s => document.querySelector(s);
const elShowGrid   = $('#showGrid');
const elCrownGrid  = $('#crownGrid');

const elModal      = $('#garageModal');
const elBackdrop   = $('#modalBackdrop');
const elClose      = $('#modalClose');
const elBgImg      = $('#bgImg');
const elCarSide    = $('#carSide');
const elCarRef     = $('#carRef');
const elCarTop     = $('#carTop');
const elStats      = $('#statsPanel');
const elStatsClose = $('#statsClose');
const elToggle     = $('#statsToggle');

const elValSPD     = $('#valSPD');
const elValACC     = $('#valACC');
const elValHAN     = $('#valHAN');
const elValPIT     = $('#valPIT');
const elValEND     = $('#valEND');
const elValRSK     = $('#valRSK');

const elAddUp      = $('#btnAddUp');

let activeSlat = null;
let activeDoor = null;
let activeCard = null;
let endTimer   = null;

/* --------- Load cars.json (shared stats) ---------- */
let __carsCfg = null;
async function loadCarsCfg() {
  if (!__carsCfg) {
    const res = await fetch('./assets/config/cars.json', { cache: 'no-cache' });
    __carsCfg = await res.json();
  }
  return __carsCfg;
}

// UI slug → cars.json key
const TEAM_ALIAS = {
  cafe: 'cafe',
  reapers: 'reaper', reaper: 'reaper',
  test: 'test',
  nerds: 'nerd', nerd: 'nerd',
  queens: 'queens',
  live: 'live',
  shortbus: 'shortbus',
  rewind: 'rewind',
  balls: 'balls',
  aussy: 'aussy', aussie: 'aussy',
  nuts: 'nuts',
  chubby: 'chubby'
};
const cfgKeyFor = slug => TEAM_ALIAS[slug?.toLowerCase?.()] || slug?.toLowerCase?.();

const fmt = v => (v == null ? '—' : (Number(v) % 1 === 0 ? String(Number(v)) : Number(v).toFixed(1)));

async function applyBaseStatsFromConfig(slug) {
  try {
    const cfg = await loadCarsCfg();
    const rec = cfg?.teams?.[cfgKeyFor(slug)];
    // allow both flat and nested under "teams"
    const data = rec || cfg?.[cfgKeyFor(slug)] || {};

    elValSPD.textContent = fmt(data.SPD);
    elValACC.textContent = fmt(data.ACC);
    elValHAN.textContent = fmt(data.HAN);
    elValPIT.textContent = fmt(data.PIT);
    elValEND.textContent = fmt(data.END);
    elValRSK.textContent = fmt(data.RSK);
  } catch (err) {
    console.warn('[garages] could not apply base stats:', err);
    elValSPD.textContent = elValACC.textContent = elValHAN.textContent =
    elValPIT.textContent = elValEND.textContent = elValRSK.textContent = '—';
  }
}

/* ---------- build cards ---------- */
function doorCard({slug,name,accent}, locked=false){
  const card = document.createElement('div');
  card.className = 'garage-card';
  card.style.setProperty('--accent', accent || '#4dd0ff');

  const door = document.createElement('button');
  door.className = 'door' + (locked ? ' locked' : '');
  door.setAttribute('aria-label', (name||'Locked') + ' garage door');

  const preview = document.createElement('span');
  preview.className = 'door-preview';
  preview.style.backgroundImage = `url(assets/images/garages/${locked?'lock':slug}.png)`;

  const slat = document.createElement('span');
  slat.className = 'door-slat';
  slat.style.backgroundImage = `url(assets/images/garages/${locked?'door-lock':`door-${slug}`}.png)`;

  door.appendChild(preview);
  door.appendChild(slat);
  card.appendChild(door);

  if (locked){
    const tag = document.createElement('div');
    tag.className = 'badge';
    tag.textContent = 'Coming Soon';
    card.appendChild(tag);
    door.addEventListener('click', () => {
      card.classList.add('shake');
      setTimeout(()=>card.classList.remove('shake'),520);
    });
  } else {
    door.addEventListener('click', (e) => {
      e.preventDefault();
      startRollUp(card, door, slat, {slug,name,accent});
    });
  }

  return card;
}

function mount(){
  SHOWS.forEach(meta => elShowGrid.appendChild(doorCard(meta)));
  CROWNS.forEach(meta => elCrownGrid.appendChild(doorCard(meta, true)));
  // warm the cache so stats appear instantly on first open
  loadCarsCfg().catch(()=>{});
}

/* ---------- roll-up → modal ---------- */
function startRollUp(card, door, slat, meta){
  if (door.classList.contains('opening')) return;

  activeSlat = slat;
  activeDoor = door;
  activeCard = card;

  door.classList.add('opening');
  slat.style.transitionDuration = '.6s';
  slat.style.transitionTimingFunction = 'cubic-bezier(.2,.85,.3,1)';

  const onEnd = (ev) => {
    if (ev && ev.propertyName !== 'transform') return;
    clearTimeout(endTimer);
    slat.removeEventListener('transitionend', onEnd);
    setTimeout(() => openModal(meta), 60);
  };

  slat.addEventListener('transitionend', onEnd, {once:false});
  requestAnimationFrame(() => {
    void slat.offsetWidth;
    slat.style.transform = 'translateY(-100%)';
  });
  endTimer = setTimeout(() => onEnd({propertyName:'transform'}), 2000);
}

function resetDoor(){
  if (!activeSlat || !activeDoor) return;
  activeSlat.style.transform = '';
  activeSlat.style.transitionDuration = '';
  activeSlat.style.transitionTimingFunction = '';
  activeDoor.classList.remove('opening');
  activeSlat = activeDoor = activeCard = null;
}

/* ---------- modal ---------- */
async function openModal({slug,name,accent}){
  document.documentElement.style.setProperty('--accent', accent || '#4dd0ff');

  elBgImg.src   = `assets/images/garages/${slug}.png`;
  const sideSrc = `assets/images/cars/side/${slug}-side.png`;
  const topSrc  = `assets/images/cars/overhead/${slug}.png`;

  elCarSide.src = sideSrc;
  elCarRef.src  = sideSrc;
  elCarTop.src  = topSrc;

  // pull base stats from config and render under overhead
  for (const el of [elValSPD, elValACC, elValHAN, elValPIT, elValEND, elValRSK]) el.textContent = '…';
  await applyBaseStatsFromConfig(slug);

  elStats.classList.remove('open'); // collapsed by default
  elModal.setAttribute('aria-hidden','false');
}

function closeModal(){
  elModal.setAttribute('aria-hidden','true');
  resetDoor();
}

/* ---------- stats slide-over ---------- */
function togglePanel(force){
  if (typeof force === 'boolean') elStats.classList.toggle('open', force);
  else elStats.classList.toggle('open');
}
elToggle.addEventListener('click', (e)=>{ e.stopPropagation(); togglePanel(true); });
elStatsClose.addEventListener('click', (e)=>{ e.stopPropagation(); togglePanel(false); });
$('#scene').addEventListener('click', ()=>{ if (elStats.classList.contains('open')) togglePanel(false); });

/* Close modal + Esc */
elClose.addEventListener('click', closeModal);
elBackdrop.addEventListener('click', closeModal);
document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape' && elModal.getAttribute('aria-hidden') === 'false'){
    if (elStats.classList.contains('open')) togglePanel(false);
    else closeModal();
  }
});

/* Upgrades demo (UI only; starts from cars.json values) */
elAddUp.addEventListener('click', ()=>{
  const bump = () => (Math.random()*0.4 + 0.05);
  elValSPD.textContent = fmt(parseFloat(elValSPD.textContent) + bump());
  elValACC.textContent = fmt(parseFloat(elValACC.textContent) + bump());
  elValHAN.textContent = fmt(parseFloat(elValHAN.textContent) + bump());
  elValPIT.textContent = fmt(parseFloat(elValPIT.textContent) + bump());
  elValEND.textContent = fmt(parseFloat(elValEND.textContent) + bump());
  // RSK: lower is safer; let upgrades *reduce* risk slightly
  elValRSK.textContent = fmt(Math.max(0, parseFloat(elValRSK.textContent) - (Math.random()*0.2 + 0.05)));
});

/* init */
mount();

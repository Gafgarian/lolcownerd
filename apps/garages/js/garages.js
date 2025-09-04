/* LCU Garages – robust roll-up on click + reflection */

const SHOWS = [
  { slug:'cafe',    name:'Cafe',    accent:'#ff3b4e' },
  { slug:'reaper',  name:'Reapers', accent:'#7affc2' },
  { slug:'nuts',   name:'Nuts',   accent:'#c38cff' },
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
const elValSpeed   = $('#valSpeed');
const elValHandling= $('#valHandling');
const elValPit     = $('#valPit');
const elAddUp      = $('#btnAddUp');

let activeSlat = null;
let activeDoor = null;
let activeCard = null;
let endTimer   = null;

// ---- Stats config (cars.json) wiring ----
let __carsCfg = null;
async function loadCarsCfg() {
  if (!__carsCfg) {
    const res = await fetch('assets/config/cars.json', { cache: 'no-cache' });
    __carsCfg = await res.json();
  }
  return __carsCfg;
}

// map UI slugs -> config keys
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

function cfgKeyFor(slug) {
  return TEAM_ALIAS[slug?.toLowerCase?.()] || slug?.toLowerCase?.();
}

// fills the 3 visible stats from cars.json
async function applyBaseStatsFromConfig(slug) {
  try {
    const cfg = await loadCarsCfg();
    const key = cfgKeyFor(slug);
    const rec = cfg?.teams?.[key];
    if (!rec) return;

    // Keep the one-decimal look used in the UI
    const to1 = v => Number(v).toFixed(1);

    const elSpeed    = document.getElementById('valSpeed');
    const elHandling = document.getElementById('valHandling');
    const elPit      = document.getElementById('valPit');

    if (elSpeed)    elSpeed.textContent    = to1(rec.SPD);
    if (elHandling) elHandling.textContent = to1(rec.HAN);
    if (elPit)      elPit.textContent      = to1(rec.PIT);
  } catch (e) {
    console.warn('[garages] failed to load cars.json stats:', e);
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
}

/* ---------- roll-up → modal (robust) ---------- */
/**
 * Hover uses CSS transform for peek.
 * Click uses INLINE transform (translateY(-100%)) so it wins over :hover.
 * We also add `.opening` to disable hover pointer events during the roll.
 */
function startRollUp(card, door, slat, meta){
  if (door.classList.contains('opening')) return;

  activeSlat = slat;
  activeDoor = door;
  activeCard = card;

  door.classList.add('opening'); // disables hover
  // ensure the base transition is the quicker peek; then we bump duration for the roll
  slat.style.transitionDuration = '.6s';
  slat.style.transitionTimingFunction = 'cubic-bezier(.2,.85,.3,1)';

  const onEnd = (ev) => {
    if (ev && ev.propertyName !== 'transform') return;
    clearTimeout(endTimer);
    slat.removeEventListener('transitionend', onEnd);
    // allow brief perception of the open door
    setTimeout(() => openModal(meta), 60);
  };

  // listen before setting transform
  slat.addEventListener('transitionend', onEnd, {once:false});

  // force layout then trigger roll
  requestAnimationFrame(() => {
    void slat.offsetWidth;             // reflow
    slat.style.transform = 'translateY(-100%)';
  });

  // absolute safety fallback
  endTimer = setTimeout(() => onEnd({propertyName:'transform'}), 2000);
}

function resetDoor(){
  if (!activeSlat || !activeDoor) return;
  // reset inline transforms so hover works again next time
  activeSlat.style.transform = '';
  activeSlat.style.transitionDuration = '';
  activeSlat.style.transitionTimingFunction = '';
  activeDoor.classList.remove('opening');
  activeSlat = activeDoor = activeCard = null;
}

/* ---------- modal ---------- */
function openModal({slug,name,accent}){
  document.documentElement.style.setProperty('--accent', accent || '#4dd0ff');

  elBgImg.src   = `assets/images/garages/${slug}.png`;
  const sideSrc = `assets/images/cars/side/${slug}-side.png`;
  const topSrc  = `assets/images/cars/overhead/${slug}.png`;

  elCarSide.src = sideSrc;
  elCarRef.src  = sideSrc;        // reflection mirrors side image
  elCarTop.src  = topSrc;

  // example stats
  elValSpeed.textContent    = (7 + Math.random()*1.2).toFixed(1);
  elValHandling.textContent = (7 + Math.random()*1.2).toFixed(1);
  elValPit.textContent      = (7 + Math.random()*1.2).toFixed(1);

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

// click anywhere on the bay to close the panel
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

/* Upgrades demo */
elAddUp.addEventListener('click', ()=>{
  const bump = () => (Math.random()*0.4 + 0.05);
  elValSpeed.textContent    = (parseFloat(elValSpeed.textContent) + bump()).toFixed(1);
  elValHandling.textContent = (parseFloat(elValHandling.textContent) + bump()).toFixed(1);
  elValPit.textContent      = (parseFloat(elValPit.textContent) + bump()).toFixed(1);
});

/* init */
mount();
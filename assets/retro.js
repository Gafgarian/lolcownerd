// Focus the hidden input so mobile keyboards show up
const input = document.getElementById('secretInput');
const echo  = document.getElementById('echo');
const deny  = document.getElementById('deny');
const boot  = document.getElementById('boot');
const bar   = document.getElementById('barFill');
const bootMsg = document.getElementById('bootMsg');
const screen = document.getElementById('screen');

function focusInput(){ input.focus({preventScroll:true}); }
window.addEventListener('load', focusInput);
window.addEventListener('pointerdown', focusInput);
window.addEventListener('keydown', () => { if(document.activeElement !== input) focusInput(); });

/** Passcode for TODAY: NDF + MMDDYYYY (case-insensitive check) */
function todayCodeUpper(){
  const d = new Date();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const yyyy = String(d.getFullYear());
  return `NDF${mm}${dd}${yyyy}`.toUpperCase();
}

/** Create a session that lasts until 23:59:59 local time today */
function writeSession(){
  const d = new Date();
  d.setHours(23,59,59,999);
  const payload = {
    token: todayCodeUpper(),   // we store today's token
    exp: d.getTime()
  };
  localStorage.setItem('ndf_session', JSON.stringify(payload));
}

/** Quick validation helper (not used here, but handy) */
function hasValidSession(){
  try{
    const raw = localStorage.getItem('ndf_session');
    const data = raw && JSON.parse(raw);
    const valid = data && data.token && data.token.toUpperCase() === todayCodeUpper() && (!data.exp || Date.now() < data.exp);
    return !!valid;
  }catch(_){ return false; }
}

const PROMPT = "> ";
let buffer = "";

function clearDeny(){
  deny.classList.add('hidden');
  screen.classList.remove('shake');
}
function showDeny(){
  deny.classList.remove('hidden');
  screen.classList.add('shake');
  setTimeout(clearDeny, 1100);
}
function resetEcho(){
  buffer = "";
  echo.textContent = "";
  input.value = "";
}

// Echo * for any printable, handle backspace, submit on Enter
input.addEventListener('keydown', (e)=>{
  clearDeny();

  if(e.key === 'Enter'){
    e.preventDefault();
    validate(buffer);
    return;
  }
  if(e.key === 'Backspace'){
    e.preventDefault();
    if(buffer.length){
      buffer = buffer.slice(0, -1);
      echo.textContent = echo.textContent.slice(0, -1);
    }
    return;
  }
  if(e.key.length === 1){           // printable char
    e.preventDefault();
    buffer += e.key;
    echo.textContent += '*';
  }
});

function validate(typed){
  const need = todayCodeUpper();              // expected (uppercase)
  const got  = String(typed || "").toUpperCase().trim();  // case-insensitive
  if(got === need){
    writeSession();
    bootSequence();
  }else{
    showDeny();
    resetEcho();
  }
}

// Fake boot/progress, then go to main app
function bootSequence(){
  boot.classList.remove('hidden');
  let p = 0;
  const msgs = [
    "Mounting subsystems…",
    "Decrypting sectors…",
    "Warming shaders…",
    "Loading tactical overlays…",
    "Syncing assets…"
  ];
  const timer = setInterval(()=>{
    p = Math.min(100, p + Math.random()*9 + 4);
    bar.style.width = p.toFixed(0) + "%";
    bootMsg.textContent = msgs[Math.floor(p/20)] || "Finalizing…";
    if(p >= 100){
      clearInterval(timer);
      window.location.href = "app.html";
    }
  }, 120);
}

/* Tiny aesthetic: subtle shake on deny */
const style = document.createElement('style');
style.textContent = `
@keyframes shake {
  0% { transform: translateX(0) }
  20% { transform: translateX(-2px) }
  40% { transform: translateX(2px) }
  60% { transform: translateX(-2px) }
  80% { transform: translateX(2px) }
  100% { transform: translateX(0) }
}
.screen.shake { animation: shake .5s ease }
`;
document.head.appendChild(style);
// Admin controls via WS subprotocol (ADMIN_TOKEN). viewer.js already opened WS.
const ADMIN_TOKEN = window.ADMIN_TOKEN || 'changeme';

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsAdmin = new WebSocket(`${wsProto}://${location.host}/`, ADMIN_TOKEN);

function send(name, payload={}){
  wsAdmin.readyState === WebSocket.OPEN
    ? wsAdmin.send(JSON.stringify({ type:'cmd', name, ...payload }))
    : console.warn('Admin WS not open yet');
}

document.getElementById('startBtn')?.addEventListener('click', ()=> send('start'));
document.getElementById('pauseBtn')?.addEventListener('click', ()=> send('pause'));
document.getElementById('finishBtn')?.addEventListener('click', ()=> send('finish'));
document.getElementById('boostBtn')?.addEventListener('click', ()=>{
  const teamId = document.getElementById('kartSelect')?.value;
  if (teamId) send('boost', { teamId, delta: +0.06 });
});

// reflect connection status
const st = document.getElementById('adminStatus');
wsAdmin.onopen  = ()=> st && (st.textContent = 'Admin link ready');
wsAdmin.onclose = ()=> st && (st.textContent = 'Admin link closed');
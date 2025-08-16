(function(){
  try{
    const raw = localStorage.getItem('ndf_session');
    const data = raw && JSON.parse(raw);
    const d = new Date();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const yyyy = String(d.getFullYear());
    const expected = `NDF${mm}${dd}${yyyy}`.toUpperCase();

    const valid = data && data.token && String(data.token).toUpperCase() === expected && (!data.exp || Date.now() < data.exp);
    if(!valid){
      // If someone bookmarked a deep page, always force auth first
      window.location.replace('index.html');
    }
  }catch(_e){
    window.location.replace('index.html');
  }
})();
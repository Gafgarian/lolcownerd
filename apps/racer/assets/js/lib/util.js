// assets/js/lib/util.js
export const TAU = Math.PI * 2;
export const clamp = (v,min,max)=>v<min?min:v>max?max:v;
export const lerp  = (a,b,t)=>a+(b-a)*t;

export function loadImage(src){
  return new Promise((res, rej) => {
    const img=new Image();
    img.onload=()=>res(img);
    img.onerror=()=>rej(new Error(`Failed to load image: ${src}`));
    img.src=src;
  });
}

export const fmtCs = ms => {
  const s  = Math.floor(ms/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};
export const fmtLap = ms => {
  const m  = Math.floor(ms/60000);
  const s  = Math.floor((ms%60000)/1000);
  const cs = Math.floor((ms%1000)/10);
  return `${m}:${String(s).padStart(2,'0')}:${String(cs).padStart(2,'0')}`;
};
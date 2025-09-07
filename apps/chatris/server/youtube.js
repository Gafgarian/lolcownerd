// server/youtube.js
export function extractYouTubeVideoId(url) {
  try {
    const u = new URL(url.trim());
    const v = u.searchParams.get('v'); if (v) return v;
    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/')[1]; if (id) return id;
    }
    const live  = u.pathname.match(/\/live\/([A-Za-z0-9_-]{6,})/);  if (live)  return live[1];
    const embed = u.pathname.match(/\/embed\/([A-Za-z0-9_-]{6,})/); if (embed) return embed[1];
    return null;
  } catch (e) { return null; }
}

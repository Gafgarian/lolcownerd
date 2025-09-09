export function extractVideoId(input) {
  if (!input) return null;
  const s = String(input).trim();

  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;             // short id
  const m1 = s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = s.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m2) return m2[1];

  const u = safeURL(s);
  if (u?.searchParams?.get('v')) {
    const vid = u.searchParams.get('v');
    if (/^[A-Za-z0-9_-]{11}$/.test(vid)) return vid;
  }
  return null;
}
function safeURL(x) { try { return new URL(x); } catch { return null; } }
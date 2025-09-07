import { supa } from './supabase.js';

export async function resolveStreamFromVideoId(videoId) {
  const { data, error } = await supa
    .from('streams')
    .select('id, title, max_viewers, created_at')
    .eq('video_id', videoId)
    .single();  // video_id is unique

  if (error) return null;
  const row = data;
  return {
    stream_id: row.id,
    title: row.title || null,
    max_viewers: row.max_viewers ?? null,
    created_at: row.created_at
  };
}

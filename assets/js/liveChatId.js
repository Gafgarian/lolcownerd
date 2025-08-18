const { google } = require('googleapis');

async function getActiveLiveChatId(youtube, { channelId }) {
  // Find the channel’s currently live VIDEO (if any)
  const search = await youtube.search.list({
    part: 'id',
    channelId,
    eventType: 'live',
    type: 'video',
    maxResults: 1
  });
  const videoId = search.data.items?.[0]?.id?.videoId;
  if (!videoId) return null;

  // Pull its live chat id
  const vids = await youtube.videos.list({
    part: 'liveStreamingDetails',
    id: videoId
  });
  return vids.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

module.exports = { getActiveLiveChatId };
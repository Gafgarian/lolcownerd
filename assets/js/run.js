/**
 * Run after auth: node assets/js/run.js
 * Requires:
 *   - assets/js/oauth.json  (client secrets)
 *   - assets/js/token.json  (created by auth.js)
 *
 * ENV:
 *   YT_CHANNEL_ID  (defaults to a test channel if not set)
 */
// Polyfill fetch/Headers for Node < 18
const fetch = require("node-fetch");
global.fetch = fetch;
global.Headers = fetch.Headers;
global.Request = fetch.Request;
global.Response = fetch.Response;

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDS_PATH = path.join(__dirname, "oauth.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

// Set your channel (env wins)
const CHANNEL_ID = process.env.YT_CHANNEL_ID || "UC7WRbUmD6W-dCP_UlDbhI4A";

function readJSON(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }

async function getOAuthClient() {
  if (!fs.existsSync(CREDS_PATH)) throw new Error(`Missing ${CREDS_PATH}`);
  if (!fs.existsSync(TOKEN_PATH)) throw new Error(`Missing ${TOKEN_PATH}. Run: node assets/js/auth.js`);

  const { installed, web } = readJSON(CREDS_PATH);
  const cfg = installed || web;

  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(readJSON(TOKEN_PATH));

  // persist refreshed tokens automatically
  oauth2.on("tokens", (t) => {
    const cur = fs.existsSync(TOKEN_PATH) ? readJSON(TOKEN_PATH) : {};
    fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...cur, ...t }, null, 2));
  });
  return oauth2;
}

/** Find active liveChatId for channel */
async function getActiveLiveChatId(youtube, channelId) {
  const search = await youtube.search.list({
    part: ["id"],
    channelId,
    eventType: "live",
    type: ["video"],
    maxResults: 1
  });
  const videoId = search.data.items?.[0]?.id?.videoId;
  if (!videoId) return null;

  const videos = await youtube.videos.list({
    part: ["liveStreamingDetails"],
    id: [videoId]
  });
  return videos.data.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
}

/** Normalize interesting live chat events (SC, Stickers, gifting, members) */
function parseLiveChatItem(item) {
  const t = item.snippet.type;
  const a = item.authorDetails;
  const s = item.snippet;

  if (t === "superChatEvent" && s.superChatDetails) {
    const d = s.superChatDetails;
    return { kind: "SUPER_CHAT", user: a.displayName, message: d.userComment || "",
             amount: Number(d.amountMicros)/1e6, currency: d.currency };
  }
  if (t === "superStickerEvent" && s.superStickerDetails) {
    const d = s.superStickerDetails;
    return { kind: "SUPER_STICKER", user: a.displayName,
             amount: Number(d.amountMicros)/1e6, currency: d.currency };
  }
  if (t === "membershipGiftingEvent") {
    return { kind: "GIFTING", user: a.displayName,
             count: s.membershipGiftingDetails?.giftMembershipsCount || 1 };
  }
  if (t === "giftMembershipReceivedEvent") {
    return { kind: "GIFT_RECEIVED", user: a.displayName };
  }
  if (t === "newSponsor") {
    return { kind: "NEW_MEMBER", user: a.displayName };
  }
  if (t === "memberMilestoneChatEvent") {
    return { kind: "MEMBER_MILESTONE", user: a.displayName,
             message: s.memberMilestoneChatDetails?.userComment || "" };
  }
  return null;
}

/** Long-poll the live chat */
async function pollLiveChat(youtube, liveChatId, onEvents) {
  let pageToken;
  while (true) {
    const resp = await youtube.liveChatMessages.list({
      part: ["snippet", "authorDetails"],
      liveChatId,
      pageToken,
      maxResults: 200
    });

    const items = resp.data.items || [];
    const events = items.map(parseLiveChatItem).filter(Boolean);
    if (events.length) onEvents(events);

    pageToken = resp.data.nextPageToken;
    const wait = resp.data.pollingIntervalMillis || 2000;
    await new Promise(r => setTimeout(r, wait));
  }
}

async function main() {
  const auth = await getOAuthClient();
  const youtube = google.youtube({ version: "v3", auth });

  const liveChatId = await getActiveLiveChatId(youtube, CHANNEL_ID);
  if (!liveChatId) {
    console.log("No active livestream found for this channel. Start a live and rerun.");
    return;
  }
  console.log("liveChatId:", liveChatId);
  console.log("Listening for Super Chats / Stickers / Membership events…\n");

  await pollLiveChat(youtube, liveChatId, (events) => {
    for (const e of events) {
      if (e.kind === "SUPER_CHAT") {
        console.log(`💥 SUPER CHAT — ${e.user} • ${e.amount} ${e.currency} • ${e.message}`);
      } else if (e.kind === "SUPER_STICKER") {
        console.log(`💥 SUPER STICKER — ${e.user} • ${e.amount} ${e.currency}`);
      } else if (e.kind === "GIFTING") {
        console.log(`🎁 GIFTED MEMBERSHIPS — ${e.user} • ${e.count}`);
      } else if (e.kind === "GIFT_RECEIVED") {
        console.log(`🙌 GIFT RECEIVED — ${e.user}`);
      } else if (e.kind === "NEW_MEMBER") {
        console.log(`🎉 NEW MEMBER — ${e.user}`);
      } else if (e.kind === "MEMBER_MILESTONE") {
        console.log(`⏳ MILESTONE — ${e.user} • ${e.message}`);
      }
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
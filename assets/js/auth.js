/**
 * One-time OAuth: node assets/js/auth.js
 * - Reads client secrets from assets/js/oauth.json
 * - Opens a tiny local server on http://localhost:8888/oauth2callback
 * - Prints an auth URL; visit it, grant access, Google redirects back
 * - We exchange the code -> tokens and save assets/js/token.json
 */
// Polyfill fetch/Headers for Node < 18
const fetch = require("node-fetch");
global.fetch = fetch;
global.Headers = fetch.Headers;
global.Request = fetch.Request;
global.Response = fetch.Response;

const http = require("http");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { URL } = require("url");

const PORT = 8888;
const CALLBACK_PATH = "/oauth2callback";
const CREDS_PATH = path.join(__dirname, "oauth.json");
const TOKEN_PATH = path.join(__dirname, "token.json");

function readJSON(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error(`Missing ${CREDS_PATH}. Download OAuth client JSON and save it there.`);
    process.exit(1);
  }
  const { installed, web } = readJSON(CREDS_PATH);
  const cfg = installed || web;
  const redirectUri = `http://localhost:${PORT}${CALLBACK_PATH}`;

  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret, redirectUri);

  const scopes = [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ];

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: scopes,
    prompt: "consent",
  });

  console.log("Authorize this app by visiting this URL:\n");
  console.log(authUrl);
  console.log("\nWaiting for Google to redirect back to:", redirectUri);

  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith(CALLBACK_PATH)) {
      res.statusCode = 404; res.end("Not found"); return;
    }
    try {
      const u = new URL(req.url, `http://localhost:${PORT}`);
      const code = u.searchParams.get("code");
      if (!code) { res.statusCode = 400; res.end("Missing code"); return; }

      const { tokens } = await oauth2.getToken(code);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("Authentication successful. You can close this tab. Tokens saved ✅");

      console.log(`\nTokens saved to ${TOKEN_PATH}`);
      server.close();
    } catch (err) {
      console.error("OAuth error:", err);
      res.statusCode = 500; res.end("Auth error. See terminal.");
    }
  });

  server.listen(PORT, () => {
    console.log(`\nListening on http://localhost:${PORT} for the OAuth callback...`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
// browser-sync.config.js
module.exports = {
  proxy: "http://localhost:3000",  // your Express server
  ws: true,                        // proxy WebSockets (/ ?role=view|admin)
  port: 5173,                      // dev URL
  open: false,
  ui: false,
  ghostMode: false,
  files: [
    // Static & client assets to trigger reload
    "public/**/*.*",
    "assets/**/*.*",
    "sim-core/**/*.*",
    "apps/web/**/*.*"
    // If you emit bundles elsewhere, include them here too.
    // "dist/**/*.*"
  ],
  reloadDelay: 150,    // wait a beat for server restarts
  reloadDebounce: 150  // coalesce rapid file writes
};
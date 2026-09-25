// ══════════════════════════════════════════════════════════════════════════════
// Claude Web Bridge – Extension Configuration
// ══════════════════════════════════════════════════════════════════════════════
// Edit these values to point to your cloud server.
// After changing, reload the extension at chrome://extensions.

const CONFIG = {
  // ── Server URL ───────────────────────────────────────────────────────────
  // For local:  "ws://localhost:8080/ws"
  // For cloud:  "wss://your-app-name.fly.dev/ws"
  //             "wss://your-app-name.up.railway.app/ws"
  //             "wss://your-app-name.onrender.com/ws"
  SERVER_WS_URL: "ws://localhost:8080/ws",

  // ── WebSocket Secret ─────────────────────────────────────────────────────
  // Must match the WS_SECRET env var on your cloud server.
  // Leave empty for local development (no auth).
  WS_SECRET: "",
};

// ── DO NOT EDIT BELOW THIS LINE ────────────────────────────────────────────
// Export for use by background.js
if (typeof globalThis !== "undefined") {
  globalThis.BRIDGE_CONFIG = CONFIG;
}

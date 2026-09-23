// ── WebSocket connection to local bridge server ──────────────────────────────
// With multi-layer keepalive to prevent MV3 service worker termination.

let ws = null;
const WS_URL = "ws://localhost:8080/ws";
const RECONNECT_INTERVAL = 3000;
const KEEPALIVE_ALARM = "ws-keepalive";
const KEEPALIVE_INTERVAL_MS = 20_000; // 20s ping cycle (well under Chrome's 30s kill)

// ── Layer 1: chrome.alarms keepalive ─────────────────────────────────────────
// Chrome alarms periodically wake the service worker even if it was terminated.
// Minimum alarm period is 0.5 minutes, so we use a workaround for sub-minute intervals.

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); // ~30s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    // If the worker woke up from termination, ws will be null → reconnect
    if (!ws || ws.readyState > 1) {
      console.log("[Bridge] Alarm wakeup – reconnecting WebSocket");
      connectWebSocket();
    }
  }
});

// ── Layer 2: Content-script port keepalive ───────────────────────────────────
// A long-lived port from the content script keeps the service worker alive
// as long as the claude.ai tab is open.

let keepalivePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    keepalivePorts.add(port);
    console.log("[Bridge] Keepalive port connected");

    port.onDisconnect.addListener(() => {
      keepalivePorts.delete(port);
      console.log("[Bridge] Keepalive port disconnected");
    });

    // Respond to ping messages to keep the port active
    port.onMessage.addListener((msg) => {
      if (msg.type === "ping") {
        port.postMessage({ type: "pong" });
      }
    });
  }
});

// ── Layer 3: WebSocket ping to server ────────────────────────────────────────
// Sends periodic application-level pings so the server knows we're alive,
// and the message event resets Chrome's service worker idle timer.

let pingInterval = null;

function startPingInterval() {
  stopPingInterval();
  pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, KEEPALIVE_INTERVAL_MS);
}

function stopPingInterval() {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
}

// ── WebSocket connection ─────────────────────────────────────────────────────

function connectWebSocket() {
  if (ws && ws.readyState <= 1) return; // CONNECTING or OPEN

  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    console.log("[Bridge] ✓ Connected to server");
    startPingInterval();
  });

  ws.addEventListener("message", async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      console.error("[Bridge] Malformed server message:", event.data);
      return;
    }

    // Ignore pong responses from server
    if (msg.type === "pong") return;

    if (msg.action === "SEND_PROMPT") {
      console.log(`[Bridge] Received prompt request: ${msg.id}`);
      await relayToClaudeTab(msg.id, msg.prompt);
    }
  });

  ws.addEventListener("close", () => {
    console.log("[Bridge] Disconnected – retrying in 3s…");
    ws = null;
    stopPingInterval();
    setTimeout(connectWebSocket, RECONNECT_INTERVAL);
  });

  ws.addEventListener("error", (err) => {
    console.error("[Bridge] WebSocket error:", err);
    ws.close();
  });
}

// ── Relay prompt to the active claude.ai tab ─────────────────────────────────

async function relayToClaudeTab(id, prompt, isRetry = false) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });

    if (tabs.length === 0) {
      console.error("[Bridge] No claude.ai tab found");
      sendToServer({ id, response: "[ERROR] No claude.ai tab is open." });
      return;
    }

    // Prefer the active tab; fall back to the first match
    const target = tabs.find((t) => t.active) || tabs[0];

    chrome.tabs.sendMessage(
      target.id,
      { action: "INJECT_PROMPT", id, prompt },
      async (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[Bridge] Content script not reachable:",
            chrome.runtime.lastError.message
          );

          if (!isRetry) {
            // Auto-inject the content script and retry once
            console.log("[Bridge] Auto-injecting content.js into tab", target.id);
            try {
              await chrome.scripting.executeScript({
                target: { tabId: target.id },
                files: ["content.js"],
              });
              // Wait for the script to initialize
              await new Promise((r) => setTimeout(r, 500));
              console.log("[Bridge] Retrying message after injection…");
              relayToClaudeTab(id, prompt, true);
            } catch (injectErr) {
              console.error("[Bridge] Injection failed:", injectErr);
              sendToServer({
                id,
                response: `[ERROR] Failed to inject content script: ${injectErr.message}`,
              });
            }
          } else {
            sendToServer({
              id,
              response: `[ERROR] Content script unreachable even after injection. Please refresh the claude.ai tab.`,
            });
          }
        }
      }
    );
  } catch (err) {
    console.error("[Bridge] Tab query error:", err);
    sendToServer({ id, response: `[ERROR] ${err.message}` });
  }
}

// ── Receive OUTPUT_READY from content script ─────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.action === "OUTPUT_READY") {
    console.log(`[Bridge] Response ready for ${msg.id}`);
    sendToServer({ id: msg.id, response: msg.text });
  }
});

// ── Send message to server via WebSocket ─────────────────────────────────────

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.error("[Bridge] Cannot send – WebSocket not connected");
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

connectWebSocket();

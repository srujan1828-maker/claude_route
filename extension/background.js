// ── WebSocket connection to local bridge server ──────────────────────────────
// With multi-layer keepalive + file upload/download support.

let ws = null;
const WS_URL = "ws://localhost:8080/ws";
const RECONNECT_INTERVAL = 3000;
const KEEPALIVE_ALARM = "ws-keepalive";
const KEEPALIVE_INTERVAL_MS = 20_000;

// ── Layer 1: chrome.alarms keepalive ─────────────────────────────────────────
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!ws || ws.readyState > 1) {
      console.log("[Bridge] Alarm wakeup – reconnecting WebSocket");
      connectWebSocket();
    }
  }
});

// ── Layer 2: Content-script port keepalive ───────────────────────────────────
let keepalivePorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    keepalivePorts.add(port);
    console.log("[Bridge] Keepalive port connected");
    port.onDisconnect.addListener(() => {
      keepalivePorts.delete(port);
      console.log("[Bridge] Keepalive port disconnected");
    });
    port.onMessage.addListener((msg) => {
      if (msg.type === "ping") port.postMessage({ type: "pong" });
    });
  }
});

// ── Layer 3: WebSocket ping ──────────────────────────────────────────────────
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
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
}

// ── WebSocket connection ─────────────────────────────────────────────────────

function connectWebSocket() {
  if (ws && ws.readyState <= 1) return;

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
      console.error("[Bridge] Malformed server message");
      return;
    }

    if (msg.type === "pong") return;

    if (msg.action === "SEND_PROMPT") {
      console.log(`[Bridge] Received prompt request: ${msg.id} (files: ${msg.files?.length || 0})`);
      await relayToClaudeTab(msg.id, msg.prompt, msg.files);
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

// ── Relay prompt + files to the active claude.ai tab ─────────────────────────

async function relayToClaudeTab(id, prompt, files, isRetry = false) {
  try {
    const tabs = await chrome.tabs.query({ url: "https://claude.ai/*" });

    if (tabs.length === 0) {
      console.error("[Bridge] No claude.ai tab found");
      sendToServer({ id, response: "[ERROR] No claude.ai tab is open." });
      return;
    }

    const target = tabs.find((t) => t.active) || tabs[0];

    chrome.tabs.sendMessage(
      target.id,
      { action: "INJECT_PROMPT", id, prompt, files },
      async (response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Bridge] Content script not reachable:", chrome.runtime.lastError.message);

          if (!isRetry) {
            console.log("[Bridge] Auto-injecting content.js into tab", target.id);
            try {
              await chrome.scripting.executeScript({
                target: { tabId: target.id },
                files: ["content.js"],
              });
              await new Promise((r) => setTimeout(r, 500));
              console.log("[Bridge] Retrying after injection…");
              relayToClaudeTab(id, prompt, files, true);
            } catch (injectErr) {
              console.error("[Bridge] Injection failed:", injectErr);
              sendToServer({ id, response: `[ERROR] Failed to inject: ${injectErr.message}` });
            }
          } else {
            sendToServer({ id, response: "[ERROR] Content script unreachable. Refresh claude.ai tab." });
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
    console.log(`[Bridge] Response ready for ${msg.id} (files: ${msg.files?.length || 0})`);
    sendToServer({ id: msg.id, response: msg.text, files: msg.files });
  }
});

// ── Send to server ───────────────────────────────────────────────────────────

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.error("[Bridge] Cannot send – WebSocket not connected");
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
connectWebSocket();

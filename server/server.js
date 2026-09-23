const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ── WebSocket server on /ws ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });

let extensionSocket = null;

wss.on("connection", (ws) => {
  console.log("[WS] Chrome Extension connected");
  extensionSocket = ws;
  ws.isAlive = true;

  // ── Protocol-level pong handler (response to our pings) ──────────────
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[WS] Malformed message:", raw.toString());
      return;
    }

    // Handle application-level ping from extension (keepalive)
    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Extension sends back { id, response }
    if (msg.id && msg.response !== undefined) {
      const pending = pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.id);

        const reply = {
          id: `chatcmpl-${msg.id}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "claude-bridge",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: msg.response },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        };

        console.log(`[API] ✓ Resolved request ${msg.id}`);
        pending.res.json(reply);
      } else {
        console.warn(`[WS] No pending request for id=${msg.id}`);
      }
    }
  });

  ws.on("close", () => {
    console.log("[WS] Chrome Extension disconnected");
    if (extensionSocket === ws) extensionSocket = null;
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});

// ── Server-side heartbeat: ping every 25 seconds ────────────────────────────
// Sends protocol-level WebSocket pings. If the extension doesn't respond
// with a pong before the next ping cycle, the connection is terminated.
const HEARTBEAT_INTERVAL = 25_000;

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log("[WS] Client unresponsive – terminating");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

wss.on("close", () => {
  clearInterval(heartbeat);
});

// ── Pending requests map ─────────────────────────────────────────────────────
const pendingRequests = new Map(); // Map<requestId, { res, timer }>

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    extensionConnected:
      extensionSocket !== null && extensionSocket.readyState === 1,
    pendingRequests: pendingRequests.size,
    uptime: process.uptime(),
  });
});

// ── OpenAI-compatible completions endpoint ───────────────────────────────────
app.post("/v1/chat/completions", (req, res) => {
  const { messages } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: "messages array is required and must be non-empty",
        type: "invalid_request_error",
      },
    });
  }

  // Extract the latest user message
  const userMessages = messages.filter((m) => m.role === "user");
  const prompt =
    userMessages.length > 0
      ? userMessages[userMessages.length - 1].content
      : messages[messages.length - 1].content;

  if (!prompt) {
    return res.status(400).json({
      error: {
        message: "No prompt content found in messages",
        type: "invalid_request_error",
      },
    });
  }

  // Verify extension is connected
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return res.status(503).json({
      error: {
        message:
          "Chrome Extension is not connected. Load the extension and open claude.ai.",
        type: "service_unavailable",
      },
    });
  }

  const requestId = crypto.randomUUID();

  // 120-second timeout → 504
  const timer = setTimeout(() => {
    pendingRequests.delete(requestId);
    if (!res.headersSent) {
      res.status(504).json({
        error: {
          message: `Request ${requestId} timed out after 120 seconds`,
          type: "gateway_timeout",
        },
      });
    }
  }, 120_000);

  pendingRequests.set(requestId, { res, timer });

  // Dispatch to extension
  const payload = JSON.stringify({
    action: "SEND_PROMPT",
    id: requestId,
    prompt,
  });

  extensionSocket.send(payload);
  console.log(
    `[API] → Dispatched request ${requestId}: "${prompt.substring(0, 80)}…"`
  );
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = 8080;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   Claude Web Bridge – OpenAI-Compatible Proxy    ║
║──────────────────────────────────────────────────║
║   HTTP  →  http://localhost:${PORT}                 ║
║   WS    →  ws://localhost:${PORT}/ws                ║
║   Health→  http://localhost:${PORT}/health           ║
╚══════════════════════════════════════════════════╝
  `);
});

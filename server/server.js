const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const cors = require("cors");
const crypto = require("crypto");

// ── Config from environment ──────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080");
const API_KEY = process.env.API_KEY || ""; // Set this in cloud env vars
const WS_SECRET = process.env.WS_SECRET || ""; // Extension uses this to authenticate
const NODE_ENV = process.env.NODE_ENV || "development";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const server = http.createServer(app);

// ── Auth middleware ──────────────────────────────────────────────────────────
// In production, require API_KEY for HTTP endpoints and WS_SECRET for WebSocket.
// In development (no keys set), everything is open.

function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // No key configured = open access

  const provided =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-api-key"] ||
    req.query.api_key;

  if (provided !== API_KEY) {
    return res.status(401).json({
      error: {
        message: "Invalid or missing API key. Provide via Authorization: Bearer <key>",
        type: "authentication_error",
      },
    });
  }
  next();
}

// ── WebSocket server on /ws ──────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 50 * 1024 * 1024 });

let extensionSocket = null;

wss.on("connection", (ws, req) => {
  // Authenticate WebSocket connections in production
  if (WS_SECRET) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== WS_SECRET) {
      console.log("[WS] Rejected – invalid token");
      ws.close(4001, "Invalid token");
      return;
    }
  }

  console.log("[WS] Chrome Extension connected");
  extensionSocket = ws;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[WS] Malformed message:", raw.toString().substring(0, 200));
      return;
    }

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    // Extension sends back { id, response, files? }
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

        if (msg.files && msg.files.length > 0) {
          reply.files = msg.files;
          console.log(`[API] ✓ Resolved ${msg.id} with ${msg.files.length} file(s)`);
        } else {
          console.log(`[API] ✓ Resolved request ${msg.id}`);
        }

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

// ── Server-side heartbeat ────────────────────────────────────────────────────
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

wss.on("close", () => clearInterval(heartbeat));

// ── Pending requests map ─────────────────────────────────────────────────────
const pendingRequests = new Map();

// ── Health check (public — no auth needed) ───────────────────────────────────
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
app.post("/v1/chat/completions", authMiddleware, (req, res) => {
  const { messages, files } = req.body;

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
  const lastUserMsg = userMessages.length > 0
    ? userMessages[userMessages.length - 1]
    : messages[messages.length - 1];

  let prompt = "";
  let attachedFiles = files || [];

  if (typeof lastUserMsg.content === "string") {
    prompt = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg.content)) {
    for (const part of lastUserMsg.content) {
      if (part.type === "text") {
        prompt += part.text;
      } else if (part.type === "image_url" && part.image_url?.url) {
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          attachedFiles.push({
            name: `image_${attachedFiles.length + 1}.${match[1].split("/")[1] || "png"}`,
            type: match[1],
            data: match[2],
          });
        }
      } else if (part.type === "file" && part.data) {
        attachedFiles.push({
          name: part.name || `file_${attachedFiles.length + 1}`,
          type: part.mime_type || "application/octet-stream",
          data: part.data,
        });
      }
    }
  }

  if (lastUserMsg.files && Array.isArray(lastUserMsg.files)) {
    attachedFiles = attachedFiles.concat(lastUserMsg.files);
  }

  if (!prompt && attachedFiles.length === 0) {
    return res.status(400).json({
      error: {
        message: "No prompt content or files found in messages",
        type: "invalid_request_error",
      },
    });
  }

  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return res.status(503).json({
      error: {
        message: "Chrome Extension is not connected. Load the extension and open claude.ai.",
        type: "service_unavailable",
      },
    });
  }

  const requestId = crypto.randomUUID();

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

  const payload = JSON.stringify({
    action: "SEND_PROMPT",
    id: requestId,
    prompt: prompt || "(See attached files)",
    files: attachedFiles.length > 0 ? attachedFiles : undefined,
  });

  extensionSocket.send(payload);

  const fileInfo = attachedFiles.length > 0 ? ` + ${attachedFiles.length} file(s)` : "";
  console.log(
    `[API] → Dispatched ${requestId}: "${(prompt || "").substring(0, 60)}…"${fileInfo}`
  );
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  const mode = API_KEY ? "🔒 Authenticated" : "🔓 Open (no API_KEY set)";
  console.log(`
╔══════════════════════════════════════════════════╗
║   Claude Web Bridge – Cloud Server               ║
║──────────────────────────────────────────────────║
║   Port    →  ${String(PORT).padEnd(36)}║
║   Mode    →  ${mode.padEnd(36)}║
║   Files   →  Upload & Download supported         ║
╚══════════════════════════════════════════════════╝
  `);
});

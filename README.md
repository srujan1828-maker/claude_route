# Claude Web Bridge – OpenAI-Compatible Proxy

A local system that exposes an **OpenAI-compatible** `/v1/chat/completions` API backed by an active `claude.ai` browser tab. Any tool or library that speaks the OpenAI Chat API can now use Claude via your browser session – no API key required.

## Architecture

```
┌──────────────┐   HTTP POST    ┌──────────────────┐   WebSocket   ┌──────────────────┐
│  Any OpenAI  │ ─────────────▶ │  Express Server  │ ◀───────────▶ │ Chrome Extension │
│  Client/SDK  │ ◀───────────── │  localhost:8080   │               │  (background.js) │
└──────────────┘   JSON resp    └──────────────────┘               └────────┬─────────┘
                                                                            │ chrome.tabs
                                                                   ┌────────▼─────────┐
                                                                   │   content.js on   │
                                                                   │   claude.ai tab   │
                                                                   └──────────────────┘
```

## Quick Start

### 1. Install & Start the Server

```bash
cd server
npm install
npm start
```

The server will listen on `http://localhost:8080`.

### 2. Load the Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **"Load unpacked"**.
4. Select the `extension/` directory from this project.
5. The extension badge should appear in your toolbar.

### 3. Open Claude

Navigate to [https://claude.ai](https://claude.ai) and ensure you are logged in with an active conversation or a new chat page open.

### 4. Test

```bash
node test-client.js
# or with a custom prompt:
node test-client.js "Explain quantum computing in one sentence"
```

## API Reference

### `POST /v1/chat/completions`

Standard OpenAI Chat Completions schema:

```json
{
  "model": "claude-bridge",
  "messages": [
    { "role": "user", "content": "Hello!" }
  ]
}
```

**Response** follows the OpenAI format with `choices[0].message.content` containing Claude's reply.

### `GET /health`

Returns server status and extension connection state:

```json
{
  "status": "ok",
  "extensionConnected": true,
  "pendingRequests": 0,
  "uptime": 42.5
}
```

## Timeout

Requests that don't receive a response within **120 seconds** will return `504 Gateway Timeout`.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `503 – Extension not connected` | Ensure the extension is loaded and the server is running |
| `504 – Gateway Timeout` | Claude may be slow or the content script selectors need updating |
| Send button not found | Claude's UI may have changed; update the selector in `content.js` |
| No response text captured | Check `content.js` selectors for `.font-claude-message` |

## Important Notes

- This tool automates a **browser session you are already logged into**. It does not bypass any authentication.
- Claude.ai's DOM structure may change over time, requiring selector updates in `content.js`.
- Only one request is processed at a time through the browser tab.
- This is intended for **local development and experimentation only**.

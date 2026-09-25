// ── Popup script – saves config to chrome.storage and communicates with background ──

const serverUrlInput = document.getElementById("serverUrl");
const wsSecretInput = document.getElementById("wsSecret");
const saveBtn = document.getElementById("saveBtn");
const testBtn = document.getElementById("testBtn");
const statusBar = document.getElementById("status");
const statusText = document.getElementById("statusText");
const toast = document.getElementById("toast");

// ── Load saved config ──────────────────────────────────────────────────────

chrome.storage.local.get(["serverWsUrl", "wsSecret"], (data) => {
  serverUrlInput.value = data.serverWsUrl || "ws://localhost:8080/ws";
  wsSecretInput.value = data.wsSecret || "";
  checkStatus();
});

// ── Save config ────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const url = serverUrlInput.value.trim();
  const secret = wsSecretInput.value.trim();

  if (!url) {
    showToast("URL cannot be empty", "error");
    return;
  }

  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    showToast("URL must start with ws:// or wss://", "error");
    return;
  }

  chrome.storage.local.set({ serverWsUrl: url, wsSecret: secret }, () => {
    // Tell background to reconnect with new config
    chrome.runtime.sendMessage({ action: "RECONNECT" }, (resp) => {
      if (chrome.runtime.lastError) {
        showToast("Saved! Reload extension to apply.", "success");
      } else {
        showToast("Saved & reconnecting…", "success");
        setTimeout(checkStatus, 2000);
      }
    });
  });
});

// ── Test connection ────────────────────────────────────────────────────────

testBtn.addEventListener("click", async () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showToast("Enter a URL first", "error");
    return;
  }

  // Derive the HTTP health URL from the WS URL
  const healthUrl = url
    .replace(/^wss:/, "https:")
    .replace(/^ws:/, "http:")
    .replace(/\/ws\/?$/, "/health");

  setStatus("checking", "Testing connection…");

  try {
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();

    if (data.status === "ok") {
      const ext = data.extensionConnected ? "extension connected" : "extension not connected yet";
      setStatus("connected", `Server reachable (${ext})`);
      showToast(`✓ Server OK — ${ext}`, "success");
    } else {
      setStatus("disconnected", "Server returned unexpected response");
      showToast("Unexpected response from server", "error");
    }
  } catch (err) {
    setStatus("disconnected", "Cannot reach server");
    showToast(`✗ ${err.message}`, "error");
  }
});

// ── Preset buttons ─────────────────────────────────────────────────────────

document.querySelectorAll(".preset-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const url = btn.dataset.url;
    if (url === "wss://") {
      // Cloud preset — put cursor at the right spot for user to type
      serverUrlInput.value = "wss://";
      serverUrlInput.focus();
      serverUrlInput.setSelectionRange(6, 6);
    } else {
      serverUrlInput.value = url;
    }
  });
});

// ── Check current status from background ───────────────────────────────────

function checkStatus() {
  chrome.runtime.sendMessage({ action: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus("disconnected", "Extension not responding");
      return;
    }
    if (resp && resp.connected) {
      setStatus("connected", `Connected to ${resp.url || "server"}`);
    } else {
      setStatus("disconnected", resp?.error || "Not connected");
    }
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusBar.className = `status-bar ${state}`;
  statusText.textContent = text;
}

function showToast(message, type) {
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.className = "toast";
  }, 4000);
}

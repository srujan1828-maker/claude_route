// ── Content script for claude.ai ─────────────────────────────────────────────
// Injected at document_idle on https://claude.ai/*

(() => {
  "use strict";

  // ── Keepalive port to background service worker ──────────────────────────
  // Maintains a long-lived port that prevents Chrome from killing the
  // service worker while this claude.ai tab is open.

  let keepalivePort = null;
  let keepalivePingTimer = null;

  function connectKeepalive() {
    try {
      keepalivePort = chrome.runtime.connect({ name: "keepalive" });

      keepalivePort.onDisconnect.addListener(() => {
        console.log("[Claude Bridge] Keepalive port disconnected – reconnecting");
        keepalivePort = null;
        clearInterval(keepalivePingTimer);
        // Reconnect after a short delay
        setTimeout(connectKeepalive, 1000);
      });

      // Ping every 25 seconds to keep the port alive
      keepalivePingTimer = setInterval(() => {
        try {
          if (keepalivePort) {
            keepalivePort.postMessage({ type: "ping" });
          }
        } catch {
          clearInterval(keepalivePingTimer);
        }
      }, 25_000);

      console.log("[Claude Bridge] Keepalive port connected");
    } catch (err) {
      console.error("[Claude Bridge] Keepalive connect failed:", err);
      setTimeout(connectKeepalive, 3000);
    }
  }

  // Chrome disconnects ports after 5 minutes; proactively reconnect every 280s
  setInterval(() => {
    if (keepalivePort) {
      keepalivePort.disconnect();
    }
    connectKeepalive();
  }, 280_000);

  connectKeepalive();

  // ── Listen for prompts from the background service worker ────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "INJECT_PROMPT") {
      console.log(`[Claude Bridge] Injecting prompt for request ${msg.id}`);
      injectAndSend(msg.id, msg.prompt);
      sendResponse({ status: "injecting" });
    }
  });

  // ── Core injection logic ─────────────────────────────────────────────────

  async function injectAndSend(requestId, prompt) {
    try {
      // 1. Locate the ProseMirror contenteditable input
      const editor = document.querySelector(
        'div[contenteditable="true"]'
      );

      if (!editor) {
        sendError(requestId, "Could not find the Claude input editor.");
        return;
      }

      // 2. Focus and insert text
      editor.focus();

      // Clear any existing content
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);

      // Use execCommand for maximum compatibility with ProseMirror
      document.execCommand("insertText", false, prompt);

      // 3. Wait for UI to settle, then trigger send
      await sleep(300);

      const sent = await triggerSend();
      if (!sent) {
        sendError(requestId, "Could not find or click the Send button.");
        return;
      }

      // 4. Observe the assistant's response
      observeResponse(requestId);
    } catch (err) {
      console.error("[Claude Bridge] Injection error:", err);
      sendError(requestId, err.message);
    }
  }

  // ── Trigger the Send action ──────────────────────────────────────────────

  async function triggerSend() {
    // Strategy 1: Look for the Send button by aria-label
    const sendBtn =
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="send"]');

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return true;
    }

    // Strategy 2: Dispatch Enter keydown on the editor
    const editor = document.querySelector(
      'div[contenteditable="true"]'
    );
    if (editor) {
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(enterEvent);
      return true;
    }

    return false;
  }

  // ── Observe Claude's response via MutationObserver ───────────────────────

  function observeResponse(requestId) {
    // Give a moment for the response container to appear
    const INITIAL_WAIT = 1000;
    const DEBOUNCE_MS = 1500;
    const MAX_WAIT = 110_000; // Just under the server's 120s timeout

    setTimeout(() => {
      // Identify the message container – claude.ai uses various selectors
      const container =
        document.querySelector('[class*="conversation"]') ||
        document.querySelector("main") ||
        document.body;

      let debounceTimer = null;
      let maxTimer = null;

      const observer = new MutationObserver((_mutations) => {
        // Reset debounce on every DOM mutation
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Check if streaming is still active
          const stopBtn =
            document.querySelector('button[aria-label*="Stop"]') ||
            document.querySelector('button[aria-label*="stop"]');
          const streamingIndicator = document.querySelector(
            '[class*="streaming"]'
          );

          if (!stopBtn && !streamingIndicator) {
            // Generation complete
            finalize();
          }
          // Otherwise keep waiting – the observer will fire again
        }, DEBOUNCE_MS);
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      // Safety: force-finalize after MAX_WAIT
      maxTimer = setTimeout(() => finalize(), MAX_WAIT);

      function finalize() {
        observer.disconnect();
        clearTimeout(debounceTimer);
        clearTimeout(maxTimer);

        const text = extractAssistantText();
        console.log(
          `[Claude Bridge] Captured ${text.length} chars for ${requestId}`
        );

        chrome.runtime.sendMessage({
          action: "OUTPUT_READY",
          id: requestId,
          text,
        });
      }
    }, INITIAL_WAIT);
  }

  // ── Extract the latest assistant message text ────────────────────────────

  function extractAssistantText() {
    // Try the most specific selector first
    const blocks = document.querySelectorAll(
      ".font-claude-message"
    );

    if (blocks.length > 0) {
      const last = blocks[blocks.length - 1];
      return last.innerText.trim();
    }

    // Fallback: grab the last assistant-attributed message
    const allMessages = document.querySelectorAll(
      '[data-is-streaming], [class*="message"], [class*="response"]'
    );
    if (allMessages.length > 0) {
      return allMessages[allMessages.length - 1].innerText.trim();
    }

    return "[ERROR] Could not extract assistant response text.";
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function sendError(requestId, errorMsg) {
    chrome.runtime.sendMessage({
      action: "OUTPUT_READY",
      id: requestId,
      text: `[ERROR] ${errorMsg}`,
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();

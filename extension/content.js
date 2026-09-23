// ── Content script for claude.ai ─────────────────────────────────────────────
// Injected at document_idle on https://claude.ai/*
// Supports: text injection, file upload, response extraction with artifacts

(() => {
  "use strict";

  // ── Keepalive port ───────────────────────────────────────────────────────
  let keepalivePort = null;
  let keepalivePingTimer = null;

  function connectKeepalive() {
    try {
      keepalivePort = chrome.runtime.connect({ name: "keepalive" });
      keepalivePort.onDisconnect.addListener(() => {
        keepalivePort = null;
        clearInterval(keepalivePingTimer);
        setTimeout(connectKeepalive, 1000);
      });
      keepalivePingTimer = setInterval(() => {
        try { if (keepalivePort) keepalivePort.postMessage({ type: "ping" }); }
        catch { clearInterval(keepalivePingTimer); }
      }, 25_000);
      console.log("[Claude Bridge] Keepalive port connected");
    } catch (err) {
      console.error("[Claude Bridge] Keepalive connect failed:", err);
      setTimeout(connectKeepalive, 3000);
    }
  }

  setInterval(() => {
    if (keepalivePort) keepalivePort.disconnect();
    connectKeepalive();
  }, 280_000);

  connectKeepalive();

  // ── Message listener ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "INJECT_PROMPT") {
      console.log(`[Claude Bridge] Injecting prompt for ${msg.id} (files: ${msg.files?.length || 0})`);
      injectAndSend(msg.id, msg.prompt, msg.files || []);
      sendResponse({ status: "injecting" });
    }
  });

  // ── Core injection logic ─────────────────────────────────────────────────

  async function injectAndSend(requestId, prompt, files) {
    try {
      // 1. Upload files first (if any)
      if (files.length > 0) {
        console.log(`[Claude Bridge] Uploading ${files.length} file(s)…`);
        await uploadFiles(files);
        await sleep(500); // Let UI process the uploads
      }

      // 2. Locate the ProseMirror editor
      const editor = document.querySelector('div[contenteditable="true"]');
      if (!editor) {
        sendError(requestId, "Could not find the Claude input editor.");
        return;
      }

      // 3. Focus and insert text
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("insertText", false, prompt);

      // 4. Wait, then send
      await sleep(300);
      const sent = await triggerSend();
      if (!sent) {
        sendError(requestId, "Could not find or click the Send button.");
        return;
      }

      // 5. Observe response
      observeResponse(requestId);
    } catch (err) {
      console.error("[Claude Bridge] Injection error:", err);
      sendError(requestId, err.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FILE UPLOAD — Injects files into Claude's upload interface
  // ══════════════════════════════════════════════════════════════════════════

  async function uploadFiles(files) {
    for (const file of files) {
      try {
        // Convert base64 to a File object
        const byteChars = atob(file.data);
        const byteArray = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) {
          byteArray[i] = byteChars.charCodeAt(i);
        }
        const blob = new Blob([byteArray], { type: file.type || "application/octet-stream" });
        const fileObj = new File([blob], file.name || "upload", { type: blob.type });

        // Strategy 1: Use the hidden file input if available
        const fileInput = document.querySelector('input[type="file"]');
        if (fileInput) {
          const dt = new DataTransfer();
          dt.items.add(fileObj);
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          console.log(`[Claude Bridge] ✓ Uploaded via input: ${file.name}`);
          await sleep(300);
          continue;
        }

        // Strategy 2: Simulate drag-and-drop onto the editor area
        const dropZone =
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector("main") ||
          document.body;

        const dtDrop = new DataTransfer();
        dtDrop.items.add(fileObj);

        const dragEnter = new DragEvent("dragenter", { bubbles: true, dataTransfer: dtDrop });
        const dragOver = new DragEvent("dragover", { bubbles: true, dataTransfer: dtDrop });
        const drop = new DragEvent("drop", { bubbles: true, dataTransfer: dtDrop });

        dropZone.dispatchEvent(dragEnter);
        dropZone.dispatchEvent(dragOver);
        dropZone.dispatchEvent(drop);

        console.log(`[Claude Bridge] ✓ Uploaded via drop: ${file.name}`);
        await sleep(300);

      } catch (err) {
        console.error(`[Claude Bridge] Failed to upload ${file.name}:`, err);
      }
    }

    // Wait for uploads to fully process
    await sleep(500);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TRIGGER SEND
  // ══════════════════════════════════════════════════════════════════════════

  async function triggerSend() {
    const sendBtn =
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="send"]');

    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return true;
    }

    const editor = document.querySelector('div[contenteditable="true"]');
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      return true;
    }

    return false;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // OBSERVE RESPONSE + EXTRACT FILES/ARTIFACTS
  // ══════════════════════════════════════════════════════════════════════════

  function observeResponse(requestId) {
    const INITIAL_WAIT = 1000;
    const DEBOUNCE_MS = 1500;
    const MAX_WAIT = 110_000;

    setTimeout(() => {
      const container =
        document.querySelector('[class*="conversation"]') ||
        document.querySelector("main") ||
        document.body;

      let debounceTimer = null;
      let maxTimer = null;

      const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const stopBtn =
            document.querySelector('button[aria-label*="Stop"]') ||
            document.querySelector('button[aria-label*="stop"]');
          const streaming = document.querySelector('[class*="streaming"]');

          if (!stopBtn && !streaming) {
            finalize();
          }
        }, DEBOUNCE_MS);
      });

      observer.observe(container, { childList: true, subtree: true, characterData: true });
      maxTimer = setTimeout(() => finalize(), MAX_WAIT);

      function finalize() {
        observer.disconnect();
        clearTimeout(debounceTimer);
        clearTimeout(maxTimer);

        const text = extractAssistantText();
        const files = extractOutputFiles();

        console.log(`[Claude Bridge] Captured ${text.length} chars, ${files.length} file(s) for ${requestId}`);

        chrome.runtime.sendMessage({
          action: "OUTPUT_READY",
          id: requestId,
          text,
          files: files.length > 0 ? files : undefined,
        });
      }
    }, INITIAL_WAIT);
  }

  // ── Extract assistant text ───────────────────────────────────────────────

  function extractAssistantText() {
    const blocks = document.querySelectorAll(".font-claude-message");
    if (blocks.length > 0) {
      return blocks[blocks.length - 1].innerText.trim();
    }

    const allMessages = document.querySelectorAll(
      '[data-is-streaming], [class*="message"], [class*="response"]'
    );
    if (allMessages.length > 0) {
      return allMessages[allMessages.length - 1].innerText.trim();
    }

    return "[ERROR] Could not extract assistant response text.";
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FILE DOWNLOAD — Extracts code blocks and artifacts from response
  // ══════════════════════════════════════════════════════════════════════════

  function extractOutputFiles() {
    const files = [];

    // 1. Extract from Claude Artifacts (if the Artifact panel is open)
    const artifactPanels = document.querySelectorAll(
      '[class*="artifact"], [class*="Artifact"], [data-artifact]'
    );
    artifactPanels.forEach((panel, i) => {
      const titleEl = panel.querySelector('[class*="title"], [class*="name"], h1, h2, h3');
      const contentEl = panel.querySelector('code, pre, [class*="content"]');
      if (contentEl) {
        const title = titleEl?.textContent?.trim() || `artifact_${i + 1}`;
        files.push({
          name: sanitizeFilename(title),
          content: contentEl.textContent.trim(),
          language: detectLanguage(contentEl),
          source: "artifact",
        });
      }
    });

    // 2. Extract code blocks from the latest assistant message
    const messageBubbles = document.querySelectorAll(".font-claude-message");
    const lastMessage = messageBubbles.length > 0 ? messageBubbles[messageBubbles.length - 1] : null;

    if (lastMessage) {
      const codeBlocks = lastMessage.querySelectorAll("pre");
      codeBlocks.forEach((pre, i) => {
        const codeEl = pre.querySelector("code");
        const code = (codeEl || pre).textContent.trim();

        if (code.length < 20) return; // Skip tiny snippets

        // Try to detect language from class name (e.g., "language-python")
        const langClass = codeEl?.className?.match(/language-(\w+)/);
        const lang = langClass ? langClass[1] : "txt";

        // Try to find a filename in the text above the code block
        const filename = findFilenameNear(pre) || `code_block_${i + 1}.${langExtension(lang)}`;

        files.push({
          name: filename,
          content: code,
          language: lang,
          source: "code_block",
        });
      });
    }

    // 3. Check for download links/buttons
    const downloadLinks = document.querySelectorAll(
      'a[download], a[href^="blob:"], a[href^="data:"]'
    );
    downloadLinks.forEach((link, i) => {
      files.push({
        name: link.download || link.textContent?.trim() || `download_${i + 1}`,
        url: link.href,
        source: "download_link",
      });
    });

    return files;
  }

  // ── Helper: find filename in text near a code block ──────────────────────

  function findFilenameNear(preElement) {
    // Look at the previous sibling or parent for filename patterns
    let el = preElement.previousElementSibling;
    for (let tries = 0; tries < 3 && el; tries++) {
      const text = el.textContent || "";
      // Match patterns like "filename.ext", "src/file.py", etc.
      const match = text.match(/(?:^|\s|`)([\w\-./]+\.\w{1,10})(?:\s|`|:|$)/);
      if (match) return match[1].split("/").pop();
      el = el.previousElementSibling;
    }
    return null;
  }

  // ── Helper: detect language from code element ────────────────────────────

  function detectLanguage(el) {
    const cls = el.className || "";
    const match = cls.match(/language-(\w+)/);
    return match ? match[1] : "text";
  }

  // ── Helper: sanitize filename ────────────────────────────────────────────

  function sanitizeFilename(name) {
    return name
      .replace(/[^a-zA-Z0-9._\-\s]/g, "")
      .replace(/\s+/g, "_")
      .substring(0, 100) || "file";
  }

  // ── Helper: language to file extension ───────────────────────────────────

  function langExtension(lang) {
    const map = {
      python: "py", javascript: "js", typescript: "ts", java: "java",
      cpp: "cpp", c: "c", csharp: "cs", go: "go", rust: "rs",
      ruby: "rb", php: "php", swift: "swift", kotlin: "kt",
      html: "html", css: "css", sql: "sql", bash: "sh", shell: "sh",
      yaml: "yaml", yml: "yaml", json: "json", xml: "xml",
      markdown: "md", md: "md", txt: "txt", text: "txt",
    };
    return map[lang.toLowerCase()] || lang;
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

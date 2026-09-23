/**
 * Test file upload & download through the Claude Bridge.
 *
 * Usage:
 *   node test-files.js                  ← sends a sample CSV file
 *   node test-files.js path/to/file     ← sends your own file
 */

const fs = require("fs");
const path = require("path");
const API_URL = "http://localhost:8080/v1/chat/completions";

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       Claude Bridge – File Upload/Download Test  ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  let fileName, fileType, fileBase64;

  if (process.argv[2]) {
    // User provided a file path
    const filePath = path.resolve(process.argv[2]);
    if (!fs.existsSync(filePath)) {
      console.error(`✗ File not found: ${filePath}`);
      process.exit(1);
    }
    const buffer = fs.readFileSync(filePath);
    fileName = path.basename(filePath);
    fileType = guessMime(fileName);
    fileBase64 = buffer.toString("base64");
    console.log(`→ Uploading: ${fileName} (${buffer.length} bytes, ${fileType})\n`);
  } else {
    // Create a sample CSV file
    const csv = [
      "name,age,city,score",
      "Alice,28,New York,92",
      "Bob,34,San Francisco,87",
      "Charlie,22,Chicago,95",
      "Diana,31,Austin,78",
      "Eve,27,Seattle,91",
    ].join("\n");
    fileName = "sample_data.csv";
    fileType = "text/csv";
    fileBase64 = Buffer.from(csv).toString("base64");
    console.log(`→ Uploading sample CSV: ${fileName} (${csv.length} bytes)\n`);
  }

  // Check health
  try {
    const health = await fetch("http://localhost:8080/health").then((r) => r.json());
    if (!health.extensionConnected) {
      console.error("✗ Extension not connected. Aborting.");
      process.exit(1);
    }
    console.log("✓ Extension connected\n");
  } catch {
    console.error("✗ Server not reachable.");
    process.exit(1);
  }

  console.log("Sending request with file…\n");
  const start = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-bridge",
        messages: [
          {
            role: "user",
            content: "Analyze this file. Describe what it contains, show key stats, and suggest improvements.",
            files: [
              {
                name: fileName,
                type: fileType,
                data: fileBase64,
              },
            ],
          },
        ],
      }),
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const data = await res.json();

    if (!res.ok) {
      console.error(`✗ Server returned ${res.status} after ${elapsed}s:`);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    const content = data.choices?.[0]?.message?.content || "";
    console.log(`✓ Response received in ${elapsed}s\n`);

    // Show the response text
    console.log("═══ Assistant Response ═══");
    console.log(content);
    console.log("═".repeat(50));

    // Show extracted files if any
    if (data.files && data.files.length > 0) {
      console.log(`\n📎 ${data.files.length} file(s) extracted from response:\n`);
      data.files.forEach((f, i) => {
        console.log(`─── File ${i + 1}: ${f.name} (${f.language || "unknown"}, from ${f.source}) ───`);
        if (f.content) {
          // Show first 500 chars
          console.log(f.content.substring(0, 500));
          if (f.content.length > 500) console.log(`... (${f.content.length} chars total)`);
        }
        if (f.url) {
          console.log(`Download URL: ${f.url}`);
        }
        console.log();
      });
    } else {
      console.log("\n(No code blocks or artifacts extracted from response)");
    }
  } catch (err) {
    console.error(`✗ Failed:`, err.message);
    process.exit(1);
  }
}

function guessMime(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
    ".js": "text/javascript", ".py": "text/x-python", ".ts": "text/typescript",
    ".html": "text/html", ".css": "text/css", ".xml": "text/xml",
    ".md": "text/markdown", ".yaml": "text/yaml", ".yml": "text/yaml",
    ".pdf": "application/pdf", ".zip": "application/zip",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

main();

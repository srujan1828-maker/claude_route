/**
 * Test client – sends an OpenAI-compatible request to the Claude Bridge server.
 *
 * Usage:
 *   node test-client.js
 *   node test-client.js "Your custom prompt here"
 */

const prompt = process.argv[2] || "Hello! Please respond with a short greeting.";
const API_URL = "http://localhost:8080/v1/chat/completions";

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║       Claude Bridge – Test Client            ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`→ Prompt: "${prompt}"\n`);
  console.log("Sending request to", API_URL, "…\n");

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-bridge",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error(`✗ Server returned ${res.status}:`);
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log("✓ Response received:\n");
    console.log("─── Full Payload ───");
    console.log(JSON.stringify(data, null, 2));
    console.log("\n─── Assistant Message ───");
    console.log(data.choices?.[0]?.message?.content || "(empty)");
  } catch (err) {
    console.error("✗ Connection failed:", err.message);
    console.error(
      "\n  Make sure the server is running:  cd server && npm start"
    );
    process.exit(1);
  }
}

main();

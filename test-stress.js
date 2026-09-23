/**
 * Stress test – sends a large, complex prompt to verify the full pipeline
 * handles real-world workloads (long input + long output).
 *
 * Usage:
 *   node test-stress.js
 *   node test-stress.js quick     ← shorter test
 */

const API_URL = "http://localhost:8080/v1/chat/completions";
const mode = process.argv[2] || "full";

const PROMPTS = {
  quick: {
    name: "Quick Sanity Check",
    messages: [
      {
        role: "user",
        content:
          "List the 7 wonders of the ancient world. For each one, give: name, location, approximate date built, and current status (standing/destroyed). Format as a markdown table.",
      },
    ],
  },

  full: {
    name: "Full Stress Test (Long Input + Long Output)",
    messages: [
      {
        role: "system",
        content:
          "You are a senior software architect. Provide detailed, production-quality responses with code examples. Always include error handling, edge cases, and performance considerations.",
      },
      {
        role: "user",
        content: `I need you to design and implement a complete rate limiter system. Here are the detailed requirements:

## Requirements

### Core Rate Limiting
1. Implement a **Token Bucket** algorithm that supports:
   - Configurable bucket capacity (max tokens)
   - Configurable refill rate (tokens per second)
   - Thread-safe operation for concurrent access
   - Support for variable token costs (different endpoints cost different amounts)

2. Implement a **Sliding Window Log** algorithm as an alternative that supports:
   - Configurable window size (e.g., 60 seconds, 5 minutes)
   - Configurable max requests per window
   - Memory-efficient storage using sorted sets

### Multi-tier Rate Limiting
3. Support **three tiers** of rate limits applied simultaneously:
   - Per-IP: 100 requests/minute
   - Per-User (API key): 1000 requests/hour  
   - Global: 10,000 requests/minute

4. When any tier is exceeded, return a proper HTTP 429 response with:
   - \`Retry-After\` header with seconds until the limit resets
   - \`X-RateLimit-Limit\` header with the limit for the tier that was hit
   - \`X-RateLimit-Remaining\` header with remaining requests
   - \`X-RateLimit-Reset\` header with UTC epoch time of reset
   - JSON body with error details

### Storage Backend
5. Support two storage backends:
   - **In-memory** using a Map (for single-instance deployments)
   - **Redis** using sorted sets (for distributed deployments)
   - Both must implement the same interface so they're swappable

### Middleware Integration
6. Provide Express.js middleware that:
   - Extracts the client identifier (IP, API key from header, or both)
   - Applies rate limits before the request reaches the handler
   - Logs rate limit events (hits and violations)
   - Supports route-specific overrides (e.g., /api/search gets a lower limit)

### Additional Features
7. Implement a **burst allowance**: allow 2x the normal rate for the first 10 seconds of a new client's activity
8. Implement **graceful degradation**: when Redis is unavailable, fall back to in-memory without losing requests
9. Add **whitelist/blacklist** support: certain IPs or API keys can bypass or be permanently blocked

Please provide:
- Complete TypeScript implementation with all files
- Unit tests for the token bucket and sliding window algorithms
- Integration test for the Express middleware
- A README with usage examples
- Performance analysis: what's the time and space complexity of each algorithm?`,
      },
    ],
  },
};

async function main() {
  const test = PROMPTS[mode] || PROMPTS.full;

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       Claude Bridge – Stress Test                ║");
  console.log("╚══════════════════════════════════════════════════╝\n");
  console.log(`Test: ${test.name}`);
  console.log(`Messages: ${test.messages.length}`);
  console.log(
    `Total input chars: ${test.messages.reduce((s, m) => s + m.content.length, 0)}\n`
  );

  // Check health first
  try {
    const health = await fetch("http://localhost:8080/health").then((r) =>
      r.json()
    );
    console.log("Server health:", JSON.stringify(health));
    if (!health.extensionConnected) {
      console.error("\n✗ Extension is NOT connected. Aborting.");
      process.exit(1);
    }
    console.log("✓ Extension connected\n");
  } catch {
    console.error("✗ Server not reachable. Is it running?");
    process.exit(1);
  }

  console.log("Sending request… (this may take 30-90 seconds)\n");
  const start = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-bridge",
        messages: test.messages,
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
    console.log(`✓ Response received in ${elapsed}s`);
    console.log(`  Output length: ${content.length} chars`);
    console.log(`  Finish reason: ${data.choices?.[0]?.finish_reason}\n`);
    console.log("═".repeat(60));
    console.log(content);
    console.log("═".repeat(60));
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.error(`✗ Failed after ${elapsed}s:`, err.message);
    process.exit(1);
  }
}

main();

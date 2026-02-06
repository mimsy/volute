import { checkHealth } from "./variants.js";

/**
 * Verify a server by checking health and sending a test message.
 */
export async function verify(port: number): Promise<boolean> {
  // Health check
  const health = await checkHealth(port);
  if (!health.ok) {
    console.error("  Health check: failed");
    return false;
  }
  console.log("  Health check: OK");

  // Send test message
  try {
    const res = await fetch(`http://localhost:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "ping" }],
        channel: "system",
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok || !res.body) {
      console.error("  Test message: failed to send");
      return false;
    }

    // Read ndjson stream looking for a done event
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let gotDone = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "done") {
            gotDone = true;
          }
        } catch {
          // skip invalid lines
        }
      }

      if (gotDone) {
        reader.cancel();
        break;
      }
    }

    if (gotDone) {
      console.log("  Test message: OK");
      return true;
    } else {
      console.error("  Test message: no done event received");
      return false;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  Test message: ${msg}`);
    return false;
  }
}

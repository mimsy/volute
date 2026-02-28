import { checkHealth } from "@volute/shared/variants";

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
    const res = await fetch(`http://127.0.0.1:${port}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: [{ type: "text", text: "ping" }],
        channel: "system",
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error("  Test message: failed to send");
      return false;
    }

    const result = (await res.json()) as { ok?: boolean };
    if (result.ok) {
      console.log("  Test message: OK");
      return true;
    } else {
      console.error("  Test message: unexpected response");
      return false;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  Test message: ${msg}`);
    return false;
  }
}

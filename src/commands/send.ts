import { resolveAgent } from "../lib/registry.js";

export async function run(args: string[]) {
  const name = args[0];
  const message = args[1];

  if (!name || !message) {
    console.error('Usage: molt send <name> "<message>"');
    process.exit(1);
  }

  const { entry } = resolveAgent(name);
  const baseUrl = `http://localhost:${entry.port}`;

  // Connect SSE first
  const abortController = new AbortController();
  const sseResponse = await fetch(`${baseUrl}/events`, { signal: abortController.signal });
  const reader = sseResponse.body?.getReader();
  if (!reader) {
    console.error("Failed to connect SSE");
    process.exit(1);
  }

  // Send the message
  const postRes = await fetch(`${baseUrl}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });

  if (!postRes.ok) {
    console.error(`Failed to send message: ${postRes.status} ${postRes.statusText}`);
    reader.cancel().catch(() => {});
    process.exit(1);
  }

  // Read SSE events until done
  const decoder = new TextDecoder();
  let buffer = "";
  const inactivityMs = 5 * 60 * 1000; // 5 minutes — tools can take a while
  let lastRealData = Date.now();
  let pendingRead: ReturnType<typeof reader.read> | null = null;

  try {
    while (true) {
      if (!pendingRead) {
        pendingRead = reader.read();
      }

      const checkPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), 2000),
      );

      const result = await Promise.race([pendingRead, checkPromise]);

      if (result === null) {
        if (Date.now() - lastRealData > inactivityMs) {
          break;
        }
        continue;
      }

      pendingRead = null;
      const { done, value } = result;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let gotDone = false;
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          lastRealData = Date.now();
          try {
            const data = JSON.parse(line.slice(6));
            if (data.done) {
              gotDone = true;
              break;
            }
            if (data.role === "assistant" && data.blocks) {
              for (const block of data.blocks) {
                if (block.type === "text") {
                  process.stdout.write(block.text);
                }
              }
            }
          } catch {
            // skip non-JSON lines
          }
        }
      }
      if (gotDone) break;
    }
  } finally {
    reader.cancel().catch(() => {});
    abortController.abort();
  }

  // Ensure trailing newline
  process.stdout.write("\n");
}

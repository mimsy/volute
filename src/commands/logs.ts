import { daemonFetch } from "../lib/daemon-client.js";
import { parseArgs } from "../lib/parse-args.js";
import { resolveAgentName } from "../lib/resolve-agent-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    agent: { type: "string" },
    follow: { type: "boolean" },
    n: { type: "number" },
  });

  const name = resolveAgentName(flags);

  if (flags.follow) {
    const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/logs`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(body.error ?? `Server responded with ${res.status}`);
      process.exit(1);
    }

    // Parse SSE stream
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop()!;

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            process.stdout.write(line.slice(6) + "\n");
          }
        }
      }
    } catch {
      // Stream closed
    }
  } else {
    const n = flags.n ?? 50;
    const res = await daemonFetch(`/api/agents/${encodeURIComponent(name)}/logs/tail?n=${n}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(body.error ?? `Server responded with ${res.status}`);
      process.exit(1);
    }
    console.log(await res.text());
  }
}

import { getClient, urlOf } from "../lib/api-client.js";
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
  const client = getClient();

  if (flags.follow) {
    // SSE streaming - use daemonFetch since hono/client can't handle streaming
    const res = await daemonFetch(urlOf(client.api.agents[":name"].logs.$url({ param: { name } })));
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
            process.stdout.write(`${line.slice(6)}\n`);
          }
        }
      }
    } catch {
      // Stream closed
    }
  } else {
    const n = flags.n ?? 50;
    const url = client.api.agents[":name"].logs.tail.$url({ param: { name } });
    url.searchParams.set("n", String(n));

    const res = await daemonFetch(urlOf(url));
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      console.error(body.error ?? `Server responded with ${res.status}`);
      process.exit(1);
    }
    console.log(await res.text());
  }
}

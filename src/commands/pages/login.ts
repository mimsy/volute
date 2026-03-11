import { daemonFetch } from "../../lib/daemon-client.js";
import { parseArgs } from "../../lib/parse-args.js";
import { promptLine } from "../../lib/prompt.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    key: { type: "string" },
  });

  let key = flags.key;
  if (!key) {
    if (!process.stdin.isTTY) {
      console.error("Usage: volute systems login --key <api-key>");
      process.exit(1);
    }
    key = await promptLine("API key: ");
    if (!key) {
      console.error("No key provided.");
      process.exit(1);
    }
  }

  const res = await daemonFetch("/api/system/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Login failed: ${body.error}`);
    process.exit(1);
  }

  const { system } = (await res.json()) as { system: string };
  console.log(`Logged in as "${system}". Credentials saved.`);
}

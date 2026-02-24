import { parseArgs } from "../../lib/parse-args.js";
import { promptLine } from "../../lib/prompt.js";
import { readSystemsConfig, writeSystemsConfig } from "../../lib/systems-config.js";
import { systemsFetch } from "../../lib/systems-fetch.js";

const DEFAULT_API_URL = "https://volute.systems";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    key: { type: "string" },
  });

  const existing = readSystemsConfig();
  if (existing) {
    console.error(`Already logged in as "${existing.system}". Run "volute auth logout" first.`);
    process.exit(1);
  }

  let key = flags.key;
  if (!key) {
    if (!process.stdin.isTTY) {
      console.error("Usage: volute pages login --key <api-key>");
      process.exit(1);
    }
    key = await promptLine("API key: ");
    if (!key) {
      console.error("No key provided.");
      process.exit(1);
    }
  }

  const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;

  const res = await systemsFetch(`${apiUrl}/api/whoami`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Login failed: ${body.error}`);
    process.exit(1);
  }

  const { system } = (await res.json()) as { system: string };
  writeSystemsConfig({ apiKey: key, system, apiUrl });
  console.log(`Logged in as "${system}". Credentials saved.`);
}

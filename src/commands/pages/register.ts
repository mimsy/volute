import { parseArgs } from "@volute/shared/parse-args";
import { readSystemsConfig, writeSystemsConfig } from "@volute/shared/systems-config";
import { promptLine } from "../../lib/prompt.js";
import { systemsFetch } from "../../lib/systems-fetch.js";

const DEFAULT_API_URL = "https://volute.systems";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    name: { type: "string" },
  });

  const existing = readSystemsConfig();
  if (existing) {
    console.error(`Already registered as "${existing.system}". Run "volute auth logout" first.`);
    process.exit(1);
  }

  let name = flags.name;
  if (!name) {
    if (!process.stdin.isTTY) {
      console.error("Usage: volute auth register --name <system-name>");
      process.exit(1);
    }
    name = await promptLine("Choose a system name: ");
    if (!name) {
      console.error("No name provided.");
      process.exit(1);
    }
  }

  const apiUrl = process.env.VOLUTE_SYSTEMS_URL || DEFAULT_API_URL;

  const res = await systemsFetch(`${apiUrl}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Registration failed: ${body.error}`);
    process.exit(1);
  }

  const { apiKey, system } = (await res.json()) as { apiKey: string; system: string };
  try {
    writeSystemsConfig({ apiKey, system, apiUrl });
  } catch (err) {
    console.error(`Failed to save credentials: ${(err as Error).message}`);
    console.error(`Your API key is: ${apiKey}`);
    console.error(`Save it and run: volute auth login --key ${apiKey}`);
    process.exit(1);
  }
  console.log(`Registered as "${system}". Credentials saved.`);
}

import { readPagesConfig, writePagesConfig } from "../../lib/pages-config.js";
import { parseArgs } from "../../lib/parse-args.js";

const DEFAULT_API_URL = "https://pages.volute.dev";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    key: { type: "string" },
  });

  const existing = readPagesConfig();
  if (existing) {
    console.error(`Already logged in as "${existing.system}". Run "volute pages logout" first.`);
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

  const apiUrl = process.env.VOLUTE_PAGES_URL || DEFAULT_API_URL;

  const res = await fetch(`${apiUrl}/api/whoami`, {
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
  writePagesConfig({ apiKey: key, system, apiUrl });
  console.log(`Logged in as "${system}". Credentials saved.`);
}

function promptLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let value = "";
    const onData = (buf: Buffer) => {
      for (const byte of buf) {
        if (byte === 3) {
          process.stderr.write("\n");
          process.exit(1);
        }
        if (byte === 13 || byte === 10) {
          process.stderr.write("\n");
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdin.pause();
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
        } else {
          value += String.fromCharCode(byte);
        }
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

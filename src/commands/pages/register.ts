import { readPagesConfig, writePagesConfig } from "../../lib/pages-config.js";
import { parseArgs } from "../../lib/parse-args.js";

const DEFAULT_API_URL = "https://pages.volute.dev";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    name: { type: "string" },
  });

  const existing = readPagesConfig();
  if (existing) {
    console.error(`Already registered as "${existing.system}". Run "volute pages logout" first.`);
    process.exit(1);
  }

  let name = flags.name;
  if (!name) {
    if (!process.stdin.isTTY) {
      console.error("Usage: volute pages register --name <system-name>");
      process.exit(1);
    }
    name = await promptLine("Choose a system name: ");
    if (!name) {
      console.error("No name provided.");
      process.exit(1);
    }
  }

  const apiUrl = process.env.VOLUTE_PAGES_URL || DEFAULT_API_URL;

  const res = await fetch(`${apiUrl}/api/register`, {
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
  writePagesConfig({ apiKey, system, apiUrl });
  console.log(`Registered as "${system}". Credentials saved.`);
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

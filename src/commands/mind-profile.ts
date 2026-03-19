import { parseArgs } from "../lib/parse-args.js";
import { resolveMindName } from "../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
    "display-name": { type: "string" },
    description: { type: "string" },
    avatar: { type: "string" },
  });

  const name = resolveMindName(flags);

  const displayName = flags["display-name"];
  const description = flags.description;
  const avatar = flags.avatar;

  if (!displayName && !description && !avatar) {
    console.error(
      "Usage: volute mind profile [--mind <name>] [--display-name <name>] [--description <text>] [--avatar <path>]",
    );
    process.exit(1);
  }

  const { daemonFetch } = await import("../lib/daemon-client.js");

  const body: Record<string, string> = {};
  if (displayName) body.displayName = displayName;
  if (description) body.description = description;
  if (avatar) body.avatar = avatar;

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(name)}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    console.error(data.error ?? `Failed to update profile (HTTP ${res.status})`);
    process.exit(1);
  }

  console.log(`Profile updated for ${name}`);
}

import { daemonFetch } from "../../lib/daemon-client.js";
import { isCompact } from "../../lib/format-cli.js";
import { parseArgs } from "../../lib/parse-args.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const mindName = resolveMindName(flags);

  const res = await daemonFetch(`/api/minds/${encodeURIComponent(mindName)}/conversations`);
  if (!res.ok) {
    console.error(`Failed to list conversations: ${res.status}`);
    process.exit(1);
  }

  const convs = (await res.json()) as {
    id: string;
    title: string | null;
    type: string;
    name: string | null;
    updated_at: string;
  }[];

  if (convs.length === 0) {
    console.log("No conversations.");
    return;
  }

  const compact = isCompact();
  for (const conv of convs) {
    const label = conv.type === "channel" ? `#${conv.name}` : (conv.title ?? conv.id.slice(0, 8));
    if (compact) {
      console.log(`${label} (${conv.type})`);
    } else {
      const time = new Date(
        conv.updated_at.endsWith("Z") ? conv.updated_at : `${conv.updated_at}Z`,
      ).toLocaleString();
      console.log(`  ${label}  (${conv.type})  ${time}`);
    }
  }
}

import { formatFileSize } from "@volute/daemon/lib/chat/file-sharing.js";
import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";

const cmd = command({
  name: "volute chat files",
  description: "List pending incoming files",
  flags: {
    mind: { type: "string", description: "Mind name" },
  },
  async run({ flags }) {
    const mind = resolveMindName(flags);

    const res = await daemonFetch(`/api/minds/${encodeURIComponent(mind)}/files/pending`);

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      console.error(data.error ?? `Failed to list pending files: ${res.status}`);
      process.exit(1);
    }

    const pending = (await res.json()) as Array<{
      id: string;
      sender: string;
      filename: string;
      size: number;
      createdAt: string;
    }>;

    if (pending.length === 0) {
      console.log("No pending files.");
      return;
    }

    const idW = Math.max(2, ...pending.map((p) => p.id.length));
    const senderW = Math.max(6, ...pending.map((p) => p.sender.length));
    const fileW = Math.max(4, ...pending.map((p) => p.filename.length));

    console.log(`${"ID".padEnd(idW)}  ${"SENDER".padEnd(senderW)}  ${"FILE".padEnd(fileW)}  SIZE`);
    for (const p of pending) {
      console.log(
        `${p.id.padEnd(idW)}  ${p.sender.padEnd(senderW)}  ${p.filename.padEnd(fileW)}  ${formatFileSize(p.size)}`,
      );
    }
  },
});

export const run = cmd.execute;

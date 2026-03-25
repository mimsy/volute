import { command } from "../../lib/command.js";
import { daemonFetch } from "../../lib/daemon-client.js";

const cmd = command({
  name: "volute systems logout",
  description: "Remove stored volute.systems credentials",
  flags: {},
  run: async () => {
    const res = await daemonFetch("/api/system/logout", { method: "POST" });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`Logout failed: ${body.error}`);
      process.exit(1);
    }

    console.log("Logged out. Credentials removed.");
  },
});

export const run = cmd.execute;

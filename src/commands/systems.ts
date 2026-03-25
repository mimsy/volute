import { subcommands } from "../lib/command.js";
import { daemonFetch } from "../lib/daemon-client.js";

async function showStatus() {
  const res = await daemonFetch("/api/system/info");
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Failed to get system info: ${body.error}`);
    process.exit(1);
  }
  const { system } = (await res.json()) as { system: string | null };
  if (!system) {
    console.log("Not connected to volute.systems");
    console.log('Run "volute systems register" or "volute systems login" to connect.');
    return;
  }
  console.log(`System: ${system}`);
}

const cmd = subcommands({
  name: "volute systems",
  description: "Manage volute.systems account",
  commands: {
    status: {
      description: "Show volute.systems account info",
      run: async () => showStatus(),
    },
    register: {
      description: "Register a system on volute.systems",
      run: (args) => import("./systems/register.js").then((m) => m.run(args)),
    },
    login: {
      description: "Log in with an existing API key",
      run: (args) => import("./systems/login.js").then((m) => m.run(args)),
    },
    logout: {
      description: "Remove stored credentials",
      run: (args) => import("./systems/logout.js").then((m) => m.run(args)),
    },
  },
});

export const run = cmd.execute;

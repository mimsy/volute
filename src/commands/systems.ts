import { daemonFetch } from "../lib/daemon-client.js";

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "status":
      await showStatus();
      break;
    case "register":
      await import("./pages/register.js").then((m) => m.run(args.slice(1)));
      break;
    case "login":
      await import("./pages/login.js").then((m) => m.run(args.slice(1)));
      break;
    case "logout":
      await import("./pages/logout.js").then((m) => m.run());
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      console.error(`\nUnknown subcommand: ${subcommand}`);
      process.exit(1);
  }
}

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

function printUsage() {
  console.log(`Usage:
  volute systems status                    Show volute.systems account info
  volute systems register [--name <name>]  Register a system on volute.systems
  volute systems login [--key <key>]       Log in with an existing API key
  volute systems logout                    Remove stored credentials`);
}

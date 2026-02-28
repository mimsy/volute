import { homedir } from "node:os";
import { resolve } from "node:path";

if (!process.env.VOLUTE_HOME) {
  process.env.VOLUTE_HOME = resolve(homedir(), ".volute");
}

const command = process.argv[2];
const args = process.argv.slice(3);

if (command === "--version" || command === "-v") {
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  console.log(pkg.version);
  process.exit(0);
}

switch (command) {
  case "mind":
    await import("./commands/mind.js").then((m) => m.run(args));
    break;
  case "send":
    await import("./commands/send.js").then((m) => m.run(args));
    break;
  case "history":
    await import("./commands/history.js").then((m) => m.run(args));
    break;
  case "variant":
    await import("./commands/variant.js").then((m) => m.run(args));
    break;
  case "channel":
    await import("./commands/channel.js").then((m) => m.run(args));
    break;
  case "schedule":
    await import("./commands/schedule.js").then((m) => m.run(args));
    break;
  case "skill":
    await import("./commands/skill.js").then((m) => m.run(args));
    break;
  case "shared":
    await import("./commands/shared.js").then((m) => m.run(args));
    break;
  case "file":
    await import("./commands/file.js").then((m) => m.run(args));
    break;
  case "env":
    await import("./commands/env.js").then((m) => m.run(args));
    break;
  case "up":
    await import("./commands/up.js").then((m) => m.run(args));
    break;
  case "down":
    await import("./commands/down.js").then((m) => m.run(args));
    break;
  case "restart":
    await import("./commands/daemon-restart.js").then((m) => m.run(args));
    break;
  case "service":
    await import("./commands/service.js").then((m) => m.run(args));
    break;
  case "update":
    await import("./commands/update.js").then((m) => m.run(args));
    break;
  case "status":
    await import("./commands/status.js").then((m) => m.run(args));
    break;
  case "pages":
    await import("./commands/pages.js").then((m) => m.run(args));
    break;
  case "auth":
    await import("./commands/auth.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(`volute — create and manage AI minds

Common:
  send <target> "<msg>"            Send a message
  history [--channel <ch>]         View activity history
  status                           Show system status

Mind:
  mind create <name>               Create a new mind
  mind seed <name>                 Plant a seed mind (orientation mode)
  mind start/stop/restart [name]   Control a mind
  mind list                        List all minds
  mind status [name]               Check a mind's status
  mind connect/disconnect <type>   Manage connectors
  mind logs [name] [--follow]      Tail mind logs
  mind sprout                      Complete orientation
  mind upgrade/import/export       Lifecycle operations

Configuration:
  channel   Read, list, and manage channels
  variant   Create and merge experimental variants
  schedule  Manage cron schedules
  skill     Browse and install skills
  env       Manage environment variables
  file      Mind-to-mind file sharing
  shared    Collaborative shared repository
  pages     Publish web pages

System:
  up / down / restart              Daemon control
  update                           Update volute
  service install/uninstall        Auto-start service
  auth register/login/logout       volute.systems account

Options:
  --version, -v                    Show version number
  --help, -h                       Show this help message

Run 'volute <command> --help' for details.

Mind-scoped commands (send, history, variant, schedule, channel, file, skill, shared, pages)
use --mind <name> or VOLUTE_MIND env var to identify the mind.`);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun 'volute --help' for usage.`);
    process.exit(1);
}

// Non-blocking update check (prints to stderr so it doesn't interfere with piped output)
if (command !== "update") {
  import("@volute/shared/update-check")
    .then((m) => m.checkForUpdate())
    .then((result) => {
      if (result.updateAvailable) {
        console.error(`\n  Update available: ${result.current} → ${result.latest}`);
        console.error("  Run `volute update` to update\n");
      }
    })
    .catch(() => {});
}

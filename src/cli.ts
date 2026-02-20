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
  case "connector":
    await import("./commands/connector.js").then((m) => m.run(args));
    break;
  case "channel":
    await import("./commands/channel.js").then((m) => m.run(args));
    break;
  case "schedule":
    await import("./commands/schedule.js").then((m) => m.run(args));
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
  case "setup":
    await import("./commands/setup.js").then((m) => m.run(args));
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
  case "seed":
    await import("./commands/seed.js").then((m) => m.run(args));
    break;
  case "sprout":
    await import("./commands/sprout.js").then((m) => m.run(args));
    break;
  case "pages":
    await import("./commands/pages.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(`volute — create and manage AI minds

Commands:
  volute mind create <name>              Create a new mind
  volute mind start <name>               Start a mind (daemonized)
  volute mind stop <name>                Stop a mind
  volute mind restart <name>             Restart a mind
  volute mind delete <name> [--force]    Delete a mind (--force removes files)
  volute mind list                       List all minds
  volute mind status <name>              Check mind status
  volute mind logs <name> [--follow]     Tail mind logs
  volute mind upgrade <name>             Upgrade mind to latest template
  volute mind import <path>              Import an OpenClaw workspace

  volute send <target> "<msg>"             Send a message (mind DM, channel, etc.)
  volute history [--mind <name>]          View message history

  volute variant create <name>            Create a variant (worktree + server)
  volute variant list                     List variants for a mind
  volute variant merge <name>             Merge a variant back
  volute variant delete <name>            Delete a variant

  volute connector connect <type>         Enable a connector for a mind
  volute connector disconnect <type>      Disable a connector for a mind

  volute channel read <uri>               Read recent messages from a channel
  volute channel list [<platform>]        List conversations on a platform
  volute channel users <platform>         List users on a platform
  volute channel create <platform> ...    Create a conversation on a platform

  volute schedule list                    List schedules for a mind
  volute schedule add ...                 Add a cron schedule
  volute schedule remove ...              Remove a schedule

  volute env <set|get|list|remove>        Manage environment variables

  volute up [--port N]                    Start the daemon (default: 4200)
  volute down                             Stop the daemon
  volute restart [--port N]               Restart the daemon

  volute service install [--port N]       Install as system service (auto-start)
  volute service uninstall                Remove system service
  volute service status                   Check service status
  volute setup [--port N] [--host H]      Install system service with user isolation
  volute setup uninstall [--force]        Remove system service + isolation

  volute pages register [--name <name>]   Register a system on volute.systems
  volute pages login [--key <key>]        Log in with an existing API key
  volute pages publish [--mind <name>]    Publish mind's pages/ directory
  volute pages status [--mind <name>]     Show publish status
  volute pages logout                     Remove stored credentials

  volute seed <name>                      Plant a seed mind (orientation mode)
  volute sprout                           Complete orientation, become a full mind

  volute update                           Update to latest version
  volute status                           Show daemon status and minds

Options:
  --version, -v                           Show version number
  --help, -h                              Show this help message

Mind-scoped commands (send, history, variant, connector, schedule, channel, pages)
use --mind <name> or VOLUTE_MIND env var to identify the mind.`);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun 'volute --help' for usage.`);
    process.exit(1);
}

// Non-blocking update check (prints to stderr so it doesn't interfere with piped output)
if (command !== "update") {
  import("./lib/update-check.js")
    .then((m) => m.checkForUpdate())
    .then((result) => {
      if (result.updateAvailable) {
        console.error(`\n  Update available: ${result.current} → ${result.latest}`);
        console.error("  Run `volute update` to update\n");
      }
    })
    .catch(() => {});
}

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
  case "agent":
    await import("./commands/agent.js").then((m) => m.run(args));
    break;
  case "message":
    await import("./commands/message.js").then((m) => m.run(args));
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
  case "setup":
    await import("./commands/setup.js").then((m) => m.run(args));
    break;
  case "service":
    await import("./commands/service.js").then((m) => m.run(args));
    break;
  case "update":
    await import("./commands/update.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(`volute — create and manage AI agents

Commands:
  volute agent create <name>              Create a new agent
  volute agent start <name>               Start an agent (daemonized)
  volute agent stop <name>                Stop an agent
  volute agent delete <name> [--force]    Delete an agent (--force removes files)
  volute agent list                       List all agents
  volute agent status <name>              Check agent status
  volute agent logs <name> [--follow]     Tail agent logs
  volute agent upgrade <name>             Upgrade agent to latest template
  volute agent import <path>              Import an OpenClaw workspace

  volute message send <name> "<msg>"      Send a message to an agent
  volute message history [--agent <name>] View message history

  volute variant create <name>            Create a variant (worktree + server)
  volute variant list                     List variants for an agent
  volute variant merge <name>             Merge a variant back
  volute variant delete <name>            Delete a variant

  volute connector connect <type>         Enable a connector for an agent
  volute connector disconnect <type>      Disable a connector for an agent

  volute channel read <uri>               Read recent messages from a channel
  volute channel send <uri> "<msg>"       Send a message to a channel

  volute schedule list                    List schedules for an agent
  volute schedule add ...                 Add a cron schedule
  volute schedule remove ...              Remove a schedule

  volute env <set|get|list|remove>        Manage environment variables

  volute up [--port N]                    Start the daemon (default: 4200)
  volute down                             Stop the daemon

  volute service install [--port N]       Install as system service (auto-start)
  volute service uninstall                Remove system service
  volute service status                   Check service status
  volute setup [--port N] [--host H]      Install system service with user isolation
  volute setup uninstall [--force]        Remove system service + isolation

  volute update                           Check for updates

Options:
  --version, -v                           Show version number
  --help, -h                              Show this help message

Agent-scoped commands (variant, connector, schedule, channel, message history)
use --agent <name> or VOLUTE_AGENT env var to identify the agent.`);
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

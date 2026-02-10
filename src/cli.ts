const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "create":
    await import("./commands/create.js").then((m) => m.run(args));
    break;
  case "start":
    await import("./commands/start.js").then((m) => m.run(args));
    break;
  case "stop":
    await import("./commands/stop.js").then((m) => m.run(args));
    break;
  case "logs":
    await import("./commands/logs.js").then((m) => m.run(args));
    break;
  case "status":
    await import("./commands/status.js").then((m) => m.run(args));
    break;
  case "variant":
    await import("./commands/variant.js").then((m) => m.run(args));
    break;
  case "send":
    await import("./commands/send.js").then((m) => m.run(args));
    break;
  case "import":
    await import("./commands/import.js").then((m) => m.run(args));
    break;
  case "delete":
    await import("./commands/delete.js").then((m) => m.run(args));
    break;
  case "env":
    await import("./commands/env.js").then((m) => m.run(args));
    break;
  case "connector":
    await import("./commands/connector.js").then((m) => m.run(args));
    break;
  case "channel":
    await import("./commands/channel.js").then((m) => m.run(args));
    break;
  case "upgrade":
    await import("./commands/upgrade.js").then((m) => m.run(args));
    break;
  case "up":
    await import("./commands/up.js").then((m) => m.run(args));
    break;
  case "down":
    await import("./commands/down.js").then((m) => m.run(args));
    break;
  case "schedule":
    await import("./commands/schedule.js").then((m) => m.run(args));
    break;
  case "history":
    await import("./commands/history.js").then((m) => m.run(args));
    break;
  case "service":
    await import("./commands/service.js").then((m) => m.run(args));
    break;
  case "setup":
    await import("./commands/setup.js").then((m) => m.run(args));
    break;
  default:
    console.log(`volute — create and manage AI agents

Commands:
  volute create <name>                  Create a new agent
  volute start <name>                   Start an agent (daemonized)
  volute stop <name>                    Stop an agent
  volute status [<name>]                Check agent status (or list all)
  volute logs [--agent <name>]          Tail agent logs
  volute send <name> "<msg>"            Send a message to an agent
  volute variant create <name>          Create a variant (worktree + server)
  volute variant list                   List variants for an agent
  volute variant merge <name>           Merge a variant back
  volute import <path>                  Import an OpenClaw workspace
  volute env <set|get|list|remove>      Manage environment variables
  volute connector connect <type>       Enable a connector for an agent
  volute connector disconnect <type>    Disable a connector for an agent
  volute channel read <uri>             Read recent messages from a channel
  volute channel send <uri> "<msg>"     Send a message to a channel
  volute schedule list                  List schedules for an agent
  volute schedule add ...               Add a cron schedule
  volute schedule remove ...            Remove a schedule
  volute history                        View message history
  volute up [--port N]                  Start the daemon (default: 4200)
  volute down                           Stop the daemon
  volute upgrade <name>                 Upgrade agent to latest template
  volute delete <name> [--force]        Delete an agent (--force removes files)
  volute service install [--port N]     Install as system service (auto-start)
  volute service uninstall              Remove system service
  volute service status                 Check service status
  volute setup [--port N] [--host H]   Install system service with user isolation
  volute setup uninstall [--force]     Remove system service + isolation

Agent commands (variant, connector, schedule, logs, history, channel) use
--agent <name> or VOLUTE_AGENT env var to identify the agent.`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}

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
  case "fork":
    await import("./commands/fork.js").then((m) => m.run(args));
    break;
  case "variants":
    await import("./commands/variants.js").then((m) => m.run(args));
    break;
  case "send":
    await import("./commands/send.js").then((m) => m.run(args));
    break;
  case "merge":
    await import("./commands/merge.js").then((m) => m.run(args));
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
  case "connect":
    await import("./commands/connect.js").then((m) => m.run(args));
    break;
  case "disconnect":
    await import("./commands/disconnect.js").then((m) => m.run(args));
    break;
  case "channel":
    await import("./commands/channel.js").then((m) => m.run(args));
    break;
  case "upgrade":
    await import("./commands/upgrade.js").then((m) => m.run(args));
    break;
  default:
    console.log(`molt — create and manage AI agents

Commands:
  molt create <name>               Create a new agent
  molt start <name>                Start an agent (daemonized)
  molt stop <name>                 Stop an agent
  molt status [<name>]             Check agent status (or list all)
  molt logs <name>                 Tail agent logs
  molt send <name> "<msg>"         Send a message to an agent
  molt fork <name> <variant>       Create a variant (worktree + server)
  molt variants <name>             List variants for an agent
  molt merge <name> <variant>      Merge a variant back
  molt import <path>               Import an OpenClaw workspace
  molt env <set|get|list|remove>   Manage environment variables
  molt connect discord <name>      Connect a Discord bot to an agent (daemonized)
  molt disconnect discord <name>   Stop a Discord bot connector
  molt channel read <uri>          Read recent messages from a channel
  molt channel send <uri> "<msg>"  Send a message to a channel
  molt upgrade <name>              Upgrade agent to latest template
  molt delete <name> [--force]     Delete an agent (--force removes files)`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}

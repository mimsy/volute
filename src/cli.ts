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
  case "chat":
    await import("./commands/chat.js").then((m) => m.run(args));
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
  case "memory":
    await import("./commands/memory.js").then((m) => m.run(args));
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
  default:
    console.log(`molt — create and manage AI agents

Commands:
  molt create <name>               Create a new agent
  molt start <name>                Start an agent (daemonized)
  molt stop <name>                 Stop an agent
  molt status [<name>]             Check agent status (or list all)
  molt logs <name>                 Tail agent logs
  molt chat <name>                 Chat with a running agent
  molt send <name> "<msg>"         Send a message to an agent
  molt memory <name> "<context>"   Send context for the agent to remember
  molt fork <name> <variant>       Create a variant (worktree + server)
  molt variants <name>             List variants for an agent
  molt merge <name> <variant>      Merge a variant back
  molt import <path>               Import an OpenClaw workspace
  molt env <set|get|list|remove>   Manage environment variables
  molt delete <name> [--force]     Delete an agent (--force removes files)`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}

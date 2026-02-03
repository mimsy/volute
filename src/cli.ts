const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case "create":
    await import("./commands/create.js").then((m) => m.run(args));
    break;
  case "start":
    await import("./commands/start.js").then((m) => m.run(args));
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
  default:
    console.log(`molt — create and manage AI agents

Commands:
  molt create <name>    Create a new agent project
  molt start            Start the agent supervisor (run from agent dir)
  molt chat             Chat with a running agent
  molt status           Check agent health
  molt fork <name>      Create a variant (worktree + server)
  molt variants         List all variants
  molt send             Send a message to a variant
  molt merge <name>     Merge a variant back
  molt memory           Send context for the agent to remember`);
    if (command) {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
}

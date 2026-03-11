export async function run(args: string[]) {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "send":
      await import("./chat/send.js").then((m) => m.run(subArgs));
      break;
    case "list":
      await import("./chat/list.js").then((m) => m.run(subArgs));
      break;
    case "read":
      await import("./chat/read.js").then((m) => m.run(subArgs));
      break;
    case "create":
      await import("./chat/create.js").then((m) => m.run(subArgs));
      break;
    case "bridge":
      await import("./chat/bridge.js").then((m) => m.run(subArgs));
      break;
    case "--help":
    case "-h":
    case undefined:
      console.log(`volute chat — conversations and bridges

Messages:
  send <target> "<msg>"          Send a message
  list                           List conversations
  read <conversation> [--limit]  Read conversation messages
  create --participants u1,u2    Create a conversation

Bridges:
  bridge add <platform>          Set up a bridge
  bridge remove <platform>       Remove a bridge
  bridge list                    Show bridges + status
  bridge map <p>:<ch> <volute>   Map external → Volute channel
  bridge unmap <p>:<ch>          Remove mapping
  bridge mappings [<platform>]   List mappings

Send targets: @mindname for DMs, channel-name for conversations.
Mind-scoped commands use --mind <name> or VOLUTE_MIND env var.`);
      break;
    default:
      console.error(`Unknown chat subcommand: ${subcommand}\nRun 'volute chat --help' for usage.`);
      process.exit(1);
  }
}

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
      await import("./create.js").then((m) => m.run(args.slice(1)));
      break;
    case "start":
      await import("./start.js").then((m) => m.run(args.slice(1)));
      break;
    case "stop":
      await import("./stop.js").then((m) => m.run(args.slice(1)));
      break;
    case "delete":
      await import("./delete.js").then((m) => m.run(args.slice(1)));
      break;
    case "list":
      await import("./status.js").then((m) => m.run(args.slice(1)));
      break;
    case "status": {
      const rest = args.slice(1);
      if (!rest[0] && process.env.VOLUTE_AGENT) {
        rest.unshift(process.env.VOLUTE_AGENT);
      }
      await import("./status.js").then((m) => m.run(rest));
      break;
    }
    case "logs": {
      // Transform positional name to --agent flag for compatibility
      const rest = args.slice(1);
      const logsArgs = transformAgentFlag(rest);
      await import("./logs.js").then((m) => m.run(logsArgs));
      break;
    }
    case "upgrade":
      await import("./upgrade.js").then((m) => m.run(args.slice(1)));
      break;
    case "import":
      await import("./import.js").then((m) => m.run(args.slice(1)));
      break;
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

/** If first arg is a positional name (not a flag), inject as --agent <name>. */
function transformAgentFlag(args: string[]): string[] {
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return ["--agent", args[0], ...args.slice(1)];
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  volute agent create <name> [--template <name>]
  volute agent start <name>
  volute agent stop [name]
  volute agent delete [name] [--force]
  volute agent list
  volute agent status [name]
  volute agent logs [name] [--follow] [-n N]
  volute agent upgrade [name] [--template <name>] [--continue]
  volute agent import <path> [--name <name>] [--session <path>] [--template <name>]

Agent name can be omitted (where shown as [name]) if VOLUTE_AGENT is set.`);
}

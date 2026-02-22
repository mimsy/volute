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
    case "restart":
      await import("./restart.js").then((m) => m.run(args.slice(1)));
      break;
    case "delete":
      await import("./delete.js").then((m) => m.run(args.slice(1)));
      break;
    case "list":
      await import("./status.js").then((m) => m.run(args.slice(1)));
      break;
    case "status": {
      const rest = args.slice(1);
      if (!rest[0] && process.env.VOLUTE_MIND) {
        rest.unshift(process.env.VOLUTE_MIND);
      }
      await import("./status.js").then((m) => m.run(rest));
      break;
    }
    case "logs": {
      // Transform positional name to --mind flag for compatibility
      const rest = args.slice(1);
      const logsArgs = transformMindFlag(rest);
      await import("./logs.js").then((m) => m.run(logsArgs));
      break;
    }
    case "upgrade":
      await import("./upgrade.js").then((m) => m.run(args.slice(1)));
      break;
    case "import":
      await import("./import.js").then((m) => m.run(args.slice(1)));
      break;
    case "export":
      await import("./export.js").then((m) => m.run(args.slice(1)));
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

/** If first arg is a positional name (not a flag), inject as --mind <name>. */
function transformMindFlag(args: string[]): string[] {
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return ["--mind", args[0], ...args.slice(1)];
  }
  return args;
}

function printUsage() {
  console.log(`Usage:
  volute mind create <name> [--template <name>]
  volute mind start <name>
  volute mind stop [name]
  volute mind restart [name]
  volute mind delete [name] [--force]
  volute mind list
  volute mind status [name]
  volute mind logs [name] [--follow] [-n N]
  volute mind upgrade [name] [--template <name>] [--continue]
  volute mind import <path> [--name <name>] [--session <path>] [--template <name>]
  volute mind export <name> [--include-env] [--include-identity] [--include-connectors] [--include-history] [--include-sessions] [--all] [--output <path>]

Mind name can be omitted (where shown as [name]) if VOLUTE_MIND is set.`);
}

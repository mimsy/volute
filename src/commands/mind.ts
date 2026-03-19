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
      await import("./mind-list.js").then((m) => m.run(args.slice(1)));
      break;
    case "status":
      await import("./mind-status.js").then((m) => m.run(args.slice(1)));
      break;
    case "history": {
      const rest = args.slice(1);
      const historyArgs = transformMindFlag(rest);
      await import("./history.js").then((m) => m.run(historyArgs));
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
    case "seed":
      await import("./seed.js").then((m) => m.run(args.slice(1)));
      break;
    case "sprout":
      await import("./sprout.js").then((m) => m.run(args.slice(1)));
      break;
    case "profile":
      await import("./mind-profile.js").then((m) => m.run(args.slice(1)));
      break;
    case "sleep":
      // Legacy alias — redirect to clock sleep
      await import("./mind-sleep.js").then((m) => m.run(args.slice(1)));
      break;
    case "wake":
      // Legacy alias — redirect to clock wake
      await import("./mind-wake.js").then((m) => m.run(args.slice(1)));
      break;
    case "split":
      await import("./split.js").then((m) => m.run(args.slice(1)));
      break;
    case "join":
      await import("./join.js").then((m) => m.run(args.slice(1)));
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
  volute mind seed <name> [--template <name>]
  volute mind start <name>
  volute mind stop [name]
  volute mind restart [name]
  volute mind delete [name] [--force]
  volute mind list
  volute mind status [name]
  volute mind history [name] [--channel <ch>] [--limit N] [--full]
  volute mind profile [--mind <name>] [--display-name <name>] [--description <text>] [--avatar <path>]
  volute mind sprout
  volute mind sleep [name] [--wake-at <time>]
  volute mind wake [name]
  volute mind split <name> [--from <mind>] [--soul "..."] [--port N] [--no-start] [--json]
  volute mind join <variant-name> [--summary "..." --justification "..." --memory "..."] [--skip-verify]
  volute mind upgrade [name] [--template <name>] [--diff] [--continue] [--abort]
  volute mind import <path> [--name <name>] [--session <path>] [--template <name>]
  volute mind export <name> [--include-env] [--include-identity] [--include-history] [--include-sessions] [--all] [--output <path>]

Mind name can be omitted (where shown as [name]) if VOLUTE_MIND is set.

Note: 'volute mind seed' and 'volute mind sprout' are now 'volute seed create' and 'volute seed sprout'.`);
}

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "merge":
      await import("./shared/merge.js").then((m) => m.run(args.slice(1)));
      break;
    case "pull":
      await import("./shared/pull.js").then((m) => m.run(args.slice(1)));
      break;
    case "log":
      await import("./shared/log.js").then((m) => m.run(args.slice(1)));
      break;
    case "status":
      await import("./shared/status.js").then((m) => m.run(args.slice(1)));
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

function printUsage() {
  console.log(`Usage:
  volute shared merge "<message>" [--mind <name>]   Merge shared changes to main
  volute shared pull [--mind <name>]                Pull latest shared changes
  volute shared log [--limit N] [--mind <name>]     Show shared repo history
  volute shared status [--mind <name>]              Show pending changes diff`);
}

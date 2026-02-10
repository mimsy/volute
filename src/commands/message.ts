export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "send":
      await import("./send.js").then((m) => m.run(args.slice(1)));
      break;
    case "history":
      await import("./history.js").then((m) => m.run(args.slice(1)));
      break;
    default:
      printUsage();
      process.exit(subcommand ? 1 : 0);
  }
}

function printUsage() {
  console.error(`Usage:
  volute message send <name> "<msg>"
  volute message history [--agent <name>] [--channel <ch>] [--limit N]`);
}

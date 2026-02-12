export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "send":
      await import("./send.js").then((m) => m.run(args.slice(1)));
      break;
    case "history":
      await import("./history.js").then((m) => m.run(args.slice(1)));
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
  volute message send <name> "<msg>"
  echo "msg" | volute message send <name>
  volute message history [--agent <name>] [--channel <ch>] [--limit N]`);
}

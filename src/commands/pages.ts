export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "publish":
      await import("./pages/publish.js").then((m) => m.run(args.slice(1)));
      break;
    case "status":
      await import("./pages/status.js").then((m) => m.run(args.slice(1)));
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
  volute pages publish [--mind <name>]   Publish mind's pages/ directory
  volute pages status [--mind <name>]    Show publish status

Account commands (register, login, logout) are now top-level:
  volute register [--name <name>]
  volute login [--key <key>]
  volute logout`);
}

export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "register":
      await import("./pages/register.js").then((m) => m.run(args.slice(1)));
      break;
    case "login":
      await import("./pages/login.js").then((m) => m.run(args.slice(1)));
      break;
    case "publish":
      await import("./pages/publish.js").then((m) => m.run(args.slice(1)));
      break;
    case "status":
      await import("./pages/status.js").then((m) => m.run(args.slice(1)));
      break;
    case "logout":
      await import("./pages/logout.js").then((m) => m.run());
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
  volute pages register [--name <name>]  Register a system on pages.volute.dev
  volute pages login [--key <key>]       Log in with an existing API key
  volute pages publish [--mind <name>]   Publish mind's pages/ directory
  volute pages status [--mind <name>]    Show publish status
  volute pages logout                    Remove stored credentials`);
}

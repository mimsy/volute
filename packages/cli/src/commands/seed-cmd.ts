export async function run(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "create":
      await import("./seed-create.js").then((m) => m.run(args.slice(1)));
      break;
    case "sprout":
      await import("./seed-sprout.js").then((m) => m.run(args.slice(1)));
      break;
    case "check":
      await import("./seed-check.js").then((m) => m.run(args.slice(1)));
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
  console.log(`volute seed — seed lifecycle

  volute seed create <name>    Plant a new seed
  volute seed sprout           Complete orientation and become a full mind
  volute seed check <name>     Check seed readiness (used by spirit scheduler)`);
}

export async function run(args: string[]) {
  const subcommand = args[0];
  switch (subcommand) {
    case "create":
      console.error("'volute variant create' has been replaced by 'volute mind split'");
      console.error("Usage: volute mind split <name> [--from <mind>] [--soul '...'] [--no-start]");
      process.exit(1);
      break;
    case "merge":
      console.error("'volute variant merge' has been replaced by 'volute mind join'");
      console.error(
        "Usage: volute mind join <name> [--summary '...' --memory '...' --justification '...']",
      );
      process.exit(1);
      break;
    case "list":
    case "delete":
      console.error(`'volute variant ${subcommand}' is no longer available.`);
      console.error(
        "Use 'volute mind list' to see splits, or 'volute mind delete <split-name>' to delete.",
      );
      process.exit(1);
      break;
    default:
      console.error(
        "'volute variant' has been replaced. Use 'volute mind split' and 'volute mind join'.",
      );
      process.exit(1);
  }
}

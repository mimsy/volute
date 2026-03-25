import { subcommands } from "../lib/command.js";

const cmd = subcommands({
  name: "volute variant",
  description: "(deprecated) Use 'volute mind split/join' instead",
  commands: {
    create: {
      description: "(deprecated) Use 'volute mind split'",
      run: async () => {
        console.error(
          "'volute variant create' has been replaced. Use 'volute mind split' to create variants.",
        );
        console.error(
          "Usage: volute mind split <name> [--from <mind>] [--soul '...'] [--no-start]",
        );
        process.exit(1);
      },
    },
    merge: {
      description: "(deprecated) Use 'volute mind join'",
      run: async () => {
        console.error(
          "'volute variant merge' has been replaced. Use 'volute mind join' to merge variants.",
        );
        console.error(
          "Usage: volute mind join <name> [--summary '...' --memory '...' --justification '...']",
        );
        process.exit(1);
      },
    },
    list: {
      description: "(deprecated) Use 'volute mind list'",
      run: async () => {
        console.error("'volute variant list' is no longer available.");
        console.error(
          "Use 'volute mind list' to see variants, or 'volute mind delete <variant-name>' to delete.",
        );
        process.exit(1);
      },
    },
    delete: {
      description: "(deprecated) Use 'volute mind delete'",
      run: async () => {
        console.error("'volute variant delete' is no longer available.");
        console.error(
          "Use 'volute mind list' to see variants, or 'volute mind delete <variant-name>' to delete.",
        );
        process.exit(1);
      },
    },
  },
});

export const run = cmd.execute;

import { subcommands } from "../lib/command.js";

/** If first arg is a positional name (not a flag), inject as --mind <name>. */
function transformMindFlag(args: string[]): string[] {
  if (args.length > 0 && args[0] && !args[0].startsWith("-")) {
    return ["--mind", args[0], ...args.slice(1)];
  }
  return args;
}

const cmd = subcommands({
  name: "volute mind",
  description: "Manage minds",
  commands: {
    create: {
      description: "Create a new mind",
      run: (args) => import("./create.js").then((m) => m.run(args)),
    },
    start: {
      description: "Start a mind",
      run: (args) => import("./start.js").then((m) => m.run(args)),
    },
    stop: {
      description: "Stop a mind",
      run: (args) => import("./stop.js").then((m) => m.run(args)),
    },
    restart: {
      description: "Restart a mind",
      run: (args) => import("./restart.js").then((m) => m.run(args)),
    },
    delete: {
      description: "Delete a mind",
      run: (args) => import("./delete.js").then((m) => m.run(args)),
    },
    list: {
      description: "List all minds",
      run: (args) => import("./mind-list.js").then((m) => m.run(args)),
    },
    status: {
      description: "Check mind status",
      run: (args) => import("./mind-status.js").then((m) => m.run(args)),
    },
    history: {
      description: "View mind activity history",
      run: (args) => import("./mind-history.js").then((m) => m.run(transformMindFlag(args))),
    },
    profile: {
      description: "Update mind profile",
      run: (args) => import("./mind-profile.js").then((m) => m.run(args)),
    },
    upgrade: {
      description: "Upgrade mind to latest template",
      run: (args) => import("./upgrade.js").then((m) => m.run(args)),
    },
    import: {
      description: "Import an OpenClaw workspace",
      run: (args) => import("./import.js").then((m) => m.run(args)),
    },
    export: {
      description: "Export a mind",
      run: (args) => import("./export.js").then((m) => m.run(args)),
    },
    split: {
      description: "Create a variant",
      run: (args) => import("./split.js").then((m) => m.run(args)),
    },
    join: {
      description: "Merge variant back",
      run: (args) => import("./join.js").then((m) => m.run(args)),
    },
    sleep: {
      description: "Put a mind to sleep",
      run: (args) => import("./mind-sleep.js").then((m) => m.run(args)),
    },
    wake: {
      description: "Wake a sleeping mind",
      run: (args) => import("./mind-wake.js").then((m) => m.run(args)),
    },
    seed: {
      description: "(legacy) Use 'volute seed create' instead",
      run: (args) => import("./seed.js").then((m) => m.run(args)),
    },
    sprout: {
      description: "(legacy) Use 'volute seed sprout' instead",
      run: (args) => import("./sprout.js").then((m) => m.run(args)),
    },
  },
  footer: "Mind name can be omitted (where applicable) if VOLUTE_MIND is set.",
});

export const run = cmd.execute;

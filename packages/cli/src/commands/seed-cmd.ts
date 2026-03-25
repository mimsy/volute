import { subcommands } from "../lib/command.js";

const cmd = subcommands({
  name: "volute seed",
  description: "Plant and grow new minds",
  commands: {
    create: {
      description: "Plant a new seed",
      run: (args) => import("./seed-create.js").then((m) => m.run(args)),
    },
    sprout: {
      description: "Complete orientation and become a full mind",
      run: (args) => import("./seed-sprout.js").then((m) => m.run(args)),
    },
    check: {
      description: "Check seed readiness",
      run: (args) => import("./seed-check.js").then((m) => m.run(args)),
    },
  },
});

export const run = cmd.execute;

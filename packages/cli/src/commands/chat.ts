import { subcommands } from "../lib/command.js";

const cmd = subcommands({
  name: "volute chat",
  description: "Manage conversations and messages",
  commands: {
    send: {
      description: "Send a message",
      run: (args) => import("./chat/send.js").then((m) => m.run(args)),
    },
    list: {
      description: "List conversations",
      run: (args) => import("./chat/list.js").then((m) => m.run(args)),
    },
    read: {
      description: "Read conversation messages",
      run: (args) => import("./chat/read.js").then((m) => m.run(args)),
    },
    create: {
      description: "Create a conversation",
      run: (args) => import("./chat/create.js").then((m) => m.run(args)),
    },
    bridge: {
      description: "Manage platform bridges",
      run: (args) => import("./chat/bridge.js").then((m) => m.run(args)),
    },
    files: {
      description: "List pending incoming files",
      run: (args) => import("./chat/files.js").then((m) => m.run(args)),
    },
    accept: {
      description: "Accept a pending file",
      run: (args) => import("./chat/accept.js").then((m) => m.run(args)),
    },
    reject: {
      description: "Reject a pending file",
      run: (args) => import("./chat/reject.js").then((m) => m.run(args)),
    },
  },
  footer: "Use --mind <name> or VOLUTE_MIND to identify the mind.",
});

export const run = cmd.execute;

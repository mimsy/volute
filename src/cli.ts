import { homedir } from "node:os";
import { resolve } from "node:path";

if (!process.env.VOLUTE_HOME) {
  process.env.VOLUTE_HOME = resolve(homedir(), ".volute");
}

const command = process.argv[2];
const args = process.argv.slice(3);

if (command === "--version" || command === "-v") {
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  console.log(pkg.version);
  process.exit(0);
}

// Gate commands on setup — skip for setup itself, help, version, and update
const ungatedCommands = new Set(["setup", "--help", "-h", "--version", "-v", "update", undefined]);
if (!ungatedCommands.has(command)) {
  const { isSetupComplete, migrateSetupConfig } = await import("./lib/setup.js");
  // Auto-migrate existing users so they're never blocked
  migrateSetupConfig();
  if (!isSetupComplete()) {
    console.error("Volute is not set up. Run `volute setup` first.");
    process.exit(1);
  }
}

switch (command) {
  case "setup":
    await import("./commands/setup.js").then((m) => m.run(args));
    break;
  case "mind":
    await import("./commands/mind.js").then((m) => m.run(args));
    break;
  case "chat":
    await import("./commands/chat.js").then((m) => m.run(args));
    break;
  case "variant":
    await import("./commands/variant.js").then((m) => m.run(args));
    break;
  case "schedule":
    await import("./commands/schedule.js").then((m) => m.run(args));
    break;
  case "skill":
    await import("./commands/skill.js").then((m) => m.run(args));
    break;
  case "shared":
    await import("./commands/shared.js").then((m) => m.run(args));
    break;
  case "file":
    await import("./commands/file.js").then((m) => m.run(args));
    break;
  case "env":
    await import("./commands/env.js").then((m) => m.run(args));
    break;
  case "up":
    await import("./commands/up.js").then((m) => m.run(args));
    break;
  case "down":
    await import("./commands/down.js").then((m) => m.run(args));
    break;
  case "restart":
    await import("./commands/daemon-restart.js").then((m) => m.run(args));
    break;
  case "service":
    await import("./commands/service.js").then((m) => m.run(args));
    break;
  case "update":
    await import("./commands/update.js").then((m) => m.run(args));
    break;
  case "status":
    await import("./commands/status.js").then((m) => m.run(args));
    break;
  case "notes":
    await import("./commands/notes.js").then((m) => m.run(args));
    break;
  case "pages":
    await import("./commands/pages.js").then((m) => m.run(args));
    break;
  case "auth":
    await import("./commands/auth.js").then((m) => m.run(args));
    break;
  case "login":
    await import("./commands/login.js").then((m) => m.run(args));
    break;
  case "logout":
    await import("./commands/logout.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined:
    console.log(`volute — create and manage AI minds

Common:
  chat send <target> "<msg>"       Send a message
  chat history [--channel <ch>]    View activity history
  chat list / read / create        Manage conversations
  chat bridge                      Manage platform bridges
  status                           Show system status

Mind:
  mind create <name>               Create a new mind
  mind seed <name>                 Plant a seed mind (orientation mode)
  mind start/stop/restart [name]   Control a mind
  mind list                        List all minds
  mind status [name]               Check a mind's status
  mind logs [name] [--follow]      Tail mind logs
  mind sprout                      Complete orientation
  mind upgrade/import/export       Lifecycle operations

Configuration:
  chat      Conversations, messages, and platform bridges
  variant   Create and merge experimental variants
  schedule  Manage cron schedules
  skill     Browse and install skills
  env       Manage environment variables
  file      Mind-to-mind file sharing
  shared    Collaborative shared repository
  notes     Read and write notes
  pages     Publish web pages

System:
  setup                            First-time setup
  up / down / restart              Daemon control
  login / logout                   CLI authentication
  update                           Update volute
  service status                   Check service status
  auth register/login/logout       volute.systems account

Options:
  --version, -v                    Show version number
  --help, -h                       Show this help message

Run 'volute <command> --help' for details.

Mind-scoped commands (chat, variant, schedule, file, skill, shared, pages)
use --mind <name> or VOLUTE_MIND env var to identify the mind.`);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun 'volute --help' for usage.`);
    process.exit(1);
}

// Non-blocking update check (prints to stderr so it doesn't interfere with piped output)
if (command !== "update") {
  import("./lib/update-check.js")
    .then((m) => m.checkForUpdate())
    .then((result) => {
      if (result.updateAvailable) {
        console.error(`\n  Update available: ${result.current} → ${result.latest}`);
        console.error("  Run `volute update` to update\n");
      }
    })
    .catch(() => {});
}

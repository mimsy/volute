// Stripped-down CLI entry point for remote use (no local daemon required).
// Connects to a daemon via VOLUTE_DAEMON_URL or stored session URL.
export {};
process.noDeprecation = true;

const command = process.argv[2];
const args = process.argv.slice(3);

if (command === "--version" || command === "-v") {
  const { default: pkg } = await import("../package.json", {
    with: { type: "json" },
  });
  console.log(pkg.version);
  process.exit(0);
}

switch (command) {
  case "mind":
    await import("./commands/mind.js").then((m) => m.run(args));
    break;
  case "seed":
    await import("./commands/seed-cmd.js").then((m) => m.run(args));
    break;
  case "chat":
    await import("./commands/chat.js").then((m) => m.run(args));
    break;
  case "variant":
    await import("./commands/variant.js").then((m) => m.run(args));
    break;
  case "clock":
    await import("./commands/clock.js").then((m) => m.run(args));
    break;
  case "skill":
    await import("./commands/skill.js").then((m) => m.run(args));
    break;
  case "env":
    await import("./commands/env.js").then((m) => m.run(args));
    break;
  case "config":
    await import("./commands/config.js").then((m) => m.run(args));
    break;
  case "extension":
    await import("./commands/extension.js").then((m) => m.run(args));
    break;
  case "systems":
    await import("./commands/systems.js").then((m) => m.run(args));
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
    console.log(`volute-cli — remote CLI for volute daemon

Connect to a remote daemon via VOLUTE_DAEMON_URL or volute login.

Commands:
  mind    create/start/stop/restart/list/status/history/profile/split/join/upgrade
  chat    send/read/list/create/bridge/files/accept/reject
  clock   status/list/add/remove/sleep/wake
  seed    create/sprout/check
  skill   list/add/remove
  env     set/get/list/remove
  config  models/providers/status
  extension list/install/uninstall
  systems register/login/logout
  login   Authenticate to daemon
  logout  Remove authentication

Options:
  --version, -v  Show version
  --help, -h     Show this help

Environment:
  VOLUTE_DAEMON_URL  Daemon URL (e.g. http://myserver:1618)
  VOLUTE_MIND        Default mind for scoped commands`);
    break;
  default:
    console.error(`Unknown command: ${command}\nRun 'volute-cli --help' for usage.`);
    process.exit(1);
}

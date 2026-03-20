// Suppress deprecation warnings from transitive dependencies (e.g. punycode via node-fetch v2)
process.noDeprecation = true;

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
const ungatedCommands = new Set([
  "setup",
  "--help",
  "-h",
  "--version",
  "-v",
  "update",
  "up",
  "down",
  "restart",
  "status",
  "login",
  "logout",
  "service",
  undefined,
]);
if (!ungatedCommands.has(command)) {
  const { isSetupComplete } = await import("./lib/setup.js");
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
  case "up":
    await import("./commands/up.js").then((m) => m.run(args));
    break;
  case "down":
    await import("./commands/down.js").then((m) => m.run(args));
    break;
  case "restart":
    await import("./commands/daemon-restart.js").then((m) => m.run(args));
    break;
  case "update":
    await import("./commands/update.js").then((m) => m.run(args));
    break;
  case "status":
    await import("./commands/status.js").then((m) => m.run(args));
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
    console.log(`volute — create and manage AI minds

Common:
  chat send <target> "<msg>"       Send a message
  chat list / read / create        Manage conversations
  chat bridge                      Manage platform bridges

Mind:
  mind create <name>               Create a new mind
  mind start/stop/restart [name]   Control a mind
  mind list                        List all minds
  mind status [name]               Check a mind's status
  mind history [name] [--full]     View mind activity history
  mind profile [--mind] [...]      Set display name, description, avatar
  mind split/join                  Create and merge experimental splits
  mind upgrade/import/export       Lifecycle operations

Seed:
  seed create <name>               Plant a new seed mind
  seed sprout                      Complete orientation and become a full mind

Configuration:
  chat      Conversations, messages, files, and platform bridges
  clock     Schedules, timers, and sleep/wake cycles
  skill     Browse and install skills
  env       Manage environment variables

System:
  setup                            First-time setup
  up / down / restart              Daemon control
  status                           Show daemon & service status
  extension list/install/uninstall Manage extensions
  login / logout                   CLI authentication
  update                           Update volute
  systems register/login/logout    volute.systems account

Extensions:
  notes write/list/read/...        Manage notes
  pages notify                     Notify page updates

Options:
  --version, -v                    Show version number
  --help, -h                       Show this help message

Run 'volute <command> --help' for details.

Mind-scoped commands (chat, clock, skill)
use --mind <name> or VOLUTE_MIND env var to identify the mind.`);
    break;
  default: {
    // Try extension commands before giving up
    let isExtensionCommand = false;
    try {
      const { daemonFetch } = await import("./lib/daemon-client.js");
      const res = await daemonFetch("/api/extensions/commands");
      if (res.ok) {
        const extCommands = (await res.json()) as Record<
          string,
          { commands: Record<string, { description: string; usage?: string }> }
        >;
        if (command && command in extCommands) {
          isExtensionCommand = true;
          const subcommand = args[0];
          const ext = extCommands[command];
          if (!subcommand || !(subcommand in ext.commands)) {
            console.log(`volute ${command} — ${Object.keys(ext.commands).join(", ")}\n`);
            for (const [name, meta] of Object.entries(ext.commands)) {
              console.log(`  ${name.padEnd(12)} ${meta.description}`);
            }
            process.exit(0);
          }
          // Extract --mind flag from args (same convention as other mind-scoped commands)
          const cmdArgs = args.slice(1);
          let mind = process.env.VOLUTE_MIND;
          const mindIdx = cmdArgs.indexOf("--mind");
          if (mindIdx !== -1 && cmdArgs[mindIdx + 1]) {
            mind = cmdArgs[mindIdx + 1];
            cmdArgs.splice(mindIdx, 2);
          }
          const { readStdin } = await import("./lib/read-stdin.js");
          const stdin = await readStdin();
          const cmdRes = await daemonFetch(`/api/ext/${command}/commands/${subcommand}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ args: cmdArgs, mind, stdin }),
          });
          if (!cmdRes.ok) {
            const text = await cmdRes.text().catch(() => "");
            console.error(`Extension command failed (HTTP ${cmdRes.status}): ${text}`);
            process.exit(1);
          }
          const result = (await cmdRes.json()) as { output?: string; error?: string };
          if (result.error) {
            console.error(result.error);
            process.exit(1);
          }
          if (result.output) console.log(result.output);
          break;
        }
      }
    } catch (err) {
      // If we identified this as an extension command, surface the real error
      if (isExtensionCommand) {
        console.error(`Extension command failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      // Otherwise daemon not running — fall through to unknown command
    }
    console.error(`Unknown command: ${command}\nRun 'volute --help' for usage.`);
    process.exit(1);
  }
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

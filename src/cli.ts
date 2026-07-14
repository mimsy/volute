// Suppress deprecation warnings from transitive dependencies (e.g. punycode via node-fetch v2)
process.noDeprecation = true;

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionCommandInfo } from "@volute/daemon/lib/extensions.js";

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

// Gate commands on setup — skip for setup itself, help, version, update, and when using remote daemon
const ungatedCommands = new Set([
  "setup",
  "--help",
  "-h",
  "--version",
  "-v",
  "update",
  "up",
  "down",
  "backup", // `backup restore` must work on a fresh machine before setup
  "restart",
  "status",
  "login",
  "logout",
  "service",
  undefined,
]);
// A mind only exists because a set-up daemon spawned it, so the gate has nothing
// to tell it — and its sandbox denies the host config the check reads anyway.
const isMind = !!process.env.VOLUTE_MIND_TOKEN;
if (!isMind && !ungatedCommands.has(command)) {
  const { setupStatus, setupUrl } = await import("@volute/daemon/lib/config/setup.js");
  const status = setupStatus();
  if (status !== "complete") {
    if (status === "in-progress") {
      // Setup was started but the browser wizard hasn't been finished. Re-running
      // `volute setup` won't advance it — point the user at the wizard instead.
      console.error("Volute setup isn't finished yet.");
      console.error(`Open ${setupUrl()} in your browser to complete it.`);
      console.error("(If the daemon isn't running, start it with `volute up` first.)");
    } else {
      const { detectSystemInstallHint } = await import("@volute/cli/lib/system-install.js");
      const hint = detectSystemInstallHint();
      if (hint) {
        console.error(hint);
      } else {
        console.error("Volute is not set up. Run `volute setup` to get started.");
        console.error("It starts the daemon and opens a browser wizard to finish configuration.");
      }
    }
    process.exit(1);
  }
}

switch (command) {
  case "setup":
    await import("./commands/setup.js").then((m) => m.run(args));
    break;
  case "mind":
    await import("@volute/cli/commands/mind.js").then((m) => m.run(args));
    break;
  case "seed":
    await import("@volute/cli/commands/seed-cmd.js").then((m) => m.run(args));
    break;
  case "chat":
    await import("@volute/cli/commands/chat.js").then((m) => m.run(args));
    break;
  case "variant":
    await import("@volute/cli/commands/variant.js").then((m) => m.run(args));
    break;
  case "clock":
    await import("@volute/cli/commands/clock.js").then((m) => m.run(args));
    break;
  case "skill":
    await import("@volute/cli/commands/skill.js").then((m) => m.run(args));
    break;
  case "env":
    await import("@volute/cli/commands/env.js").then((m) => m.run(args));
    break;
  case "config":
    await import("@volute/cli/commands/config.js").then((m) => m.run(args));
    break;
  case "up":
    await import("./commands/up.js").then((m) => m.run(args));
    break;
  case "backup":
    await import("./commands/backup.js").then((m) => m.run(args));
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
    await import("@volute/cli/commands/extension.js").then((m) => m.run(args));
    break;
  case "systems":
    await import("@volute/cli/commands/systems.js").then((m) => m.run(args));
    break;
  case "login":
    await import("@volute/cli/commands/login.js").then((m) => m.run(args));
    break;
  case "logout":
    await import("@volute/cli/commands/logout.js").then((m) => m.run(args));
    break;
  case "service":
    await import("@volute/cli/commands/service.js").then((m) => m.run(args));
    break;
  case "--help":
  case "-h":
  case undefined: {
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
  mind split/join                  Split off and rejoin variants
  mind upgrade/import/export       Lifecycle operations

Seed:
  seed create <name>               Plant a new seed
  seed sprout                      Complete orientation and become a full mind

Configuration:
  chat      Conversations, messages, files, and platform bridges
  clock     Schedules and sleep/wake cycles
  skill     Browse and install skills
  env       Manage environment variables

System:
  setup [--system] [--cli]          First-time setup
  up / down / restart              Daemon control
  status                           Show daemon & service status
  backup init/create/list/restore  Back up and restore the system
  extension list/install/uninstall Manage extensions
  login / logout                   CLI authentication
  update                           Update volute
  systems register/login/logout    volute.systems account`);

    // Extension commands are discovered live from the daemon so third-party and
    // disabled extensions are reflected accurately. Best-effort and fully self-contained
    // (not daemonFetch, which hard-exits on daemon-down / not-logged-in): help must always
    // print, so any failure just skips this section.
    try {
      const { resolveDaemonUrl, getAuthToken } = await import("@volute/cli/lib/daemon-client.js");
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`${resolveDaemonUrl()}/api/extensions/commands`, {
        headers,
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        const extCommands = (await res.json()) as Record<
          string,
          { commands: Record<string, ExtensionCommandInfo> }
        >;
        const entries = Object.entries(extCommands).filter(
          ([, ext]) => Object.keys(ext.commands).length > 0,
        );
        if (entries.length > 0) {
          const rows = entries.map(([id, ext]) => {
            const subs = Object.keys(ext.commands).join("/");
            return { left: `  ${id} ${subs}`, id };
          });
          const width = Math.max(...rows.map((r) => r.left.length));
          console.log("\nExtensions:");
          for (const r of rows) {
            console.log(`${r.left.padEnd(width + 2)} Manage ${r.id}`);
          }
        }
      }
    } catch {
      // Daemon unreachable — skip the dynamic section.
    }

    console.log(`
Options:
  --version, -v                    Show version number
  --help, -h                       Show this help message

Run 'volute <command> --help' for details.

Mind-scoped commands (chat, clock, skill)
use --mind <name> or VOLUTE_MIND env var to identify the mind.`);
    break;
  }
  default: {
    // Try extension commands before giving up
    let isExtensionCommand = false;
    try {
      const { daemonFetch } = await import("@volute/cli/lib/daemon-client.js");
      const res = await daemonFetch("/api/extensions/commands");
      if (res.ok) {
        const extCommands = (await res.json()) as Record<
          string,
          { commands: Record<string, ExtensionCommandInfo> }
        >;
        if (command && command in extCommands) {
          isExtensionCommand = true;
          const ext = extCommands[command];
          const subcommand = args[0];
          const wantsHelp = args.includes("--help") || args.includes("-h");

          // Group help: no subcommand, or --help at group level
          if (!subcommand || (wantsHelp && !(subcommand in ext.commands))) {
            console.log(`Manage ${command}\n`);
            console.log(`Usage: volute ${command} <command> [options]\n`);
            console.log("Commands:");
            const entries = Object.entries(ext.commands);
            const nameWidth = Math.max(...entries.map(([k]) => k.length));
            for (const [name, meta] of entries) {
              console.log(`  ${name.padEnd(nameWidth + 2)}  ${meta.description}`);
            }
            console.log(`\nUse --mind <name> or VOLUTE_MIND to specify the mind.\n`);
            process.exit(subcommand ? 0 : 1);
          }

          // Command help: --help on a specific subcommand
          if (wantsHelp && subcommand in ext.commands) {
            const meta = ext.commands[subcommand];
            const argParts = (meta.args ?? []).map((a) =>
              a.required ? `<${a.name}>` : `[${a.name}]`,
            );
            const flagEntries = Object.entries(meta.flags ?? {});
            const flagPart = flagEntries.length > 0 ? " [options]" : "";
            const argStr = argParts.length > 0 ? ` ${argParts.join(" ")}` : "";

            console.log(`${meta.description}\n`);
            console.log(`Usage: volute ${command} ${subcommand}${argStr}${flagPart}\n`);

            if (meta.args && meta.args.length > 0) {
              console.log("Arguments:");
              const w = Math.max(...meta.args.map((a) => a.name.length + 2));
              for (const a of meta.args) {
                const label = a.required ? `<${a.name}>` : `[${a.name}]`;
                console.log(`  ${label.padEnd(w + 2)}  ${a.description}`);
              }
              console.log("");
            }

            if (flagEntries.length > 0) {
              console.log("Options:");
              const w = Math.max(
                ...flagEntries.map(([k, v]) => {
                  const hint =
                    v.type === "boolean" ? "" : ` <${v.type === "string" ? "value" : "n"}>`;
                  return `--${k}${hint}`.length;
                }),
              );
              for (const [key, val] of flagEntries) {
                const hint =
                  val.type === "boolean" ? "" : ` <${val.type === "string" ? "value" : "n"}>`;
                const flag = `--${key}${hint}`;
                console.log(`  ${flag.padEnd(w + 2)}  ${val.description}`);
              }
              console.log("");
            }

            if (meta.examples && meta.examples.length > 0) {
              console.log("Examples:");
              for (const ex of meta.examples) {
                console.log(`  ${ex}`);
              }
              console.log("");
            }

            process.exit(0);
          }

          if (!(subcommand in ext.commands)) {
            console.error(`Unknown command: volute ${command} ${subcommand}`);
            process.exit(1);
          }

          // Extract --mind flag from args (same convention as other mind-scoped commands)
          const cmdArgs = args.slice(1);
          let mind = process.env.VOLUTE_MIND;
          const mindIdx = cmdArgs.indexOf("--mind");
          if (mindIdx !== -1 && cmdArgs[mindIdx + 1]) {
            mind = cmdArgs[mindIdx + 1];
            cmdArgs.splice(mindIdx, 2);
          }
          const { readStdin } = await import("@volute/cli/lib/read-stdin.js");
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
  import("@volute/daemon/lib/update-check.js")
    .then((m) => m.checkForUpdate())
    .then((result) => {
      if (result.updateAvailable) {
        console.error(`\n  Update available: ${result.current} → ${result.latest}`);
        console.error("  Run `volute update` to update\n");
      }
    })
    .catch(() => {});
}

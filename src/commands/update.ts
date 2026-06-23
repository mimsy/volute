import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { command } from "@volute/cli/lib/command.js";
import {
  getServiceMode,
  modeLabel,
  pollHealth,
  readDaemonConfig,
  restartService,
} from "@volute/daemon/lib/config/service-mode.js";
import { voluteSystemDir } from "@volute/daemon/lib/mind/registry.js";
import {
  checkForUpdate,
  getResolvedVersion,
  resolveVoluteInstall,
  type VoluteInstall,
} from "@volute/daemon/lib/update-check.js";
import { exec, execInherit, resolveVoluteBin } from "@volute/daemon/lib/util/exec.js";

/**
 * Build the npm invocation for a global install, targeting the prefix that owns the
 * running `volute` binary. Falls back to the ambient npm when the owning prefix is
 * unknown (e.g. a linked checkout, already handled before we get here).
 */
function buildInstall(
  install: VoluteInstall | null,
  latest: string,
  npmFallback: string,
): { cmd: string; args: string[] } {
  const args = ["install", "-g", `volute@${latest}`];
  const prefix = install?.prefix;
  if (prefix) {
    const ownNpm = resolve(prefix, "bin", "npm");
    args.push("--prefix", prefix);
    return { cmd: existsSync(ownNpm) ? ownNpm : npmFallback, args };
  }
  return { cmd: npmFallback, args };
}

/**
 * Confirm the binary on PATH now reports the expected version. Returns true on match.
 * This is what turns a silent "installed into the wrong prefix" failure into a real error.
 */
async function verifyInstalled(install: VoluteInstall | null, expected: string): Promise<boolean> {
  if (!install?.binPath) return true; // can't verify; don't block
  const actual = await getResolvedVersion(install.binPath);
  if (actual === expected) return true;
  console.error(`\nUpdate did not take effect.`);
  console.error(`  The volute on your PATH is: ${install.binPath}`);
  if (install.realPath !== install.binPath) console.error(`  → ${install.realPath}`);
  console.error(`  It still reports version: ${actual ?? "unknown"} (expected ${expected}).`);
  if (install.prefix) {
    console.error(
      `  npm likely installed into a different prefix than ${install.prefix}.\n` +
        `  Check that the npm running the install shares this prefix (\`npm prefix -g\`).`,
    );
  }
  return false;
}

const cmd = command({
  name: "volute update",
  description: "Check for and install updates",
  flags: {},
  run: async () => {
    const result = await checkForUpdate(true);
    if (result.checkFailed) {
      console.error("Could not reach npm registry. Check your network connection and try again.");
      process.exit(1);
    }
    console.log(`Current version: ${result.current}`);
    console.log(`Latest version:  ${result.latest}`);

    if (!result.updateAvailable) {
      console.log("\nAlready up to date.");
      return;
    }

    console.log(`\nUpdating volute ${result.current} → ${result.latest}...`);

    const install = resolveVoluteInstall();
    if (install?.isLinked) {
      console.error(
        `\nThe volute on your PATH is running from a source checkout / npm link:\n` +
          `  ${install.binPath} → ${install.realPath}\n` +
          `\`npm install -g\` would not change it. Update that checkout directly instead\n` +
          `(e.g. \`git pull && npm install && npm run build\`).`,
      );
      process.exit(1);
    }

    const mode = getServiceMode();

    if (mode === "system") {
      // System service: use the owning prefix's npm (fall back to /usr/bin/npm, then PATH) with sudo
      let npmFallback = "/usr/bin/npm";
      if (!existsSync(npmFallback)) {
        try {
          npmFallback = (await exec("which", ["npm"])).trim();
        } catch {
          console.error("Could not find npm. Install npm and try again.");
          process.exit(1);
        }
      }
      const { cmd: npmCmd, args: npmArgs } = buildInstall(install, result.latest, npmFallback);
      try {
        await execInherit("sudo", [npmCmd, ...npmArgs]);
      } catch (err) {
        console.error(`\nUpdate failed: ${(err as Error).message}`);
        process.exit(1);
      }
      if (!(await verifyInstalled(install, result.latest))) process.exit(1);
      console.log("Restarting service...");
      try {
        await restartService(mode);
      } catch (err) {
        console.error(`Failed to restart: ${err instanceof Error ? err.message : err}`);
        console.error("Try: sudo systemctl restart volute");
        process.exit(1);
      }
      {
        const config = readDaemonConfig();
        if (await pollHealth("127.0.0.1", config.internalPort ?? config.port)) {
          console.log(`\nUpdated to volute v${result.latest}`);
        } else {
          console.error("Service restarted but daemon did not become healthy.");
          process.exit(1);
        }
      }
      return;
    }

    if (mode === "user-systemd" || mode === "user-launchd") {
      // User service: install into the owning prefix (no sudo), then restart service
      const { cmd: npmCmd, args: npmArgs } = buildInstall(install, result.latest, "npm");
      try {
        await execInherit(npmCmd, npmArgs);
      } catch (err) {
        console.error(`\nUpdate failed: ${(err as Error).message}`);
        process.exit(1);
      }
      if (!(await verifyInstalled(install, result.latest))) process.exit(1);
      console.log(`Restarting service (${modeLabel(mode)})...`);
      try {
        await restartService(mode);
      } catch (err) {
        console.error(`Failed to restart: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      {
        const config = readDaemonConfig();
        if (await pollHealth("127.0.0.1", config.internalPort ?? config.port)) {
          console.log(`\nUpdated to volute v${result.latest}`);
        } else {
          console.error("Service restarted but daemon did not become healthy.");
          process.exit(1);
        }
      }
      return;
    }

    // Manual mode: stop → install → restart (existing logic)
    const systemDir = voluteSystemDir();
    const pidPath = resolve(systemDir, "daemon.pid");
    const configPath = resolve(systemDir, "daemon.json");

    let daemonWasRunning = false;
    let daemonPort = 1618;
    let daemonHost = "127.0.0.1";

    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(pid, 0);
        daemonWasRunning = true;
      } catch {
        try {
          unlinkSync(pidPath);
        } catch {}
      }
    }

    if (daemonWasRunning && existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        daemonPort = config.port ?? 1618;
        daemonHost = config.hostname || "127.0.0.1";
      } catch {
        console.error("Warning: could not read daemon config, using default port/host");
      }
    }

    if (daemonWasRunning) {
      console.log("Stopping daemon...");
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }

      const maxWait = 10_000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        if (!existsSync(pidPath)) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      if (existsSync(pidPath)) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
      }

      if (existsSync(pidPath)) {
        try {
          const stalePid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
          process.kill(stalePid, 0);
          console.error("Warning: daemon process may still be running. Aborting update.");
          process.exit(1);
        } catch {
          try {
            unlinkSync(pidPath);
          } catch {}
        }
      }

      console.log("Daemon stopped.");
    }

    const { cmd: npmCmd, args: npmArgs } = buildInstall(install, result.latest, "npm");
    try {
      await execInherit(npmCmd, npmArgs);
    } catch (err) {
      console.error(`\nUpdate failed: ${(err as Error).message}`);
      if (daemonWasRunning) {
        console.log("Restarting daemon with current version...");
        try {
          await execInherit(resolveVoluteBin(), [
            "up",
            "--port",
            String(daemonPort),
            "--host",
            daemonHost,
          ]);
        } catch {
          console.error("Failed to restart daemon. Run `volute up` manually.");
        }
      }
      process.exit(1);
    }

    const ok = await verifyInstalled(install, result.latest);

    if (daemonWasRunning) {
      console.log("Restarting daemon...");
      try {
        await execInherit(resolveVoluteBin(), [
          "up",
          "--port",
          String(daemonPort),
          "--host",
          daemonHost,
        ]);
      } catch {
        console.error("Failed to restart daemon. Run `volute up` manually.");
      }
    }

    if (!ok) process.exit(1);
    console.log(`\nUpdated to volute v${result.latest}`);
  },
});

export const run = cmd.execute;

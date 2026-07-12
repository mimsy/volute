import { existsSync } from "node:fs";

// System-service install markers (must match service-mode.ts). A system install
// exports VOLUTE_HOME=/var/lib/volute from /etc/profile.d/volute.sh, but that's
// only sourced by login shells — ssh one-liners, cron, scripts, and CI don't get
// it, so the CLI falls back to ~/.volute and looks unconfigured.
const SYSTEM_SYSTEMD_SERVICE = "/etc/systemd/system/volute.service";
const SYSTEM_LAUNCHD_PLIST = "/Library/LaunchDaemons/com.volute.daemon.plist";
const SYSTEM_DATA_DIR = "/var/lib/volute";

type SystemInstallFacts = {
  hasSystemd?: boolean;
  hasLaunchd?: boolean;
  voluteHomeSet?: boolean;
};

/**
 * When a system service is installed but VOLUTE_HOME is unset, the CLI is looking
 * at ~/.volute instead of the system install. Returns guidance to fix that, or
 * null when there's no system install / VOLUTE_HOME is already set. Facts default
 * to the real environment; tests inject them to exercise the decision table.
 */
export function detectSystemInstallHint({
  hasSystemd = existsSync(SYSTEM_SYSTEMD_SERVICE),
  hasLaunchd = existsSync(SYSTEM_LAUNCHD_PLIST),
  voluteHomeSet = Boolean(process.env.VOLUTE_HOME),
}: SystemInstallFacts = {}): string | null {
  if (voluteHomeSet) return null;
  if (!hasSystemd && !hasLaunchd) return null;

  const lines = [
    "Volute is installed as a system service, but VOLUTE_HOME is not set in this shell.",
    `The CLI is defaulting to ~/.volute and can't see the system install at ${SYSTEM_DATA_DIR}.`,
    `Set it for this session:  export VOLUTE_HOME=${SYSTEM_DATA_DIR}`,
  ];
  if (hasSystemd) {
    lines.push("Login shells load this automatically via /etc/profile.d/volute.sh;");
    lines.push(
      "non-login shells (ssh one-liners, cron, scripts) don't — run: source /etc/profile.d/volute.sh",
    );
  }
  return lines.join("\n");
}

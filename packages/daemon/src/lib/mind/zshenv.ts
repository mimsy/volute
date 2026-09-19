import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Keep `home/.zshenv` in step with the mind's template.
 *
 * Codex minds need it: the codex sandbox runs commands in `/bin/zsh -lc`, which
 * resets the environment, and ZDOTDIR (set via codex config) makes the login shell
 * source this file to restore VOLUTE vars and PATH.
 *
 * Every other template must not have it. zsh sources `~/.zshenv` on *every*
 * invocation, so a file left behind by a codex→claude switch overrides the live
 * `VOLUTE_MIND_TOKEN` with the one from the mind's last codex start — long revoked —
 * and every CLI call the mind makes 401s as "Not logged in". Only a file carrying a
 * token export is removed: that is the daemon's own, never something a mind wrote.
 */
export function syncMindZshenv(
  homeDir: string,
  template: string | undefined,
  env: Record<string, string | undefined>,
): void {
  const path = resolve(homeDir, ".zshenv");
  if (template === "codex") {
    const lines = Object.entries(env)
      .filter(([k, v]) => k.startsWith("VOLUTE_") && v != null)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
    lines.push(`export PATH=${JSON.stringify(env.PATH ?? "")}`);
    writeFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    return;
  }
  let existing: string;
  try {
    existing = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  if (existing.includes("export VOLUTE_MIND_TOKEN=")) rmSync(path, { force: true });
}

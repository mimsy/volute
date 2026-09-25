import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { mindFileOwner } from "./isolation.js";
import { readMindFile, removeMindFile, writeMindFile } from "./mind-file-write.js";

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
 *
 * The file is the mind's (`baseName`'s under isolation), so its own shell can
 * source it, and is written through `writeMindFile` — the daemon may be root and
 * a mind can plant a link at `home/.zshenv` (#1123).
 */
export async function syncMindZshenv(
  dir: string,
  baseName: string,
  template: string | undefined,
  env: Record<string, string | undefined>,
): Promise<void> {
  if (template === "codex") {
    const lines = Object.entries(env)
      .filter(([k, v]) => k.startsWith("VOLUTE_") && v != null)
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
    lines.push(`export PATH=${JSON.stringify(env.PATH ?? "")}`);
    await writeMindFile(dir, "home/.zshenv", `${lines.join("\n")}\n`, {
      owner: await mindFileOwner(baseName),
      mode: 0o600,
    });
    return;
  }
  // Most minds have none; resolve the owner (a user lookup under isolation) only for one
  // that does. lstat is only this shortcut — the read below makes the real checks.
  if (!(await lstat(resolve(dir, "home", ".zshenv")).catch(() => null))) return;
  const owner = await mindFileOwner(baseName);
  const existing = await readMindFile(dir, "home/.zshenv", { owner });
  if (existing?.text.includes("export VOLUTE_MIND_TOKEN=")) {
    await removeMindFile(dir, "home/.zshenv", { owner });
  }
}

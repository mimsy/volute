import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { mindFileOwner } from "./isolation.js";
import { readMindFile, removeMindFile, writeMindFile } from "./mind-file-write.js";

/**
 * Whether the daemon writes `home/.zshenv` for this mind: only for a codex mind still
 * running a template from before #1232.
 *
 * That template ran commands in `/bin/zsh -lc`, whose login profile reset the
 * environment; ZDOTDIR (set via codex config) made zsh source this file to restore
 * VOLUTE vars and PATH. Since #1232 the template turns login shells off
 * (`allow_login_shell: false`), so codex runs `<shell> -c` and commands inherit the
 * mind's environment as-is — the file only duplicated it, and clobbered any PATH entry
 * codex prepended. Read from the mind's own `src/agent.ts` rather than inferred from
 * auto-upgrade, which can leave a mind on an old template indefinitely. A source that
 * is absent or unreadable (a link) gets no file: this one carries the mind's token.
 */
export async function wantsDaemonZshenv(
  dir: string,
  baseName: string,
  template: string | undefined,
): Promise<boolean> {
  if (template !== "codex") return false;
  const agent = await readMindFile(dir, "src/agent.ts", {
    owner: await mindFileOwner(baseName),
  }).catch(() => null);
  return agent != null && !/allow_login_shell:\s*false/.test(agent.text);
}

/** Whether a `.zshenv` is the daemon's: only its file exports the mind's token. */
export function isDaemonZshenv(text: string): boolean {
  return text.includes("export VOLUTE_MIND_TOKEN=");
}

/**
 * Keep `home/.zshenv` in step with {@link wantsDaemonZshenv}.
 *
 * Every other mind must not have the daemon's file. zsh sources `~/.zshenv` on
 * *every* invocation, so one left behind — by a codex→claude switch, or by a codex
 * mind upgrading past #1232 — overrides the live `VOLUTE_MIND_TOKEN` with the one
 * from the start that wrote it, long revoked, and every CLI call the mind makes 401s
 * as "Not logged in". Only a file carrying a token export is removed: that is the
 * daemon's own (rewritten on every start, so no edit to it ever lasted), never
 * something a mind wrote.
 *
 * The file is the mind's (`baseName`'s under isolation), so its own shell can
 * source it, and is written through `writeMindFile` — the daemon may be root and
 * a mind can plant a link at `home/.zshenv` (#1123).
 */
export async function syncMindZshenv(
  dir: string,
  baseName: string,
  write: boolean,
  env: Record<string, string | undefined>,
): Promise<void> {
  if (write) {
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
  if (existing && isDaemonZshenv(existing.text)) {
    await removeMindFile(dir, "home/.zshenv", { owner });
  }
}

/**
 * The environment the daemon hands to anything that may run mind-authored code —
 * a mind's own server process, its scheduled scripts and hooks, `npm install` in
 * its project, and every git command in its repository (a `git commit` runs the
 * mind's pre-commit/commit-msg/post-commit hooks; `merge`, `checkout` and
 * `worktree add` run theirs; `core.hooksPath` may point anywhere the mind likes).
 *
 * The daemon's own `process.env` carries `VOLUTE_DAEMON_TOKEN`, the admin token,
 * set at startup; a child that reads it holds full admin API access, which is a
 * complete bypass of the trust boundary (#966). So this module is a zero-import
 * leaf, safe to reach from `util/exec.ts` and every lifecycle module without a
 * cycle, and the wrappers there apply it by default: a caller that passes no env
 * gets this allowlist, never the daemon environment wholesale.
 */

// Benign system env vars a mind's node/tsx process needs to run. Everything else
// from the daemon environment (ambient AWS_*/GITHUB_TOKEN/etc.) is withheld.
const MIND_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TERMINFO",
  "COLORTERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "NODE_ENV",
  "__CF_USER_TEXT_ENCODING",
  // Where git and npm look for per-user config when the host has moved it off
  // ~/.config. Without it, a host that sets this loses its git identity and npm
  // settings for every daemon-spawned git and npm child — silently, and only on
  // that host. It names a directory, not a credential, and points at config the
  // child could already reach through HOME, so it costs nothing to carry. Note it
  // also reaches mind server processes, which share this allowlist.
  "XDG_CONFIG_HOME",
  // Outbound proxy / custom-CA config — required for minds' HTTPS calls (incl.
  // the Anthropic API) to succeed on hosts that reach the internet only via a
  // corporate proxy or custom CA bundle. Previously inherited via ...process.env.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Build the base environment for a mind process from an allowlist instead of
 * spreading the full daemon `process.env`. Copies benign system vars plus all
 * `VOLUTE_*` vars the mind needs — but never the daemon admin token
 * (`VOLUTE_DAEMON_TOKEN`), which the caller replaces with a per-mind
 * `VOLUTE_MIND_TOKEN`.
 */
export function buildMindBaseEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> = {};
  for (const key of MIND_ENV_ALLOWLIST) {
    if (source[key] !== undefined) base[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    // Withhold the daemon admin token — minds get their own VOLUTE_MIND_TOKEN.
    if (key === "VOLUTE_DAEMON_TOKEN") continue;
    if (key.startsWith("VOLUTE_")) base[key] = value;
  }
  return base;
}

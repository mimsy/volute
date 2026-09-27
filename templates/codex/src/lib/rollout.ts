import { readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The one sessions root codex itself reads when it resumes a thread: `CODEX_HOME/sessions`
 * when CODEX_HOME is set, `~/.codex/sessions` otherwise.
 *
 * Not `findCodexSessionFile`, which searches both `.mind/codex/sessions` and
 * `~/.codex/sessions` so the context panel can find a rollout wherever it lies. That
 * breadth is wrong for the question asked here: the daemon sets CODEX_HOME only for an
 * OAuth provider, so switching the provider moves codex to the other root, and a rollout
 * the broad search still finds is one `codex exec resume` cannot (#1188).
 */
export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME
    ? resolve(env.CODEX_HOME, "sessions")
    : resolve(env.HOME ?? "", ".codex", "sessions");
}

/**
 * Whether codex can resume `threadId` — its rollout (`YYYY/MM/DD/rollout-*-<id>.jsonl`)
 * is under the root codex reads. The SDK's `resumeThread` only constructs an object and
 * never throws, so without this check a missing rollout surfaces as a failed turn, and
 * then as every later turn on that thread failing the same way.
 */
export function rolloutVisibleToCodex(threadId: string, root = codexSessionsRoot()): boolean {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  for (const year of list(root)) {
    for (const month of list(resolve(root, year))) {
      for (const day of list(resolve(root, year, month))) {
        for (const file of list(resolve(root, year, month, day))) {
          if (file.endsWith(".jsonl") && file.includes(threadId)) return true;
        }
      }
    }
  }
  return false;
}

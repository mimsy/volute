/**
 * Build an env object that strips GIT_* vars (set by hooks like pre-push)
 * to prevent git commands in test temp dirs from targeting the parent repo.
 */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") && v !== undefined) env[k] = v;
  }
  return env;
}

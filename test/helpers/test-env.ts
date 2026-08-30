/**
 * `VOLUTE_*` vars that are a deliberate knob for a test *run*, not ambient host
 * state. Anything else inherited from the environment is stripped by
 * `stripInheritedVoluteEnv()` before test/setup.ts installs its own.
 */
export const TEST_ENV_KEEP = new Set(["VOLUTE_UPGRADE_FROM"]);

/**
 * Strip inherited `VOLUTE_*` vars so a test run is never steered by the host's
 * live installation. `test/setup.ts` redirects `VOLUTE_HOME`, but several modules
 * read other `VOLUTE_*` vars directly — `backupRoots()` reads `VOLUTE_MINDS_DIR`
 * — so an unstripped one silently points a test at real state. On a production
 * host a mind's own environment carries `VOLUTE_MINDS_DIR=/minds` (VOLUTE_* passes
 * the mind env allowlist), which made the restic round-trip test back up every
 * mind on the box into the test scratch dir: 1.6G a run, and one mind's directory
 * holding a copy of every other mind's files (#805).
 *
 * Same shape as the `GIT_*` strip above it, and for the same reason: a test must
 * choose its environment rather than inherit one.
 */
export function stripInheritedVoluteEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const stripped: string[] = [];
  for (const key of Object.keys(env)) {
    if (!key.startsWith("VOLUTE_") || TEST_ENV_KEEP.has(key)) continue;
    delete env[key];
    stripped.push(key);
  }
  return stripped;
}

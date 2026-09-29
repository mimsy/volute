import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { voluteSystemDir } from "../mind/registry.js";

/**
 * The env for an npm run the host owns (the spirit's project, extension packages),
 * as opposed to a mind's own install (`npmInstallEnv`). It points npm's cache under
 * the system dir: the daemon's HOME is unreachable under the system unit's
 * `ProtectHome=yes`, so npm's default `~/.npm` fails with `mkdir '/root/.npm'`
 * (#1223).
 */
export function hostNpmEnv(): NodeJS.ProcessEnv {
  const cacheDir = resolve(voluteSystemDir(), ".npm-cache");
  mkdirSync(cacheDir, { recursive: true });
  return { npm_config_cache: cacheDir };
}

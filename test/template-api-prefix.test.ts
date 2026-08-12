import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Guard: every daemon-bound `/api/` URL in the mind templates must use the
 * `/api/v1/` prefix.
 *
 * PR #900 collapsed the daemon's HTTP surface to a single `/api/v1` prefix and
 * deleted the bare `/api/<module>` mounts (they now 404). The sweep covered
 * `packages/` and `test/` but missed `templates/`, the source copied into every
 * mind's own directory — so two template call sites kept hitting the deleted
 * surface (#900 follow-up). A wrong prefix is just a string, so `tsc` and biome
 * pass and no runtime test exercises template client code against a live daemon;
 * this static check is the only thing that catches it.
 *
 * Scope is deliberately `templates/` only. Do NOT widen to `packages/`: there are
 * legitimate non-v1 `/api/` calls there aimed at *remote* services
 * (`config.apiUrl`/`systems.apiUrl` → `/api/register`, `/api/whoami`,
 * `/api/pages/*`, `/api/mail/*`, and `lib/mind/identity.ts`'s `/api/keys/` which
 * targets the hosted systems service), plus deliberate local survivors
 * (`/api/health`, `/api/ext/*`). Every daemon-bound URL in `templates/` is built
 * as `http://127.0.0.1:${...}/api/...`, so keying on that host prefix keeps the
 * guard free of false positives.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(here, "..", "templates");

/** Every `.ts` file under `templates/`, recursively, skipping `node_modules`. */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Match a daemon-bound URL: http://127.0.0.1:<port>/api/<path...>. The port is
// always an interpolation (`${...}`) in the templates. Capture the path segment
// beginning at `/api/` up to the first delimiter (quote, backtick, whitespace, `)`).
const DAEMON_API_URL = /127\.0\.0\.1:\$\{[^}]*\}(\/api\/[^\s"'`)]*)/g;

describe("template daemon /api URLs use the /api/v1 prefix", () => {
  it("has no daemon-bound /api/ call in templates/ that skips /api/v1/", () => {
    const violations: string[] = [];

    for (const file of collectTsFiles(TEMPLATES_DIR)) {
      const source = readFileSync(file, "utf-8");
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(DAEMON_API_URL)) {
          const path = match[1];
          if (!path.startsWith("/api/v1/")) {
            const rel = relative(TEMPLATES_DIR, file);
            violations.push(`templates/${rel}:${i + 1}: ${path} (must start with /api/v1/)`);
          }
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      `Daemon-bound /api/ URLs in templates/ must use the /api/v1/ prefix ` +
        `(PR #900 deleted the bare /api/<module> mounts):\n${violations.join("\n")}`,
    );
  });
});

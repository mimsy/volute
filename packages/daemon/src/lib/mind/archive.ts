import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import { isInitInfrastructure } from "../template/template.js";
import { safeResolveWithinBase } from "../util/paths.js";
import { initLedgerPath } from "./init-ledger.js";
import { mindDir, stateDir } from "./registry.js";

export type ExportManifest = {
  version: 1;
  name: string;
  template: string;
  voluteVersion: string;
  exportedAt: string;
  format?: "home-only" | "full";
  stage?: "seed" | "sprouted";
  includes: {
    env: boolean;
    identity: boolean;
    connectors: boolean;
    history: boolean;
    sessions: boolean;
  };
};

export type ExportOptions = {
  name: string;
  template: string;
  stage?: "seed" | "sprouted";
  includeSrc?: boolean;
  includeEnv?: boolean;
  includeIdentity?: boolean;
  includeConnectors?: boolean;
  includeHistory?: boolean;
  includeSessions?: boolean;
};

const EXCLUDED_DIRS = new Set(["node_modules", ".variants", ".git"]);

/** Walk a directory tree, returning relative paths. Skips excluded dirs and optionally sessions. */
function walkDir(dir: string, base?: string, skipSessions?: boolean): string[] {
  const results: string[] = [];
  const baseDir = base ?? dir;

  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry);
    const relPath = relative(baseDir, fullPath);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      // Skip .mind/sessions when sessions are bundled separately
      if (skipSessions && relPath === join(".mind", "sessions")) continue;
      results.push(...walkDir(fullPath, baseDir, skipSessions));
    } else {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * List files using git (tracked + untracked-but-not-ignored).
 * Falls back to walkDir if git fails (e.g. mind not a git repo).
 */
function gitListFiles(dir: string): string[] | null {
  try {
    const tracked = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf-8" });
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: dir,
      encoding: "utf-8",
    });
    const files = [...tracked.trim().split("\n"), ...untracked.trim().split("\n")].filter(Boolean);
    return [...new Set(files)];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("not a git repository")) {
      console.error(`Warning: git ls-files failed, .gitignore rules will not apply: ${msg}`);
    }
    return null;
  }
}

/**
 * The mind's infrastructure namespace inside `home/`, relative to the mind dir.
 *
 * `templates/_base/gitignore` ignores `home/*` and allowlists only the mind's
 * identity files, so `git ls-files` reports nothing at all under `.local/`.
 * Un-ignoring it there would start committing every mind's hooks into its own
 * repo, which is a different decision; the export instead names the subtree.
 */
const HOME_LOCAL_REL = join("home", ".local");

/** `.gitignore` rules and zip entry names both speak forward slashes. */
function toPosix(relPath: string): string {
  return relPath.split(sep).join("/");
}

/**
 * The files that make up a mind's `home/` for a home-only export.
 *
 * One definition for both branches. Git is asked first so a mind's `.gitignore`
 * still keeps SDK session transcripts and other runtime droppings out of the
 * archive; when the mind isn't a git repo we walk `home/` instead. Either way
 * `home/.local/` — the mind's hooks and bin shims — is walked in explicitly,
 * because git will never report it (see {@link HOME_LOCAL_REL}) and because
 * whether a mind's edited hooks survive an export must not depend on whether
 * its home happens to be a git repo (#1013).
 */
function listHomeFiles(dir: string): string[] {
  const gitFiles = gitListFiles(dir);
  const files = gitFiles
    ? gitFiles.filter((f) => f.startsWith("home/") || f.startsWith("home\\"))
    : walkDir(resolve(dir, "home"), dir);

  const localDir = resolve(dir, HOME_LOCAL_REL);
  if (existsSync(localDir)) files.push(...walkDir(localDir, dir));

  return [...new Set(files.map(toPosix))];
}

/**
 * Where a home-only archive carries the exporting mind's infrastructure ledger.
 *
 * Sits beside `state/env.json` because it is the same kind of thing: per-mind
 * state Volute keeps outside the mind's own directory. Absent from every
 * archive written before #1013, and from full archives (which are unaffected —
 * they copy a whole mind tree and compose no template, so nothing re-adds).
 */
export const ARCHIVE_INIT_LEDGER = "state/init-infrastructure.json";

/** Check if a manifest represents a home-only archive. */
export function isHomeOnlyArchive(manifest: ExportManifest): boolean {
  return manifest.format === "home-only";
}

/** Create an export archive zip from a mind. */
export function createExportArchive(options: ExportOptions): AdmZip {
  const {
    name,
    template,
    stage,
    includeSrc = false,
    includeEnv = false,
    includeIdentity = false,
    includeConnectors = false,
    includeHistory = false,
    includeSessions = false,
  } = options;

  const dir = mindDir(name);
  const state = stateDir(name);
  const zip = new AdmZip();
  const format = includeSrc ? "full" : "home-only";

  if (includeSrc) {
    // Full export: walk entire mind directory (original behavior)
    const files = walkDir(dir, undefined, includeSessions);
    for (const relPath of files) {
      if (!includeIdentity && relPath.startsWith(join(".mind", "identity"))) continue;
      if (!includeConnectors && relPath.startsWith(join(".mind", "connectors"))) continue;
      const fullPath = resolve(dir, relPath);
      zip.addFile(`mind/${relPath}`, readFileSync(fullPath));
    }
  } else {
    // Home-only export: listHomeFiles for home/, walkDir for .mind/
    for (const relPath of listHomeFiles(dir)) {
      const fullPath = resolve(dir, relPath);
      if (existsSync(fullPath)) {
        // Modes matter here as they do nowhere else in the archive: `.local/bin/`
        // holds the mind's `volute` wrapper and its skill shims, which are only
        // useful executable. adm-zip stamps 0644 on an entry added without one.
        zip.addFile(`mind/${relPath}`, readFileSync(fullPath), "", statSync(fullPath).mode & 0o777);
      }
    }

    // .mind/ files via walkDir (it's gitignored so git ls-files won't find it)
    const mindInternalDir = resolve(dir, ".mind");
    if (existsSync(mindInternalDir)) {
      const mindFiles = walkDir(mindInternalDir, dir, includeSessions);
      for (const relPath of mindFiles) {
        if (!includeIdentity && relPath.startsWith(join(".mind", "identity"))) continue;
        if (!includeConnectors && relPath.startsWith(join(".mind", "connectors"))) continue;
        const fullPath = resolve(dir, relPath);
        zip.addFile(`mind/${relPath}`, readFileSync(fullPath));
      }
    }

    // The mind's infrastructure ledger, so the import can tell a hook it refused
    // from one that shipped after the export. See {@link overlayArchiveHome}.
    const ledgerPath = initLedgerPath(name);
    if (existsSync(ledgerPath)) {
      zip.addFile(ARCHIVE_INIT_LEDGER, readFileSync(ledgerPath));
    }
  }

  // Optionally include env.json from state dir
  if (includeEnv && existsSync(state)) {
    const envPath = resolve(state, "env.json");
    if (existsSync(envPath)) {
      zip.addFile("state/env.json", readFileSync(envPath));
    }
  }

  // Optionally include session JSONL files from .mind/sessions/
  if (includeSessions) {
    const sessionsDir = resolve(dir, ".mind/sessions");
    if (existsSync(sessionsDir)) {
      for (const file of readdirSync(sessionsDir)) {
        if (!file.endsWith(".json") && !file.endsWith(".jsonl")) continue;
        const fullPath = resolve(sessionsDir, file);
        zip.addFile(`sessions/${file}`, readFileSync(fullPath));
      }
    }
  }

  // Read version from package.json
  let voluteVersion = "unknown";
  try {
    const pkgPath = resolve(import.meta.dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    voluteVersion = pkg.version;
  } catch {
    // Non-critical: archive works without exact version
  }

  // Write manifest
  const manifest: ExportManifest = {
    version: 1,
    name,
    template,
    voluteVersion,
    exportedAt: new Date().toISOString(),
    format,
    stage,
    includes: {
      env: includeEnv,
      identity: includeIdentity,
      connectors: includeConnectors,
      history: includeHistory,
      sessions: includeSessions,
    },
  };
  zip.addFile("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

  return zip;
}

/** Add history rows as JSONL to an existing zip. */
export function addHistoryToArchive(zip: AdmZip, rows: Array<Record<string, unknown>>): void {
  if (rows.length === 0) return;
  const lines = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  zip.addFile("history.jsonl", Buffer.from(lines));
}

/** Read and validate the manifest from a .volute archive. */
export function readManifest(archivePath: string): ExportManifest {
  const zip = new AdmZip(archivePath);
  const entry = zip.getEntry("manifest.json");
  if (!entry) {
    throw new Error("Invalid archive: missing manifest.json");
  }
  const manifest = JSON.parse(entry.getData().toString("utf-8")) as ExportManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported archive version: ${manifest.version}`);
  }
  return manifest;
}

/**
 * Overlay a home-only archive's `home/` onto a freshly composed template's,
 * honouring the mind's refusals.
 *
 * The mind's own files winning over the template's defaults has always been
 * this step, and now that the archive carries `home/.local/` (#1013) that alone
 * preserves a hook the mind *edited*. A hook the mind *deleted* needs one thing
 * more, because absence in the archive is ambiguous in exactly the way #811
 * exists to resolve: "this mind removed it" and "this hook shipped after the
 * export" look identical, and guessing wrong either overrides the mind's own
 * authorship or withholds machinery from a mind that never declined it (#808).
 *
 * `given` — the exporting host's ledger, travelling with the archive — is what
 * separates them. A path that host recorded as given, and that the archive does
 * not carry, is a deletion the mind meant; it is removed from the fresh
 * template. A path absent from both is simply newer than the archive, and the
 * template's copy stands. An archive with no ledger says nothing about either,
 * so nothing is removed: that is every pre-#1013 archive.
 *
 * `given` is untrusted archive content, so each entry must be inside the
 * infrastructure namespace and must resolve within `destHome` before it can
 * delete anything.
 */
export function overlayArchiveHome(
  archiveHome: string,
  destHome: string,
  given: Iterable<string>,
): void {
  if (!existsSync(archiveHome)) return;

  for (const rel of given) {
    // Contain first, then judge the *contained* path: `.local/../.config` is
    // inside destHome and would pass a raw prefix test, which would let a
    // crafted archive delete freshly composed files outside the namespace.
    const target = safeResolveWithinBase(destHome, rel);
    if (!target) continue;
    const contained = relative(destHome, target);
    if (!isInitInfrastructure(contained)) continue;
    if (existsSync(resolve(archiveHome, contained))) continue;
    rmSync(target, { recursive: true, force: true });
  }

  cpSync(archiveHome, destHome, { recursive: true });
}

/** Extract a .volute archive to a destination directory.
 *  Returns the manifest and paths to extracted state files. */
export function extractArchive(
  archivePath: string,
  destDir: string,
): {
  manifest: ExportManifest;
  mindDir: string;
  envJson: string | null;
  historyJsonl: string | null;
  sessionsDir: string | null;
} {
  const zip = new AdmZip(archivePath);

  // Read manifest from the already-opened zip
  const manifestEntry = zip.getEntry("manifest.json");
  if (!manifestEntry) {
    throw new Error("Invalid archive: missing manifest.json");
  }
  const manifest = JSON.parse(manifestEntry.getData().toString("utf-8")) as ExportManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported archive version: ${manifest.version}`);
  }

  const normalizedDestDir = resolve(destDir);
  const extractedMindDir = resolve(normalizedDestDir, "mind");
  const extractedStateDir = resolve(normalizedDestDir, "state");
  mkdirSync(extractedMindDir, { recursive: true });
  mkdirSync(extractedStateDir, { recursive: true });

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName;

    if (name === "manifest.json") continue;

    const destPath = resolve(normalizedDestDir, name);
    // Prevent zip-slip path traversal
    if (!destPath.startsWith(`${normalizedDestDir}/`)) {
      throw new Error(`Archive contains path traversal entry: ${name}`);
    }
    mkdirSync(resolve(destPath, ".."), { recursive: true });
    writeFileSync(destPath, entry.getData());

    // Restore the executable bit, and only that. An archive is untrusted input:
    // taking its mode verbatim would let one plant a setuid file in a directory
    // the daemon then chowns to a mind. Non-executable entries are left at
    // whatever the write produced, so a strict umask is not widened either.
    if ((entry.header.fileAttr & 0o111) !== 0) chmodSync(destPath, 0o755);
  }

  const envJson = resolve(extractedStateDir, "env.json");
  const historyJsonl = resolve(normalizedDestDir, "history.jsonl");
  const sessionsDir = resolve(normalizedDestDir, "sessions");

  return {
    manifest,
    mindDir: extractedMindDir,
    envJson: existsSync(envJson) ? envJson : null,
    historyJsonl: existsSync(historyJsonl) ? historyJsonl : null,
    sessionsDir: existsSync(sessionsDir) ? sessionsDir : null,
  };
}

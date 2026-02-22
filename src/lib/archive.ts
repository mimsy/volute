import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import AdmZip from "adm-zip";
import { mindDir, stateDir } from "./registry.js";

export type ExportManifest = {
  version: 1;
  name: string;
  template: string;
  voluteVersion: string;
  exportedAt: string;
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

/** Create an export archive zip from a mind. */
export function createExportArchive(options: ExportOptions): AdmZip {
  const {
    name,
    template,
    includeEnv = false,
    includeIdentity = false,
    includeConnectors = false,
    includeHistory = false,
    includeSessions = false,
  } = options;

  const dir = mindDir(name);
  const state = stateDir(name);
  const zip = new AdmZip();

  // Walk mind directory, skipping node_modules, .variants, .git
  const files = walkDir(dir, undefined, includeSessions);
  for (const relPath of files) {
    // Skip identity files unless included
    if (!includeIdentity && relPath.startsWith(join(".mind", "identity"))) continue;

    // Skip connector configs unless included
    if (!includeConnectors && relPath.startsWith(join(".mind", "connectors"))) continue;

    const fullPath = resolve(dir, relPath);
    zip.addFile(`mind/${relPath}`, readFileSync(fullPath));
  }

  // Always include channels.json from state dir
  if (existsSync(state)) {
    const channelsPath = resolve(state, "channels.json");
    if (existsSync(channelsPath)) {
      zip.addFile("state/channels.json", readFileSync(channelsPath));
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

/** Extract a .volute archive to a destination directory.
 *  Returns the manifest and paths to extracted state files. */
export function extractArchive(
  archivePath: string,
  destDir: string,
): {
  manifest: ExportManifest;
  mindDir: string;
  channelsJson: string | null;
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
  }

  const channelsJson = resolve(extractedStateDir, "channels.json");
  const envJson = resolve(extractedStateDir, "env.json");
  const historyJsonl = resolve(normalizedDestDir, "history.jsonl");
  const sessionsDir = resolve(normalizedDestDir, "sessions");

  return {
    manifest,
    mindDir: extractedMindDir,
    channelsJson: existsSync(channelsJson) ? channelsJson : null,
    envJson: existsSync(envJson) ? envJson : null,
    historyJsonl: existsSync(historyJsonl) ? historyJsonl : null,
    sessionsDir: existsSync(sessionsDir) ? sessionsDir : null,
  };
}

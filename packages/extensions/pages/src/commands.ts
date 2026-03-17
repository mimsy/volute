import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { ExtensionCommand } from "@volute/extensions";

import { getPublishedPages, syncPublishedPages } from "./db.js";

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    publish: {
      description: "Publish all pages (copy to public snapshot)",
      usage: "volute pages publish [--remote]",
      handler: async (args, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const remote = args.includes("--remote");

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const sourceDir = resolve(mindDir, "home", "public", "pages");
        if (!existsSync(sourceDir))
          return { error: "No pages directory found (home/public/pages/)" };

        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        // Copy entire directory to snapshot location (clean first for removals)
        const snapshotDir = resolve(ctx.dataDir, "sites", mindName);
        if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true });
        cpSync(sourceDir, snapshotDir, { recursive: true });

        // Scan snapshot for .html files
        const htmlFiles = collectHtmlFiles(snapshotDir, snapshotDir);

        // Sync DB and get diff
        const diff = syncPublishedPages(db, mindName, htmlFiles);

        // Fire activity events for changes
        for (const file of diff.added) {
          ctx.publishActivity({
            type: "page_published",
            mind: mindName,
            summary: `${mindName} published ${file}`,
            metadata: { file, iframeUrl: `/ext/pages/public/${mindName}/${file}` },
          });
        }
        for (const file of diff.removed) {
          ctx.publishActivity({
            type: "page_removed",
            mind: mindName,
            summary: `${mindName} removed ${file}`,
            metadata: { file },
          });
        }

        let output = `Published ${htmlFiles.length} files`;
        const parts: string[] = [];
        if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
        if (diff.updated.length > 0) parts.push(`${diff.updated.length} updated`);
        if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
        if (parts.length > 0) output += ` (${parts.join(", ")})`;

        if (remote) {
          const config = ctx.getSystemsConfig();
          if (!config)
            return {
              error: "Not connected to volute.systems. Run volute systems register or login first.",
            };

          // Collect all files from snapshot as base64
          const allFiles = collectAllFiles(snapshotDir, snapshotDir);
          const files: Record<string, string> = {};
          for (const f of allFiles) {
            const fp = resolve(snapshotDir, f);
            files[f] = readFileSync(fp).toString("base64");
          }

          try {
            const res = await fetch(`${config.apiUrl}/api/pages/publish/${mindName}`, {
              method: "PUT",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${config.apiKey}`,
              },
              body: JSON.stringify({ files }),
            });
            const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
            if (!res.ok)
              return { error: data.error || `Remote publish failed: HTTP ${res.status}` };
            if (data.url) output += `\nRemote: ${data.url}`;
          } catch (err) {
            return { error: `Remote publish failed: ${(err as Error).message}` };
          }
        }

        return { output };
      },
    },

    list: {
      description: "List pages with publish status",
      usage: "volute pages list [--all]",
      handler: async (args, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        const allFlag = args.includes("--all");
        const port = process.env.VOLUTE_DAEMON_PORT || "1618";

        if (allFlag) {
          const { getAllSites } = await import("./db.js");
          const sites = getAllSites(db);
          const lines: string[] = [];

          for (const site of sites) {
            for (const f of site.files) {
              const url = `http://localhost:${port}/ext/pages/public/${site.mind}/${f.file}`;
              lines.push(`${site.mind.padEnd(15)} ${f.file.padEnd(25)} ${url}`);
            }
          }

          return { output: lines.length > 0 ? lines.join("\n") : "No published pages found." };
        }

        // List current mind's pages with status
        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const sourceDir = resolve(mindDir, "home", "public", "pages");
        const published = new Set(getPublishedPages(db, mindName).map((p) => p.file));
        const draftFiles = existsSync(sourceDir) ? collectHtmlFiles(sourceDir, sourceDir) : [];
        const allFiles = new Set([...published, ...draftFiles]);

        if (allFiles.size === 0) return { output: "No pages found." };

        const lines = [...allFiles].sort().map((file) => {
          const isPublished = published.has(file);
          const status = isPublished ? "published" : "draft";
          const url = isPublished
            ? `http://localhost:${port}/ext/pages/public/${mindName}/${file}`
            : "";
          return `${status.padEnd(11)} ${file.padEnd(25)} ${url}`;
        });

        return { output: lines.join("\n") };
      },
    },
  };
}

/** Recursively collect .html files, returning paths relative to baseDir */
function collectHtmlFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return files;
  }

  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = resolve(dir, item);
    try {
      const s = statSync(fullPath);
      if (s.isFile() && item.endsWith(".html")) {
        files.push(relative(baseDir, fullPath));
      } else if (s.isDirectory()) {
        files.push(...collectHtmlFiles(fullPath, baseDir));
      }
    } catch {
      // skip
    }
  }

  return files.sort();
}

/** Recursively collect all files, returning paths relative to baseDir */
function collectAllFiles(dir: string, baseDir: string): string[] {
  const files: string[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch {
    return files;
  }

  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = resolve(dir, item);
    try {
      const s = statSync(fullPath);
      if (s.isFile()) {
        files.push(relative(baseDir, fullPath));
      } else if (s.isDirectory()) {
        files.push(...collectAllFiles(fullPath, baseDir));
      }
    } catch {
      // skip
    }
  }

  return files.sort();
}

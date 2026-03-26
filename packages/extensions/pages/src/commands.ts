import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { ExtensionCommand } from "@volute/extensions";

import { getPublishedPages, syncPublishedPages, syncSystemPages } from "./db.js";
import {
  collectHtmlFiles,
  isolationFrom,
  pagesLog,
  pagesPull,
  pagesPullAndMerge,
  pagesStatus,
} from "./shared-pages.js";

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    publish: {
      description: "Publish all pages (copy to public snapshot)",
      args: [{ name: "message", description: "Commit message for shared publish" }],
      flags: {
        remote: { type: "boolean", description: "Also publish to volute.systems" },
        shared: { type: "boolean", description: "Publish to shared pages repository" },
      },
      handler: async ({ args, flags }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        if (flags.shared) {
          const mindDir = ctx.getMindDir(mindName);
          if (!mindDir) return { error: `Mind not found: ${mindName}` };

          const message = args.message?.trim();
          if (!message)
            return { error: 'Usage: volute pages publish --shared "description of changes"' };

          try {
            const result = await pagesPullAndMerge(
              mindName,
              mindDir,
              ctx.dataDir,
              message,
              isolationFrom(ctx),
            );
            if (!result.ok) {
              return {
                error:
                  result.message || "Merge conflicts detected — pull, reconcile, and try again.",
              };
            }

            // Sync system pages to DB so they appear in the UI
            let syncWarning = "";
            if (result.ok && ctx.db) {
              const repoDir = resolve(ctx.dataDir, "repo");
              try {
                syncSystemPages(ctx.db, collectHtmlFiles(repoDir), mindName);
              } catch (err) {
                console.error("[pages] failed to sync system pages to DB:", err);
                syncWarning =
                  "\nWarning: failed to sync pages to dashboard — they may not appear in the UI until the next daemon restart.";
              }
            }

            return { output: (result.message || "Published shared pages.") + syncWarning };
          } catch (err) {
            return { error: `Shared publish failed: ${(err as Error).message}` };
          }
        }

        const remote = flags.remote as boolean;

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const sourceDir = resolve(mindDir, "home", "pages");
        if (!existsSync(sourceDir)) return { error: "No pages directory found (home/pages/)" };

        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        // Copy entire directory to snapshot location (clean first for removals).
        // Exclude _system/ which is the shared pages git worktree.
        const snapshotDir = resolve(ctx.dataDir, "sites", mindName);
        try {
          if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true });
          cpSync(sourceDir, snapshotDir, {
            recursive: true,
            filter: (src) => !src.endsWith("/_system") && !src.includes("/_system/"),
          });
        } catch (err) {
          return { error: `Failed to publish snapshot: ${(err as Error).message}` };
        }

        // Scan snapshot for page files (.html and .md)
        const pageFiles = collectFiles(snapshotDir, snapshotDir, [".html", ".md"]);

        // Sync DB and get diff
        let diff: { added: string[]; removed: string[]; updated: string[] };
        try {
          diff = syncPublishedPages(db, mindName, pageFiles);
        } catch (err) {
          return { error: `Failed to update page database: ${(err as Error).message}` };
        }

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

        let output = `Published ${pageFiles.length} files`;
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
          const allFiles = collectFiles(snapshotDir, snapshotDir);
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
            if (!res.ok) {
              const errMsg = data.error || `HTTP ${res.status}`;
              output += `\nWarning: remote publish failed: ${errMsg}`;
            } else if (data.url) {
              output += `\nRemote: ${data.url}`;
            }
          } catch (err) {
            output += `\nWarning: remote publish failed: ${(err as Error).message}`;
          }
        }

        return { output };
      },
    },

    list: {
      description: "List pages with publish status",
      flags: {
        all: { type: "boolean", description: "Show pages from all minds" },
        shared: { type: "boolean", description: "Show shared pages status" },
      },
      handler: async ({ flags }, ctx) => {
        const db = ctx.db;
        if (!db) return { error: "Database not available" };

        const allFlag = flags.all as boolean;
        const port = process.env.VOLUTE_DAEMON_PORT || "1618";

        if (allFlag) {
          const { getAllSites, getSystemPages } = await import("./db.js");
          const sites = getAllSites(db);
          const system = getSystemPages(db);
          const lines: string[] = [];

          if (system) {
            for (const f of system.files) {
              const url = `http://localhost:${port}/ext/pages/public/_system/${f.file}`;
              const author = f.author ? ` (${f.author})` : "";
              lines.push(`_system${author.padStart(10)} ${f.file.padEnd(25)} ${url}`);
            }
          }
          for (const site of sites) {
            for (const f of site.files) {
              const url = `http://localhost:${port}/ext/pages/public/${site.mind}/${f.file}`;
              lines.push(`${site.mind.padEnd(15)} ${f.file.padEnd(25)} ${url}`);
            }
          }

          return { output: lines.length > 0 ? lines.join("\n") : "No published pages found." };
        }

        // Remaining modes require a mind
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        if (flags.shared) {
          const mindDir = ctx.getMindDir(mindName);
          if (!mindDir) return { error: `Mind not found: ${mindName}` };

          try {
            const status = await pagesStatus(mindDir, isolationFrom(ctx));
            return { output: status };
          } catch (err) {
            return { error: `Failed to check shared status: ${(err as Error).message}` };
          }
        }

        // List current mind's pages with status
        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const sourceDir = resolve(mindDir, "home", "pages");
        const published = new Set(getPublishedPages(db, mindName).map((p) => p.file));
        const draftFiles = existsSync(sourceDir)
          ? collectFiles(sourceDir, sourceDir, [".html", ".md"])
          : [];
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

    pull: {
      description: "Pull latest shared page changes from other minds",
      handler: async (_parsed, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        try {
          const result = await pagesPull(mindName, mindDir, isolationFrom(ctx));
          if (!result.ok) {
            return { error: result.message || "Pull failed." };
          }
          return { output: result.message || "Pulled latest shared changes." };
        } catch (err) {
          return { error: `Pull failed: ${(err as Error).message}` };
        }
      },
    },

    log: {
      description: "View shared pages commit history",
      flags: {
        limit: { type: "number", description: "Max number of entries to show (default: 20)" },
      },
      handler: async ({ flags }, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const limit = (flags.limit as number | undefined) ?? 20;

        try {
          const output = await pagesLog(mindDir, limit, isolationFrom(ctx));
          return { output };
        } catch (err) {
          return { error: `Failed to read shared log: ${(err as Error).message}` };
        }
      },
    },
  };
}

/** Recursively collect files, returning paths relative to baseDir. Optionally filter by extension(s). */
function collectFiles(dir: string, baseDir: string, ext?: string | string[]): string[] {
  const files: string[] = [];
  let items: string[];
  try {
    items = readdirSync(dir);
  } catch (err) {
    console.error(`[pages] failed to read directory ${dir}: ${(err as Error).message}`);
    return files;
  }

  for (const item of items) {
    if (item.startsWith(".")) continue;
    const fullPath = resolve(dir, item);
    try {
      const s = statSync(fullPath);
      const matchesExt =
        !ext || (Array.isArray(ext) ? ext.some((e) => item.endsWith(e)) : item.endsWith(ext));
      if (s.isFile() && matchesExt) {
        files.push(relative(baseDir, fullPath));
      } else if (s.isDirectory()) {
        files.push(...collectFiles(fullPath, baseDir, ext));
      }
    } catch (err) {
      console.error(`[pages] failed to stat ${fullPath}: ${(err as Error).message}`);
    }
  }

  return files.sort();
}

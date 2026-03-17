import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExtensionCommand } from "@volute/extensions";

import { invalidateCache } from "./cache.js";
import { isPublished, publishPage, readManifest, unpublishPage } from "./manifest.js";

export function createCommands(): Record<string, ExtensionCommand> {
  return {
    publish: {
      description: "Publish a page (make it publicly accessible)",
      usage: "volute pages publish <file> [--remote]",
      handler: async (args, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const remoteIdx = args.indexOf("--remote");
        const remote = remoteIdx !== -1;
        const fileArgs = remote
          ? [...args.slice(0, remoteIdx), ...args.slice(remoteIdx + 1)]
          : args;

        const file = fileArgs[0];
        if (!file) return { error: "Usage: volute pages publish <file> [--remote]" };

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const pagesDir = resolve(mindDir, "home", "public", "pages");
        const filePath = resolve(pagesDir, file);

        // Ensure the file is within pagesDir
        if (!filePath.startsWith(pagesDir + "/"))
          return { error: "File must be within pages directory" };
        if (!existsSync(filePath)) return { error: `File not found: ${file}` };

        publishPage(pagesDir, file);
        invalidateCache();

        ctx.publishActivity({
          type: "page_published",
          mind: mindName,
          summary: `${mindName} published ${file}`,
          metadata: { file, iframeUrl: `/ext/pages/public/${mindName}/${file}` },
        });

        let output = `Published: ${file}`;

        if (remote) {
          const config = ctx.getSystemsConfig();
          if (!config)
            return {
              error: "Not connected to volute.systems. Run volute systems register or login first.",
            };

          // Collect all published files and send them
          const manifest = readManifest(pagesDir);
          const files: Record<string, string> = {};
          for (const f of Object.keys(manifest.pages)) {
            const fp = resolve(pagesDir, f);
            if (existsSync(fp)) {
              files[f] = readFileSync(fp).toString("base64");
            }
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

    unpublish: {
      description: "Unpublish a page (stop serving it publicly)",
      usage: "volute pages unpublish <file>",
      handler: async (args, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const file = args[0];
        if (!file) return { error: "Usage: volute pages unpublish <file>" };

        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const pagesDir = resolve(mindDir, "home", "public", "pages");
        if (!isPublished(pagesDir, file)) return { error: `Not published: ${file}` };

        unpublishPage(pagesDir, file);
        invalidateCache();

        return { output: `Unpublished: ${file}` };
      },
    },

    list: {
      description: "List pages with publish status",
      usage: "volute pages list [--all]",
      handler: async (args, ctx) => {
        const mindName = ctx.mindName;
        if (!mindName) return { error: "No mind specified (use --mind or VOLUTE_MIND)" };

        const allFlag = args.includes("--all");
        const port = process.env.VOLUTE_DAEMON_PORT || "1618";

        if (allFlag) {
          // List all minds' published pages
          const { readRegistry } = await import("../../../../src/lib/registry.js");
          const entries = await readRegistry();
          const lines: string[] = [];

          for (const entry of entries) {
            const dir = ctx.getMindDir(entry.name);
            if (!dir) continue;
            const pagesDir = resolve(dir, "home", "public", "pages");
            if (!existsSync(pagesDir)) continue;

            const manifest = readManifest(pagesDir);
            for (const file of Object.keys(manifest.pages)) {
              const url = `http://localhost:${port}/ext/pages/public/${entry.name}/${file}`;
              lines.push(`${entry.name.padEnd(15)} ${file.padEnd(25)} ${url}`);
            }
          }

          return { output: lines.length > 0 ? lines.join("\n") : "No published pages found." };
        }

        // List current mind's pages with status
        const mindDir = ctx.getMindDir(mindName);
        if (!mindDir) return { error: `Mind not found: ${mindName}` };

        const pagesDir = resolve(mindDir, "home", "public", "pages");
        if (!existsSync(pagesDir)) return { output: "No pages directory found." };

        const manifest = readManifest(pagesDir);
        const files = collectPageFiles(pagesDir);
        if (files.length === 0) return { output: "No pages found." };

        const lines = files.map((file) => {
          const published = file in manifest.pages;
          const status = published ? "published" : "draft";
          const url = published
            ? `http://localhost:${port}/ext/pages/public/${mindName}/${file}`
            : "";
          return `${status.padEnd(11)} ${file.padEnd(25)} ${url}`;
        });

        return { output: lines.join("\n") };
      },
    },
  };
}

function collectPageFiles(pagesDir: string): string[] {
  const files: string[] = [];
  let items: string[];
  try {
    items = readdirSync(pagesDir);
  } catch {
    return files;
  }

  for (const item of items) {
    if (item.startsWith(".") || item === "pages.json") continue;
    const fullPath = resolve(pagesDir, item);
    try {
      const s = statSync(fullPath);
      if (s.isFile() && item.endsWith(".html")) {
        files.push(item);
      } else if (s.isDirectory()) {
        const indexPath = resolve(fullPath, "index.html");
        if (existsSync(indexPath)) {
          files.push(join(item, "index.html"));
        }
      }
    } catch {
      // skip
    }
  }

  return files.sort();
}

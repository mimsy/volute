#!/usr/bin/env node

// Standalone Volute web UI server.
// Serves the built Svelte SPA and lets users connect to any Volute daemon.
// Usage: volute-web [--port 3000]

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ASSETS_DIR = resolve(__dirname, "assets");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseArgs(): { port: number } {
  let port = 1619;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      if (Number.isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${args[i + 1]}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === "--help" || args[i] === "-h") {
      console.log("Usage: volute-web [--port 1619]");
      console.log("");
      console.log("Serves the Volute web UI as a standalone app.");
      console.log("On first load, enter your Volute daemon address to connect.");
      process.exit(0);
    }
  }
  return { port };
}

function serveFile(filePath: string, res: import("node:http").ServerResponse): boolean {
  if (!existsSync(filePath)) return false;
  const stat = statSync(filePath);
  if (!stat.isFile()) return false;

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

const { port } = parseArgs();

if (!existsSync(ASSETS_DIR)) {
  console.error(`Assets not found at ${ASSETS_DIR}`);
  console.error("Run 'npm run build' in the @volute/web package first.");
  process.exit(1);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  const pathname = url.pathname;

  // Prevent path traversal
  if (pathname.includes("..")) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  // Try to serve the exact file
  const filePath = join(ASSETS_DIR, pathname);
  if (serveFile(filePath, res)) return;

  // SPA fallback: serve index.html for any non-file path
  const indexPath = join(ASSETS_DIR, "index.html");
  if (serveFile(indexPath, res)) return;

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`Volute Web UI running at http://localhost:${port}/`);
  console.log("Connect to your Volute daemon from the browser.");
});

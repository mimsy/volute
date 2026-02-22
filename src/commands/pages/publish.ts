import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "../../lib/parse-args.js";
import { mindDir } from "../../lib/registry.js";
import { resolveMindName } from "../../lib/resolve-mind-name.js";
import { sharedDir } from "../../lib/shared.js";
import { readSystemsConfig } from "../../lib/systems-config.js";
import { systemsFetch } from "../../lib/systems-fetch.js";

export async function run(args: string[]) {
  const { flags } = parseArgs(args, {
    mind: { type: "string" },
  });

  const config = readSystemsConfig();
  if (!config) {
    console.error('Not logged in. Run "volute pages register" or "volute pages login" first.');
    process.exit(1);
  }

  // If no mind specified, publish system-level pages from the shared repo
  const hasMind = flags.mind || process.env.VOLUTE_MIND;
  let mindName: string;
  let pagesDir: string;

  if (hasMind) {
    mindName = resolveMindName(flags);
    pagesDir = resolve(mindDir(mindName), "home", "pages");
  } else {
    mindName = "system";
    pagesDir = resolve(sharedDir(), "pages");
  }

  if (!existsSync(pagesDir)) {
    console.error(`No pages/ directory found at ${pagesDir}`);
    process.exit(1);
  }

  const files = collectFiles(pagesDir);
  if (Object.keys(files).length === 0) {
    console.error("pages/ directory is empty.");
    process.exit(1);
  }

  console.log(`Publishing ${Object.keys(files).length} file(s) for ${mindName}...`);

  const res = await systemsFetch(`${config.apiUrl}/api/pages/publish/${mindName}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ files }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
      error: string;
    };
    console.error(`Publish failed: ${body.error}`);
    process.exit(1);
  }

  const { url, fileCount } = (await res.json()) as { url: string; fileCount: number };
  console.log(`Published ${fileCount} file(s) to ${url}`);
}

export function collectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const full = resolve(current, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const rel = relative(dir, full);
        files[rel] = readFileSync(full).toString("base64");
      }
    }
  }

  walk(dir);
  return files;
}

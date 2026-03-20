#!/usr/bin/env tsx

/**
 * imagegen.ts — image generation via daemon service or direct Replicate API
 *
 * Usage:
 *   imagegen generate "prompt" [--model M] [--filename F]   # generate an image
 *   imagegen models "query"                                 # search for models
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

function getHomePath(): string {
  const mindDir = process.env.VOLUTE_MIND_DIR;
  if (!mindDir) throw new Error("VOLUTE_MIND_DIR not set");
  return join(mindDir, "home");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function getDaemonUrl(): string | undefined {
  const port = process.env.VOLUTE_DAEMON_PORT;
  if (!port) return undefined;
  return `http://127.0.0.1:${port}`;
}

function getDaemonToken(): string | undefined {
  return process.env.VOLUTE_DAEMON_TOKEN;
}

/** Returns null only when the daemon is unreachable or imagegen is not configured. */
async function generateViaDaemon(model: string, prompt: string): Promise<Buffer | null> {
  const base = getDaemonUrl();
  const token = getDaemonToken();
  if (!base || !token) return null;

  try {
    const res = await fetch(`${base}/api/v1/system/imagegen/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model, prompt }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      // Not configured — fall back to direct Replicate
      if (err.error?.includes("No Replicate API key")) return null;
      throw new Error(err.error || `Daemon returned ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Connection failure — daemon unreachable, fall back to direct
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/** Returns null only when the daemon is unreachable or endpoint doesn't exist. */
async function searchViaDaemon(query: string): Promise<unknown[] | null> {
  const base = getDaemonUrl();
  const token = getDaemonToken();
  if (!base || !token) return null;

  try {
    const res = await fetch(
      `${base}/api/v1/system/imagegen/models/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      // 404 = older daemon without this endpoint — fall back silently
      if (res.status === 404) return null;
      const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as {
        error: string;
      };
      console.error(`daemon model search failed: ${body.error || res.status}`);
      return null;
    }
    return (await res.json()) as unknown[];
  } catch (err) {
    // Connection failure — daemon unreachable
    if (err instanceof TypeError) return null;
    console.error(`daemon model search error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function generateDirect(model: string, prompt: string): Promise<Buffer> {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw new Error(
      "No image generation configured. Ask an admin to set up a provider in Settings, or set REPLICATE_API_TOKEN.",
    );
  }
  const { default: Replicate } = await import("replicate");
  const replicate = new Replicate();

  const output = await replicate.run(model as `${string}/${string}`, { input: { prompt } });
  const file = Array.isArray(output) ? output[0] : output;
  if (!file) throw new Error(`Model ${model} returned no output`);

  const chunks: Uint8Array[] = [];
  for await (const chunk of file as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function generate(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    console.log('Usage: imagegen generate "prompt" [--model M] [--filename F]');
    process.exit(1);
  }

  const model = getFlag(args, "--model") || "prunaai/z-image-turbo";
  const filename = getFlag(args, "--filename") || slugify(prompt) || `image-${Date.now()}`;

  console.log(`generating image with ${model}...`);

  // Try daemon first, fall back to direct Replicate
  let buf = await generateViaDaemon(model, prompt);
  if (!buf) {
    buf = await generateDirect(model, prompt);
  }

  const imagesDir = join(getHomePath(), "images");
  mkdirSync(imagesDir, { recursive: true });

  const filePath = join(imagesDir, `${filename}.png`);
  await writeFile(filePath, buf);
  console.log(`saved: ${filePath}`);
}

async function models(args: string[]): Promise<void> {
  const query = args[0];
  if (!query) {
    console.log('Usage: imagegen models "query"');
    process.exit(1);
  }

  // Try daemon first
  const daemonResults = await searchViaDaemon(query);
  if (daemonResults && daemonResults.length > 0) {
    for (const m of daemonResults as Array<{ id: string; description?: string }>) {
      const desc = m.description ? ` — ${m.description.slice(0, 100)}` : "";
      console.log(`${m.id}${desc}`);
    }
    return;
  }

  // Fall back to direct Replicate
  if (!process.env.REPLICATE_API_TOKEN) {
    console.error(
      "No image generation configured. Ask an admin to set up a provider in Settings, or set REPLICATE_API_TOKEN.",
    );
    process.exit(1);
  }

  const { default: Replicate } = await import("replicate");
  const replicate = new Replicate();

  const response = await replicate.models.search(query);
  const results = response.results.slice(0, 10);

  if (results.length === 0) {
    console.log("no models found.");
    return;
  }

  for (const m of results) {
    const desc = m.description ? ` — ${m.description.slice(0, 100)}` : "";
    console.log(`${m.owner}/${m.name}${desc}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.log("Usage: imagegen <generate|models> [args]");
    process.exit(0);
  }

  if (cmd === "generate") {
    await generate(args.slice(1));
  } else if (cmd === "models") {
    await models(args.slice(1));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url === `file://${resolve(process.argv[1])}`);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

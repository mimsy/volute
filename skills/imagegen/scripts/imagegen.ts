#!/usr/bin/env tsx

/**
 * imagegen.ts — image generation via daemon service or direct Replicate API
 *
 * Usage:
 *   imagegen generate "prompt" [--model M] [--filename F]   # generate an image
 *   imagegen models "query"                                 # search for models
 *
 * Model IDs are provider-prefixed: replicate:owner/model, openrouter:owner/model
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
  return process.env.VOLUTE_MIND_TOKEN;
}

/**
 * Outcome of a daemon call, distinguishing the failure modes so the mind gets an
 * accurate diagnosis instead of a misleading "not configured" message:
 *  - no-env      — not running under a Volute mind environment (env vars unset)
 *  - unreachable — daemon env is set but the connection failed (daemon down)
 *  - auth        — daemon rejected the mind's token (401/403)
 *  - fallback    — daemon can't serve this (imagegen not configured, or old daemon)
 */
export type DaemonFailure =
  | { ok: false; reason: "no-env" }
  | { ok: false; reason: "unreachable"; detail: string }
  | { ok: false; reason: "auth"; status: number; detail: string }
  | { ok: false; reason: "fallback" };
export type DaemonResult<T> = { ok: true; value: T } | DaemonFailure;

async function readDaemonError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `HTTP ${res.status}`;
}

/**
 * Acts on a daemon failure: prints an informational note and returns when the
 * caller should fall back to a direct provider (no-env / fallback), or throws a
 * clear diagnosis for local problems that direct fallback would only mask
 * (unreachable / auth).
 */
export function handleDaemonFailure(failure: DaemonFailure): void {
  switch (failure.reason) {
    case "no-env":
      console.error(
        "Not running under a Volute mind environment; falling back to direct provider.",
      );
      return;
    case "unreachable":
      throw new Error(
        `Could not reach the Volute daemon at ${getDaemonUrl()}: ${failure.detail}. ` +
          "The daemon may be down — this is a local connection problem, not a provider-configuration issue.",
      );
    case "auth":
      throw new Error(
        `The Volute daemon rejected this mind's token (HTTP ${failure.status}: ${failure.detail}). ` +
          "Check VOLUTE_MIND_TOKEN — this is an authentication problem, not a provider-configuration issue.",
      );
    case "fallback":
      return;
  }
}

export async function generateViaDaemon(
  model: string,
  prompt: string,
): Promise<DaemonResult<Buffer>> {
  const base = getDaemonUrl();
  const token = getDaemonToken();
  if (!base || !token) return { ok: false, reason: "no-env" };

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/system/imagegen/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ model, prompt }),
    });
  } catch (err) {
    if (err instanceof TypeError) {
      return { ok: false, reason: "unreachable", detail: err.message };
    }
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "auth", status: res.status, detail: await readDaemonError(res) };
  }
  if (!res.ok) {
    const err = await readDaemonError(res);
    // Genuinely not configured — fall back to direct provider.
    if (/not configured/i.test(err) || /No .* API key/i.test(err)) {
      return { ok: false, reason: "fallback" };
    }
    throw new Error(err);
  }
  return { ok: true, value: Buffer.from(await res.arrayBuffer()) };
}

export async function searchViaDaemon(query: string): Promise<DaemonResult<unknown[]>> {
  const base = getDaemonUrl();
  const token = getDaemonToken();
  if (!base || !token) return { ok: false, reason: "no-env" };

  let res: Response;
  try {
    res = await fetch(
      `${base}/api/v1/system/imagegen/models/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    if (err instanceof TypeError) {
      return { ok: false, reason: "unreachable", detail: err.message };
    }
    throw err;
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "auth", status: res.status, detail: await readDaemonError(res) };
  }
  // 404 = older daemon without this endpoint; other non-ok — fall back to direct search.
  if (!res.ok) return { ok: false, reason: "fallback" };
  return { ok: true, value: (await res.json()) as unknown[] };
}

async function generateDirect(model: string, prompt: string): Promise<Buffer> {
  // Parse provider prefix — direct fallback only supports replicate
  let replicateModel = model;
  const colonIdx = model.indexOf(":");
  if (colonIdx !== -1) {
    const provider = model.slice(0, colonIdx);
    if (provider !== "replicate") {
      throw new Error(
        `Direct generation only supports replicate: prefix. Configure ${provider} via Settings.`,
      );
    }
    replicateModel = model.slice(colonIdx + 1);
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    throw new Error(
      "No image generation configured. Ask an admin to set up a provider in Settings, or set REPLICATE_API_TOKEN.",
    );
  }
  const { default: Replicate } = await import("replicate");
  const replicate = new Replicate();

  const output = await replicate.run(replicateModel as `${string}/${string}`, {
    input: { prompt },
  });
  const file = Array.isArray(output) ? output[0] : output;
  if (!file) throw new Error(`Model ${replicateModel} returned no output`);

  const chunks: Uint8Array[] = [];
  for await (const chunk of file as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchDefaultModel(): Promise<string | null> {
  const base = getDaemonUrl();
  const token = getDaemonToken();
  if (!base || !token) return null;

  try {
    const res = await fetch(`${base}/api/v1/system/imagegen/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { defaultModel?: string | null };
    return data.defaultModel ?? null;
  } catch {
    return null;
  }
}

async function generate(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    console.log('Usage: imagegen generate "prompt" [--model M] [--filename F]');
    process.exit(1);
  }

  const flagModel = getFlag(args, "--model");
  const model = flagModel || (await fetchDefaultModel()) || "replicate:prunaai/z-image-turbo";
  const filename = getFlag(args, "--filename") || slugify(prompt) || `image-${Date.now()}`;

  console.log(`generating image with ${model}...`);

  // Try daemon first, fall back to direct Replicate.
  const daemonRes = await generateViaDaemon(model, prompt);
  let buf: Buffer;
  if (daemonRes.ok) {
    buf = daemonRes.value;
  } else {
    handleDaemonFailure(daemonRes); // throws for unreachable/auth; returns to fall back otherwise
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

  // Try daemon first.
  const daemonRes = await searchViaDaemon(query);
  if (daemonRes.ok && daemonRes.value.length > 0) {
    for (const m of daemonRes.value as Array<{ id: string; description?: string }>) {
      const desc = m.description ? ` — ${m.description.slice(0, 100)}` : "";
      console.log(`${m.id}${desc}`);
    }
    return;
  }
  if (!daemonRes.ok) {
    handleDaemonFailure(daemonRes); // throws for unreachable/auth; returns to fall back otherwise
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
    console.log(`replicate:${m.owner}/${m.name}${desc}`);
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

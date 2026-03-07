#!/usr/bin/env tsx

/**
 * imagegen.ts — image generation via Replicate API
 *
 * Usage:
 *   imagegen generate "prompt" [--model M] [--filename F]   # generate an image
 *   imagegen models "query"                                 # search for models
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const replicateRequire = createRequire(import.meta.url);

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

async function generate(args: string[]): Promise<void> {
  const prompt = args[0];
  if (!prompt) {
    console.log('Usage: imagegen generate "prompt" [--model M] [--filename F]');
    process.exit(1);
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    console.error(
      "REPLICATE_API_TOKEN not set. Run: volute env set REPLICATE_API_TOKEN <your-token>",
    );
    process.exit(1);
  }

  const model = getFlag(args, "--model") || "prunaai/z-image-turbo";
  const filename = getFlag(args, "--filename") || slugify(prompt) || `image-${Date.now()}`;

  const Replicate = replicateRequire("replicate").default;
  const replicate = new Replicate();

  console.log(`generating image with ${model}...`);
  const output = await replicate.run(model, { input: { prompt } });

  const imagesDir = join(getHomePath(), "images");
  mkdirSync(imagesDir, { recursive: true });

  const filePath = join(imagesDir, `${filename}.png`);
  await writeFile(filePath, output[0]);
  console.log(`saved: ${filePath}`);
}

async function models(args: string[]): Promise<void> {
  const query = args[0];
  if (!query) {
    console.log('Usage: imagegen models "query"');
    process.exit(1);
  }

  if (!process.env.REPLICATE_API_TOKEN) {
    console.error(
      "REPLICATE_API_TOKEN not set. Run: volute env set REPLICATE_API_TOKEN <your-token>",
    );
    process.exit(1);
  }

  const Replicate = replicateRequire("replicate").default;
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

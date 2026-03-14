import { execFileSync } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

// Match the project's engines requirement
const NODE_VERSION = "24.2.0";
const ARCH = "arm64";
const PLATFORM = "darwin";

const cacheDir = resolve(import.meta.dirname, "..", ".cache");
const resourcesDir = resolve(import.meta.dirname, "..", "resources");
const binDir = resolve(resourcesDir, "bin");

const tarballName = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz`;
const tarballUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${tarballName}`;
const cachedTarball = resolve(cacheDir, tarballName);

async function downloadNode() {
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const nodeBin = resolve(binDir, "node");
  if (existsSync(nodeBin)) {
    console.log("Node binary already exists, skipping download");
    return;
  }

  // Download tarball if not cached
  if (!existsSync(cachedTarball)) {
    console.log(`Downloading Node.js v${NODE_VERSION} for ${PLATFORM}-${ARCH}...`);
    const res = await fetch(tarballUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download: ${res.status} ${res.statusText}`);
    }
    const fileStream = createWriteStream(cachedTarball);
    // @ts-expect-error — ReadableStream to NodeJS stream
    await pipeline(res.body as any, fileStream);
    console.log("Download complete");
  } else {
    console.log("Using cached tarball");
  }

  // Extract just the node binary
  console.log("Extracting node binary...");
  const prefix = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}`;
  execFileSync("tar", [
    "xzf",
    cachedTarball,
    "-C",
    binDir,
    "--strip-components=2",
    `${prefix}/bin/node`,
  ]);
  chmodSync(nodeBin, 0o755);
  console.log(`Extracted: ${nodeBin}`);

  // Create volute wrapper script
  const voluteWrapper = resolve(binDir, "volute");
  writeFileSync(
    voluteWrapper,
    `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/node" "$(dirname "$DIR")/dist/cli.js" "$@"
`,
    { mode: 0o755 },
  );
  console.log(`Created: ${voluteWrapper}`);

  // Create tsx wrapper script
  const tsxWrapper = resolve(binDir, "tsx");
  writeFileSync(
    tsxWrapper,
    `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$DIR/node" "$(dirname "$DIR")/node_modules/.bin/tsx" "$@"
`,
    { mode: 0o755 },
  );
  console.log(`Created: ${tsxWrapper}`);
}

downloadNode().catch((err) => {
  console.error("Failed to download Node:", err);
  process.exit(1);
});

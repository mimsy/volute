import { execFileSync } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

// Match the project's engines requirement
const NODE_VERSION = "24.2.0";
const RIPGREP_VERSION = "14.1.1";
const ARCH = process.arch === "x64" ? "x64" : "arm64";
const PLATFORM = process.platform;

const cacheDir = resolve(import.meta.dirname, "..", ".cache");
const resourcesDir = resolve(import.meta.dirname, "..", "resources");
const binDir = resolve(resourcesDir, "bin");

const nodeTarballName = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}.tar.gz`;
const nodeTarballUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${nodeTarballName}`;
const cachedNodeTarball = resolve(cacheDir, nodeTarballName);

// Ripgrep uses different arch names
const rgArch = ARCH === "arm64" ? "aarch64" : "x86_64";
const rgPlatform = PLATFORM === "darwin" ? "apple-darwin" : "unknown-linux-musl";
const rgTarballName = `ripgrep-${RIPGREP_VERSION}-${rgArch}-${rgPlatform}.tar.gz`;
const rgTarballUrl = `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${rgTarballName}`;
const cachedRgTarball = resolve(cacheDir, rgTarballName);

async function downloadAndExtract(
  name: string,
  url: string,
  cachedPath: string,
  extractArgs: string[],
) {
  if (!existsSync(cachedPath)) {
    console.log(`Downloading ${name}...`);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download ${name}: ${res.status} ${res.statusText}`);
    }
    const tmpPath = cachedPath + ".tmp";
    const fileStream = createWriteStream(tmpPath);
    await pipeline(res.body as any, fileStream);
    renameSync(tmpPath, cachedPath);
    console.log(`${name} download complete`);
  } else {
    console.log(`Using cached ${name} tarball`);
  }

  execFileSync("tar", ["xzf", cachedPath, "-C", binDir, ...extractArgs]);
}

async function downloadBinaries() {
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Download Node.js
  const nodeBin = resolve(binDir, "node");
  if (existsSync(nodeBin)) {
    console.log("Node binary already exists, skipping download");
  } else {
    const prefix = `node-v${NODE_VERSION}-${PLATFORM}-${ARCH}`;
    await downloadAndExtract(
      `Node.js v${NODE_VERSION} for ${PLATFORM}-${ARCH}`,
      nodeTarballUrl,
      cachedNodeTarball,
      ["--strip-components=2", `${prefix}/bin/node`],
    );
    chmodSync(nodeBin, 0o755);
    console.log(`Extracted: ${nodeBin}`);
  }

  // Download ripgrep (only on platforms with sandbox support)
  const rgBin = resolve(binDir, "rg");
  if (PLATFORM !== "darwin" && PLATFORM !== "linux") {
    console.log(`Skipping ripgrep download: unsupported platform ${PLATFORM}`);
  } else if (existsSync(rgBin)) {
    console.log("ripgrep binary already exists, skipping download");
  } else {
    const rgPrefix = `ripgrep-${RIPGREP_VERSION}-${rgArch}-${rgPlatform}`;
    await downloadAndExtract(
      `ripgrep v${RIPGREP_VERSION} for ${PLATFORM}-${ARCH}`,
      rgTarballUrl,
      cachedRgTarball,
      ["--strip-components=1", `${rgPrefix}/rg`],
    );
    if (!existsSync(rgBin)) {
      throw new Error(
        `ripgrep binary not found at ${rgBin} after extraction — tarball structure may have changed`,
      );
    }
    chmodSync(rgBin, 0o755);
    console.log(`Extracted: ${rgBin}`);
  }

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

downloadBinaries().catch((err) => {
  console.error("Failed to download binaries:", err);
  process.exit(1);
});

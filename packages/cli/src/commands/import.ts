import { closeSync, existsSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "../lib/parse-args.js";

// Re-export utility functions from daemon for backwards compat
export {
  findOpenClawSession,
  importOpenClawConnectors,
  importPiSession,
  parseNameFromIdentity,
  sessionMatchesWorkspace,
} from "@volute/daemon/lib/import-utils.js";

export async function run(args: string[]) {
  const { positional, flags } = parseArgs(args, {
    name: { type: "string" },
    session: { type: "string" },
    template: { type: "string" },
  });

  const inputPath = positional[0];

  // Detect .volute archive vs OpenClaw workspace
  if (inputPath && (inputPath.endsWith(".volute") || isZipFile(inputPath))) {
    await importArchive(resolve(inputPath), flags.name);
    return;
  }

  const wsDir = resolveWorkspace(inputPath);

  const { daemonFetch } = await import("../lib/daemon-client.js");
  const { getClient, urlOf } = await import("../lib/api-client.js");
  const client = getClient();

  const res = await daemonFetch(urlOf((client.api.minds as any).import.$url()), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspacePath: wsDir,
      name: flags.name,
      template: flags.template,
      sessionPath: flags.session,
    }),
  });

  const data = (await res.json()) as {
    ok?: boolean;
    error?: string;
    name?: string;
    port?: number;
    message?: string;
  };

  if (!res.ok) {
    console.error(data.error ?? "Failed to import mind");
    process.exit(1);
  }

  console.log(`\n${data.message ?? `Imported mind: ${data.name} (port ${data.port})`}`);
  console.log(`\n  volute mind start ${data.name}`);
}

/** Check if a file starts with the PK zip magic bytes. */
function isZipFile(path: string): boolean {
  const resolved = resolve(path);
  if (!existsSync(resolved)) return false;
  const fd = openSync(resolved, "r");
  try {
    const buf = Buffer.alloc(4);
    const bytesRead = readSync(fd, buf, 0, 4, 0);
    return (
      bytesRead === 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
    );
  } finally {
    closeSync(fd);
  }
}

/** Import a .volute archive via the daemon. */
async function importArchive(archivePath: string, nameOverride?: string): Promise<void> {
  if (!existsSync(archivePath)) {
    console.error(`File not found: ${archivePath}`);
    process.exit(1);
  }

  const { extractArchive } = await import("@volute/daemon/lib/archive.js");

  // Extract to temp dir
  const tempDir = resolve(tmpdir(), `volute-import-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  let extracted: Awaited<ReturnType<typeof extractArchive>>;
  try {
    extracted = extractArchive(archivePath, tempDir);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    console.error(`Failed to extract archive: ${(err as Error).message}`);
    process.exit(1);
  }

  try {
    const { daemonFetch } = await import("../lib/daemon-client.js");
    const { getClient, urlOf } = await import("../lib/api-client.js");
    const client = getClient();

    const res = await daemonFetch(urlOf((client.api.minds as any).import.$url()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        archivePath: tempDir,
        name: nameOverride,
        manifest: extracted.manifest,
      }),
    });

    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      name?: string;
      port?: number;
      message?: string;
    };

    if (!res.ok) {
      console.error(data.error ?? "Failed to import mind");
      process.exit(1);
    }

    console.log(`\n${data.message ?? `Imported mind: ${data.name} (port ${data.port})`}`);
    console.log(`\n  volute mind start ${data.name}`);
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

/** Auto-detect OpenClaw workspace: explicit path > cwd > ~/.openclaw/workspace */
function resolveWorkspace(explicitPath?: string): string {
  if (explicitPath) {
    const wsDir = resolve(explicitPath);
    if (!existsSync(resolve(wsDir, "SOUL.md")) || !existsSync(resolve(wsDir, "IDENTITY.md"))) {
      console.error("Not a valid OpenClaw workspace: missing SOUL.md or IDENTITY.md");
      process.exit(1);
    }
    return wsDir;
  }

  // Try cwd
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "SOUL.md")) && existsSync(resolve(cwd, "IDENTITY.md"))) {
    console.log(`Using workspace: ${cwd}`);
    return cwd;
  }

  // Try ~/.openclaw/workspace
  const openclawWs = resolve(homedir(), ".openclaw/workspace");
  if (
    existsSync(resolve(openclawWs, "SOUL.md")) &&
    existsSync(resolve(openclawWs, "IDENTITY.md"))
  ) {
    console.log(`Using workspace: ${openclawWs}`);
    return openclawWs;
  }

  console.error(
    "Usage: volute mind import [<workspace-path>] [--name <name>] [--session <path>] [--template <name>]\n\n" +
      "No OpenClaw workspace found. Provide a path, run from a workspace, or ensure ~/.openclaw/workspace exists.",
  );
  process.exit(1);
}

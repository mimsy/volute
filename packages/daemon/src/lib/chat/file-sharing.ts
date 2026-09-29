import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { mindFileOwner } from "../mind/isolation.js";
import { type MindFileOwner, writeMindFile } from "../mind/mind-file-write.js";
import { getBaseName, stateDir } from "../mind/registry.js";
import log from "../util/logger.js";

const flog = log.child("file-sharing");

// --- Types ---

export type PendingFileMetadata = {
  id: string;
  sender: string;
  filename: string;
  originalPath: string;
  size: number;
  createdAt: string;
};

// --- Path safety ---

export function validateFilePath(filePath: string): string | null {
  if (!filePath) return "File path is required";
  const normalized = normalize(filePath);
  if (normalized.startsWith("/") || normalized.startsWith("\\")) {
    return "Absolute paths are not allowed";
  }
  if (normalized.includes("..")) {
    return "Path traversal (..) is not allowed";
  }
  return null;
}

// --- Pending files staging ---

function pendingDir(receiver: string): string {
  return resolve(stateDir(receiver), "pending-files");
}

function validateId(id: string): void {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error("Invalid pending file id");
  }
}

function generateId(sender: string): string {
  const ts = Date.now();
  const rand = randomBytes(2).toString("hex");
  return `${sender}-${ts}-${rand}`;
}

export function stageFile(
  receiver: string,
  sender: string,
  filename: string,
  content: Buffer,
  originalPath: string,
): { id: string } {
  const err = validateFilePath(filename);
  if (err) throw new Error(err);

  if (sender.includes("/") || sender.includes("\\")) {
    throw new Error("Invalid sender name");
  }

  const id = generateId(sender);
  const dir = resolve(pendingDir(receiver), id);
  mkdirSync(dir, { recursive: true });

  const metadata: PendingFileMetadata = {
    id,
    sender,
    filename: basename(filename),
    originalPath,
    size: content.length,
    createdAt: new Date().toISOString(),
  };

  writeFileSync(resolve(dir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(resolve(dir, "data"), content);

  return { id };
}

export function listPending(receiver: string): PendingFileMetadata[] {
  const dir = pendingDir(receiver);
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir, { withFileTypes: true });
  const result: PendingFileMetadata[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = resolve(dir, entry.name, "metadata.json");
    if (!existsSync(metaPath)) continue;
    try {
      result.push(JSON.parse(readFileSync(metaPath, "utf-8")) as PendingFileMetadata);
    } catch (err) {
      flog.warn(`skipping malformed pending entry ${entry.name}`, log.errorData(err));
    }
  }

  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getPending(receiver: string, id: string): PendingFileMetadata | null {
  validateId(id);
  const metaPath = resolve(pendingDir(receiver), id, "metadata.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as PendingFileMetadata;
  } catch (err) {
    flog.warn(`failed to read pending metadata for ${id}`, log.errorData(err));
    return null;
  }
}

// --- Delivery ---

/**
 * Write a delivered file into the receiver's `home/<inbox>/<sender>/`. The receiver owns
 * that tree and the daemon may be root, so the write goes through {@link writeMindFile}:
 * a link or FIFO the receiver planted on the way refuses, and what is created is handed
 * to `owner` (the receiver's user, null without isolation). A same-named file is replaced.
 */
export async function deliverFile(
  receiverDir: string,
  sender: string,
  filename: string,
  content: Buffer,
  inboxPath: string | undefined,
  owner: MindFileOwner | null,
): Promise<string> {
  const err = validateFilePath(filename);
  if (err) throw new Error(err);

  const inbox = inboxPath ?? "inbox";
  const inboxErr = validateFilePath(inbox);
  if (inboxErr) throw new Error(`Invalid inboxPath: ${inboxErr}`);

  // Validate sender has no path separators (defense-in-depth)
  if (sender.includes("/") || sender.includes("\\")) {
    throw new Error("Invalid sender name");
  }

  const rel = join(inbox, sender, basename(filename));
  await writeMindFile(receiverDir, join("home", rel), content, { owner });
  return rel;
}

// --- Accept / Reject ---

export async function acceptPending(
  receiver: string,
  id: string,
  receiverDir: string,
  dest?: string,
): Promise<{ sender: string; filename: string; destPath: string }> {
  const meta = getPending(receiver, id);
  if (!meta) throw new Error(`Pending file not found: ${id}`);

  const dataPath = resolve(pendingDir(receiver), id, "data");
  const content = readFileSync(dataPath);

  const inboxPath = dest ?? "inbox";
  const owner = await mindFileOwner(await getBaseName(receiver));
  const destPath = await deliverFile(
    receiverDir,
    meta.sender,
    meta.filename,
    content,
    inboxPath,
    owner,
  );

  // Clean up staging
  rmSync(resolve(pendingDir(receiver), id), { recursive: true });

  return { sender: meta.sender, filename: meta.filename, destPath };
}

export function rejectPending(receiver: string, id: string): { sender: string; filename: string } {
  const meta = getPending(receiver, id);
  if (!meta) throw new Error(`Pending file not found: ${id}`);

  // Clean up staging
  rmSync(resolve(pendingDir(receiver), id), { recursive: true });

  return { sender: meta.sender, filename: meta.filename };
}

// --- Helpers for API layer ---

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

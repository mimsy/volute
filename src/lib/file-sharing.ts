import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import { stateDir } from "./registry.js";

// --- Types ---

export type FileSharingConfig = {
  trustedSenders?: string[];
  inboxPath?: string;
};

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

// --- Config ---

function configPath(dir: string): string {
  return resolve(dir, "home", ".config", "file-sharing.json");
}

export function readFileSharingConfig(dir: string): FileSharingConfig {
  const p = configPath(dir);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as FileSharingConfig;
  } catch (err) {
    console.warn(`[file-sharing] failed to parse config at ${p}:`, err);
    return {};
  }
}

export function writeFileSharingConfig(dir: string, config: FileSharingConfig): void {
  const p = configPath(dir);
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`);
}

// --- Trust ---

export function isTrustedSender(dir: string, sender: string): boolean {
  const config = readFileSharingConfig(dir);
  return config.trustedSenders?.includes(sender) ?? false;
}

export function addTrust(dir: string, sender: string): void {
  const config = readFileSharingConfig(dir);
  const trusted = config.trustedSenders ?? [];
  if (!trusted.includes(sender)) {
    trusted.push(sender);
  }
  config.trustedSenders = trusted;
  writeFileSharingConfig(dir, config);
}

export function removeTrust(dir: string, sender: string): void {
  const config = readFileSharingConfig(dir);
  const trusted = config.trustedSenders ?? [];
  config.trustedSenders = trusted.filter((s) => s !== sender);
  writeFileSharingConfig(dir, config);
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
      console.warn(`[file-sharing] skipping malformed pending entry ${entry.name}:`, err);
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
    console.warn(`[file-sharing] failed to read pending metadata for ${id}:`, err);
    return null;
  }
}

// --- Delivery ---

export function deliverFile(
  receiverDir: string,
  sender: string,
  filename: string,
  content: Buffer,
  inboxPath?: string,
): string {
  const err = validateFilePath(filename);
  if (err) throw new Error(err);

  const inbox = inboxPath ?? "inbox";
  const inboxErr = validateFilePath(inbox);
  if (inboxErr) throw new Error(`Invalid inboxPath: ${inboxErr}`);

  // Validate sender has no path separators (defense-in-depth)
  if (sender.includes("/") || sender.includes("\\")) {
    throw new Error("Invalid sender name");
  }

  const destDir = resolve(receiverDir, "home", inbox, sender);
  mkdirSync(destDir, { recursive: true });

  const destPath = resolve(destDir, basename(filename));
  writeFileSync(destPath, content);

  return join(inbox, sender, basename(filename));
}

// --- Accept / Reject ---

export function acceptPending(
  receiver: string,
  id: string,
  receiverDir: string,
): { sender: string; filename: string; destPath: string } {
  const meta = getPending(receiver, id);
  if (!meta) throw new Error(`Pending file not found: ${id}`);

  const dataPath = resolve(pendingDir(receiver), id, "data");
  const content = readFileSync(dataPath);

  const config = readFileSharingConfig(receiverDir);
  const inboxPath = config.inboxPath ?? "inbox";
  const destPath = deliverFile(receiverDir, meta.sender, meta.filename, content, inboxPath);

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

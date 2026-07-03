import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mindDir, readAllMinds, voluteHome } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "./logger.js";
import { safeResolveWithinBase } from "./paths.js";

const alog = log.child("avatar-image");

/** Max avatar dimension — covers the largest display size (96px) at retina density. */
export const AVATAR_DIM = 256;

async function loadSharp(): Promise<any | null> {
  try {
    const mod = await import("sharp");
    return mod.default ?? mod;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      alog.debug("sharp not available, keeping original avatars");
    } else {
      alog.warn("sharp import failed, keeping original avatars", log.errorData(err));
    }
    return null;
  }
}

/**
 * Downscale an uploaded avatar to AVATAR_DIM and re-encode as webp.
 * Returns null when sharp is unavailable or processing fails — the caller
 * should fall back to storing the original bytes.
 */
export async function normalizeAvatar(
  buffer: Buffer,
): Promise<{ buffer: Buffer; ext: ".webp"; mime: "image/webp" } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    const out = await sharp(buffer, { animated: true })
      .resize(AVATAR_DIM, AVATAR_DIM, { fit: "cover", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return { buffer: out, ext: ".webp", mime: "image/webp" };
  } catch (err) {
    alog.warn("avatar normalize failed, keeping original", log.errorData(err));
    return null;
  }
}

/** Re-encode a single avatar file in place (same format) if it exceeds AVATAR_DIM. */
async function downscaleFile(sharp: any, filePath: string): Promise<boolean> {
  const data = await readFile(filePath);
  const image = sharp(data, { animated: true });
  const meta = await image.metadata();
  if (!meta.format || ((meta.width ?? 0) <= AVATAR_DIM && (meta.height ?? 0) <= AVATAR_DIM)) {
    return false;
  }
  const out = await image
    .resize(AVATAR_DIM, AVATAR_DIM, { fit: "cover" })
    .toFormat(meta.format)
    .toBuffer();
  await writeFile(filePath, out);
  return true;
}

/**
 * One-time daemon-startup migration: downscale oversized avatars uploaded
 * before resize-on-upload existed. Re-encodes in place, preserving format and
 * filename so no DB or volute.json references change. Idempotent.
 */
export async function migrateAvatarSizes(): Promise<void> {
  const sharp = await loadSharp();
  if (!sharp) return;

  const userAvatarsDir = resolve(voluteHome(), "avatars");
  let userAvatars: string[] = [];
  try {
    userAvatars = (await readdir(userAvatarsDir)).map((f) => resolve(userAvatarsDir, f));
  } catch {
    // no avatars dir yet
  }

  const mindAvatars: string[] = [];
  try {
    for (const mind of await readAllMinds()) {
      const dir = mind.dir ?? mindDir(mind.name);
      const avatar = readVoluteConfig(dir)?.profile?.avatar;
      if (!avatar) continue;
      const path = safeResolveWithinBase(resolve(dir, "home"), avatar);
      if (path) mindAvatars.push(path);
    }
  } catch (err) {
    alog.warn("failed to enumerate mind avatars for migration", log.errorData(err));
  }

  for (const filePath of [...userAvatars, ...mindAvatars]) {
    try {
      if (await downscaleFile(sharp, filePath)) {
        alog.info(`downscaled oversized avatar ${filePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        alog.warn(`failed to downscale avatar ${filePath}`, log.errorData(err));
      }
    }
  }
}

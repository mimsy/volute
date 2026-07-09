import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { mindDir, readAllMinds, voluteHome } from "../mind/registry.js";
import { readVoluteConfig } from "../mind/volute-config.js";
import log from "./logger.js";
import { safeResolveWithinBase } from "./paths.js";

const alog = log.child("avatar-image");

/** Max avatar dimension — covers the largest display size (96px) at retina density. */
export const AVATAR_DIM = 256;

/** Max avatar dimension for images inlined into a mind's context. */
export const AVATAR_CONTEXT_DIM = 128;

/**
 * Hard ceiling on the base64 size of an avatar image block. A correctly resized
 * 128×128 avatar is a few KB; anything above this means the resize regressed or
 * was skipped, and we refuse to inline it into every participant mind's context.
 */
export const MAX_AVATAR_BLOCK_BYTES = 64 * 1024;

export type AvatarBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// Fire the "sharp missing" warning once per process rather than per avatar.
let warnedSharpMissing = false;

async function loadSharp(): Promise<any | null> {
  try {
    const mod = await import("sharp");
    return mod.default ?? mod;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      if (!warnedSharpMissing) {
        warnedSharpMissing = true;
        alog.warn(
          "sharp is not installed — avatars will not be downscaled or inlined into mind context. Install the 'sharp' dependency to restore avatar image support.",
        );
      }
    } else {
      alog.warn("sharp import failed, avatar image support disabled", log.errorData(err));
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

/**
 * Read an avatar file and render it as a `[text, image]` block pair for inlining
 * into a mind's context, resized to AVATAR_CONTEXT_DIM.
 *
 * Returns null (omitting the avatar entirely) when the format is unsupported,
 * sharp is unavailable, or the resized block would still exceed
 * MAX_AVATAR_BLOCK_BYTES. Inlining an unbounded image into every participant's
 * context is strictly worse than showing no avatar, so we drop the pair rather
 * than fall back to the original bytes. File-read errors propagate to the caller.
 */
export async function renderAvatarBlock(
  filePath: string,
  label: string,
): Promise<AvatarBlock[] | null> {
  const ext = extname(filePath).toLowerCase();
  const mediaType = MIME_BY_EXT[ext];
  if (!mediaType) return null;

  const sharp = await loadSharp();
  if (!sharp) return null;

  const data = await readFile(filePath);
  let imageData: Buffer;
  try {
    imageData = await sharp(data, { animated: true })
      .resize(AVATAR_CONTEXT_DIM, AVATAR_CONTEXT_DIM, { fit: "cover" })
      .toBuffer();
  } catch (err) {
    alog.warn(`avatar resize failed for ${label}, omitting image`, log.errorData(err));
    return null;
  }

  const base64 = imageData.toString("base64");
  if (base64.length > MAX_AVATAR_BLOCK_BYTES) {
    alog.warn(
      `avatar for ${label} is ${base64.length} bytes after resize (> ${MAX_AVATAR_BLOCK_BYTES}), omitting image`,
    );
    return null;
  }

  return [
    { type: "text", text: `[Avatar for ${label}]` },
    { type: "image", media_type: mediaType, data: base64 },
  ];
}

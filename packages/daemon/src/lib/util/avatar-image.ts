import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { mindFileOwner } from "../mind/isolation.js";
import { readMindFileBytes, writeMindFile } from "../mind/mind-file-write.js";
import { findMind, getBaseName, mindDir, readAllMinds, voluteHome } from "../mind/registry.js";
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

// Fire the "sharp unavailable" warning once per process rather than per avatar —
// loadSharp() runs once per participant per delivery, so an unusable install
// (missing package or broken native binary) would otherwise spam every message.
let warnedSharpUnavailable = false;

async function loadSharp(): Promise<any | null> {
  try {
    const mod = await import("sharp");
    return mod.default ?? mod;
  } catch (err) {
    if (!warnedSharpUnavailable) {
      warnedSharpUnavailable = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
        alog.warn(
          "sharp is not installed — avatars will not be downscaled or inlined into mind context. Install the 'sharp' dependency to restore avatar image support.",
        );
      } else {
        alog.warn("sharp import failed, avatar image support disabled", log.errorData(err));
      }
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

/** Downscaled bytes (same format) for an avatar that exceeds AVATAR_DIM, else null. */
async function downscaled(sharp: any, data: Buffer): Promise<Buffer | null> {
  const image = sharp(data, { animated: true });
  const meta = await image.metadata();
  if (!meta.format || ((meta.width ?? 0) <= AVATAR_DIM && (meta.height ?? 0) <= AVATAR_DIM)) {
    return null;
  }
  return image.resize(AVATAR_DIM, AVATAR_DIM, { fit: "cover" }).toFormat(meta.format).toBuffer();
}

/** Largest pre-resize avatar the daemon will read back from a mind. */
const MAX_AVATAR_READ_BYTES = 16 * 1024 * 1024;

/**
 * One-time daemon-startup migration: downscale oversized avatars uploaded
 * before resize-on-upload existed. Re-encodes in place, preserving format and
 * filename so no DB or volute.json references change. Idempotent.
 *
 * A mind's avatar lives in a tree the mind owns, and the daemon may be root: it is
 * read and rewritten through the mind-file helpers, so a link, hard link or FIFO
 * planted there refuses instead of aiming the rewrite elsewhere.
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
  for (const filePath of userAvatars) {
    try {
      const out = await downscaled(sharp, await readFile(filePath));
      if (out) {
        await writeFile(filePath, out);
        alog.info(`downscaled oversized avatar ${filePath}`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        alog.warn(`failed to downscale avatar ${filePath}`, log.errorData(err));
      }
    }
  }

  let minds: Awaited<ReturnType<typeof readAllMinds>> = [];
  try {
    minds = await readAllMinds();
  } catch (err) {
    alog.warn("failed to enumerate mind avatars for migration", log.errorData(err));
  }
  for (const mind of minds) {
    const dir = mind.dir ?? mindDir(mind.name);
    const avatar = readVoluteConfig(dir)?.profile?.avatar;
    const avatarPath = avatar && safeResolveWithinBase(resolve(dir, "home"), avatar);
    if (!avatarPath) continue;
    const rel = relative(dir, avatarPath);
    try {
      const owner = await mindFileOwner(await getBaseName(mind.name));
      const data = await readMindFileBytes(dir, rel, {
        owner,
        maxBytes: MAX_AVATAR_READ_BYTES,
      });
      const out = data && (await downscaled(sharp, data));
      if (out && (await writeMindFile(dir, rel, out, { owner, create: false }))) {
        alog.info(`downscaled oversized avatar ${resolve(dir, rel)}`);
      }
    } catch (err) {
      alog.warn(`failed to downscale avatar ${resolve(dir, rel)}`, log.errorData(err));
    }
  }
}

/**
 * Read a mind's avatar (the `profile.avatar` its volute.json names) through the
 * mind-file helpers: the mind owns that tree and the daemon may be root, so a link,
 * hard link or FIFO it planted refuses (throws) rather than redirecting or hanging the
 * read. Null when no avatar is configured, it names a path outside home/, the file is
 * absent, or it could not be rendered anyway (an unsupported format, no sharp).
 */
export async function readMindAvatar(name: string): Promise<{ path: string; data: Buffer } | null> {
  // The registry's dir, not mindDir(): the spirit lives outside the minds dir.
  const dir = (await findMind(name))?.dir ?? mindDir(name);
  const avatar = readVoluteConfig(dir)?.profile?.avatar;
  const avatarPath = avatar && safeResolveWithinBase(resolve(dir, "home"), avatar);
  if (!avatarPath) return null;
  // Nothing renderAvatarBlock would drop unread is worth reading.
  if (!MIME_BY_EXT[extname(avatarPath).toLowerCase()] || !(await loadSharp())) return null;
  const data = await readMindFileBytes(dir, relative(dir, avatarPath), {
    owner: await mindFileOwner(await getBaseName(name)),
    maxBytes: MAX_AVATAR_READ_BYTES,
  });
  return data && { path: avatarPath, data };
}

/**
 * Render an avatar image as a `[text, image]` block pair for inlining into a mind's
 * context, resized to AVATAR_CONTEXT_DIM. `filePath` names the format by its extension.
 *
 * Returns null (omitting the avatar entirely) when the format is unsupported,
 * sharp is unavailable, or the resized block would still exceed
 * MAX_AVATAR_BLOCK_BYTES. Inlining an unbounded image into every participant's
 * context is strictly worse than showing no avatar, so we drop the pair rather
 * than fall back to the original bytes.
 */
export async function renderAvatarBlock(
  filePath: string,
  data: Buffer,
  label: string,
): Promise<AvatarBlock[] | null> {
  const ext = extname(filePath).toLowerCase();
  const mediaType = MIME_BY_EXT[ext];
  if (!mediaType) return null;

  const sharp = await loadSharp();
  if (!sharp) return null;

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
    // Says what the image is on its own: the Claude CLI follows inlined images with a bare
    // `[Image: source: <path>]` line, which minds read as an attachment unless this does.
    {
      type: "text",
      text: `[${label}'s profile picture — shown when you first meet them in a thread, not something they sent]`,
    },
    { type: "image", media_type: mediaType, data: base64 },
  ];
}

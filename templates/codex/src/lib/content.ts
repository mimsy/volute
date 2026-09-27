import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { warn } from "./logger.js";
import type { VoluteContentPart } from "./types.js";

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    warn(
      "mind",
      `extractText received unexpected ${typeof content} instead of VoluteContentPart[]`,
    );
    return JSON.stringify(content);
  }
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export type ImagePart = Extract<VoluteContentPart, { type: "image" }>;

export function extractImages(content: unknown): ImagePart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((p): p is ImagePart => p?.type === "image");
}

/** The formats codex accepts as `local_image` input, and the extension each is written with. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Write each image to its own file under `dir`, for codex's `local_image` input — the SDK
 * takes images only as paths (`codex exec --image`), not inline base64. Returns the paths
 * written and how many images couldn't be (an unsupported format or a failed write), so
 * the caller can tell the mind an image was there rather than dropping it without a word.
 * The caller deletes the files once the turn that read them is over.
 */
export function writeImages(images: ImagePart[], dir: string): { paths: string[]; failed: number } {
  const paths: string[] = [];
  let failed = 0;
  for (const image of images) {
    const ext = EXTENSIONS[image.media_type];
    if (!ext) {
      failed++;
      continue;
    }
    try {
      mkdirSync(dir, { recursive: true });
      const path = resolve(dir, `${randomUUID()}.${ext}`);
      writeFileSync(path, Buffer.from(image.data, "base64"));
      paths.push(path);
    } catch (err) {
      warn("mind", "failed to write an image for codex:", err);
      failed++;
    }
  }
  return { paths, failed };
}

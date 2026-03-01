import type { ImageContent } from "@mariozechner/pi-ai";
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

export function extractImages(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) {
    warn(
      "mind",
      `extractImages received non-array content (${typeof content}) — images cannot be extracted`,
    );
    return [];
  }
  return content
    .filter((p): p is { type: "image"; media_type: string; data: string } => p.type === "image")
    .map((p) => ({ type: "image" as const, mimeType: p.media_type, data: p.data }));
}

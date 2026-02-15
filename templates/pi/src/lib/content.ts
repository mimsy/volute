import type { ImageContent } from "@mariozechner/pi-ai";
import type { VoluteContentPart } from "./types.js";

export function extractText(content: VoluteContentPart[]): string {
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

export function extractImages(content: VoluteContentPart[]): ImageContent[] {
  return content
    .filter((p): p is { type: "image"; media_type: string; data: string } => p.type === "image")
    .map((p) => ({ type: "image" as const, mimeType: p.media_type, data: p.data }));
}

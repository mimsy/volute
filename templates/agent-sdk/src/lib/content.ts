import type { VoluteContentPart } from "./types.js";

export type SDKContent = (
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    }
)[];

type SupportedMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const SUPPORTED_MEDIA_TYPES: Set<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export function toSDKContent(content: VoluteContentPart[]): SDKContent {
  return content
    .map((part) => {
      if (part.type === "text") {
        return { type: "text" as const, text: part.text };
      }
      if (!SUPPORTED_MEDIA_TYPES.has(part.media_type)) return null;
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: part.media_type as SupportedMediaType,
          data: part.data,
        },
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

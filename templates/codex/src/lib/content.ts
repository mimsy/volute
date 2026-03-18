import { warn } from "./logger.js";

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

import type { TurnActivity } from "@volute/api";

/**
 * Stable key for a collapsed-turn peek popover, used to track which popovers
 * have been revealed (hovered) so their content is mounted lazily.
 */
export function peekKey(
  kind: "chat" | "activity" | "system-event",
  turnId: string,
  itemId: string | number,
): string {
  return `${kind}:${turnId}:${itemId}`;
}

export type ActivityPeekBody =
  | { kind: "iframe"; url: string }
  | { kind: "markdown"; source: string }
  | { kind: "none" };

/**
 * Decide what an activity peek popover should render. Pure — the caller only
 * renders markdown / mounts the iframe when the popover is actually revealed.
 */
export function activityPeekBody(metadata: TurnActivity["metadata"]): ActivityPeekBody {
  const iframeUrl = typeof metadata?.iframeUrl === "string" ? metadata.iframeUrl : "";
  if (iframeUrl) return { kind: "iframe", url: iframeUrl };
  const bodyHtml = typeof metadata?.bodyHtml === "string" ? metadata.bodyHtml : "";
  if (bodyHtml) return { kind: "markdown", source: bodyHtml };
  return { kind: "none" };
}

/** Navigation target for an activity: the document's SPA route. */
export function activityNavUrl(metadata: TurnActivity["metadata"], fallbackMind: string): string {
  if (typeof metadata?.url === "string" && metadata.url) return metadata.url;
  // Rows written before extensions published metadata.url:
  const slug = typeof metadata?.slug === "string" ? metadata.slug : "";
  if (slug) {
    const author = typeof metadata?.author === "string" ? metadata.author : fallbackMind;
    return `/minds/${author}/notes/${slug}`;
  }
  const file = typeof metadata?.file === "string" ? metadata.file : "";
  if (file) return `/minds/${fallbackMind}/pages/${file}`;
  return "";
}

/** Accent color name for the activity peek button/card. */
export function activityColor(metadata: TurnActivity["metadata"]): string {
  return typeof metadata?.color === "string" ? metadata.color : "yellow";
}

/**
 * Whether a peek popover's content should be mounted. Content mounts on first
 * reveal and stays mounted (frozen) — hidden popovers render nothing (#541).
 */
export function shouldRenderPeek(revealed: ReadonlySet<string>, key: string): boolean {
  return revealed.has(key);
}

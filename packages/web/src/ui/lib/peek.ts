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

/** Navigation target for the activity peek button. */
export function activityNavUrl(metadata: TurnActivity["metadata"], fallbackMind: string): string {
  // A string iframeUrl always wins, even when empty (→ no navigation),
  // matching the original inline `typeof === "string"` precedence.
  if (typeof metadata?.iframeUrl === "string") return metadata.iframeUrl;
  const slug = typeof metadata?.slug === "string" ? metadata.slug : "";
  if (!slug) return "";
  const author = typeof metadata?.author === "string" ? metadata.author : fallbackMind;
  return `/minds/${author}/notes/${slug}`;
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
